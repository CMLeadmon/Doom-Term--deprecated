import type { TerminalScreen } from './terminalScreen';
import { parseSequence, parseStreamDescriptor, parseStreamRecord } from './streamProtocol';
import type { ResumeCursor, StreamDescriptor } from './streamProtocol';
import { StreamApplication } from './streamApplication';
import type { StreamObservers } from './streamApplication';
import { RecoveredArchive } from './recoveredArchive';
import type { ArchiveState } from './recoveredArchive';
import { parseGrid } from './terminalGeometry';

type AttachKind = 'resume' | 'replay-from-start' | 'rebuild';
type Refusal = 'missing' | 'closed' | 'replaced' | 'busy' | 'incompatible' | 'failed';
export interface AttachmentState {
  status: 'disconnected' | 'attaching' | 'catching-up' | 'awaiting-ready' | 'ready' | 'unreconstructable' | Refusal;
  descriptor: Readonly<StreamDescriptor> | null;
  reason: string | null;
  exitCode: number | null;
}
export interface AttachmentIdentity { session_id: string; incarnation: string }
export interface MutationIdentity { id: string; incarnation: string; attachment_id: string }

interface Options extends StreamObservers {
  send(action: string, payload: Record<string, unknown>): boolean;
  openScreen(descriptor: StreamDescriptor): TerminalScreen;
  /** Capture the old presentation before openScreen replaces its live parser. */
  beforeReconstruction?: (kind: Exclude<AttachKind, 'resume'>) => void;
  cachedHistoryBudget?: () => { bytes: number; lines: number };
  onState?: (state: Readonly<AttachmentState>) => void;
  onArchive?: (archive: Readonly<ArchiveState>) => void;
  /** The owning transport must close on a malformed or timed-out handshake. */
  onFailure?: (reason: string) => void;
}

const refusals = new Set<string>(['missing', 'closed', 'replaced', 'busy', 'incompatible', 'failed']);
function sameDescriptor(a: Readonly<StreamDescriptor>, b: Readonly<StreamDescriptor>): boolean {
  return JSON.stringify(a) === JSON.stringify(b); // Both have the canonical validated field order.
}

/** Socket ownership is short-lived; the parser survives a warm disconnect.
 * No raw input is stored here. Only the most recent desired size is retained. */
export class SessionAttachment {
  private current: Readonly<AttachmentState> = Object.freeze({ status: 'disconnected', descriptor: null, reason: null, exitCode: null });
  private application: StreamApplication | null = null;
  private archive: RecoveredArchive | null = null;
  private generation = 0;
  private connected = false;
  private disposed = false;
  private requestId: string | null = null;
  private attachmentId: string | null = null;
  private offered: StreamDescriptor | null = null;
  private kind: AttachKind | null = null;
  private requestedCursor: ResumeCursor | null = null;
  private cut: string | null = null;
  private caughtUp = false;
  private acknowledged = false;
  private receivedSequence = 0n;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private desiredSize: { cols: number; rows: number } | null = null;
  private sentSize: { cols: number; rows: number } | null = null;

  constructor(readonly identity: Readonly<AttachmentIdentity>, private options: Options) {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(identity.session_id) || !/^[0-9a-f]{32}$/.test(identity.incarnation)) throw new Error('Invalid attachment identity');
    this.identity = Object.freeze({ ...identity });
  }
  get state(): Readonly<AttachmentState> { return this.current; }
  get history(): Readonly<ArchiveState> | null { return this.archive?.state ?? null; }
  private update(patch: Partial<AttachmentState>): void {
    this.current = Object.freeze({ ...this.current, ...patch });
    this.options.onState?.(this.current);
  }
  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private fail(reason = 'Invalid attachment transition; reconnect is required'): void {
    if (!this.connected) return;
    this.clearTimer();
    this.connected = false;
    this.attachmentId = null;
    this.application?.dispose();
    this.application = null;
    this.archive?.disconnect();
    this.update({ status: 'failed', reason });
    this.options.onFailure?.(reason);
  }
  private send(action: string, payload: Record<string, unknown>): boolean {
    try {
      if (this.connected && this.options.send(action, payload)) return true;
    } catch { /* A thrown send is an unknown outcome, never a reason to replay. */ }
    this.fail('Connection failed; operation delivery is unknown');
    return false;
  }
  async attach(requestId: string): Promise<void> {
    if (this.disposed) throw new Error('Attachment is disposed');
    // An already admitted lease cannot be replaced on the same socket. The
    // transport must disconnect it first, releasing the daemon's controller.
    if (this.connected) throw new Error('Disconnect the existing attachment before attaching');
    if (!requestId || new TextEncoder().encode(requestId).length > 256) throw new Error('Invalid attach request id');
    const generation = ++this.generation;
    this.connected = true;
    this.requestId = requestId;
    this.attachmentId = null;
    this.offered = null;
    this.kind = null;
    this.cut = null;
    this.caughtUp = false;
    this.acknowledged = false;
    this.sentSize = null;
    this.requestedCursor = null;
    this.clearTimer();
    this.timer = setTimeout(() => this.fail('Attachment timed out; reconnect is required'), 15000);
    this.update({ status: 'attaching', reason: null, exitCode: null });
    const application = this.application;
    let cursor: ResumeCursor | null = null;
    if (application) {
      try { cursor = await application.resumeCursor(); }
      catch {
        if (this.application === application) { application.dispose(); this.application = null; }
      }
    }
    if (this.generation !== generation || !this.connected) return;
    this.requestedCursor = cursor;
    this.send('Attach', { request_id: requestId, id: this.identity.session_id,
      incarnation: this.identity.incarnation, resume: this.requestedCursor });
  }
  accept(event: string, value: unknown): boolean {
    if (!this.connected || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    if (event === 'AttachResult') {
      if (input.request_id !== this.requestId || input.session_id !== this.identity.session_id) return false;
    } else {
      if (!this.attachmentId || input.attachment_id !== this.attachmentId) return false;
      if (event !== 'StreamRecord' && (input.session_id !== this.identity.session_id || input.incarnation !== this.identity.incarnation)) return false;
    }
    try {
      if (event.startsWith('History')) {
        if (!this.archive || this.kind !== 'rebuild' || this.cut === null) throw new Error('Unexpected history');
        // History is a separate optional presentation. A refused/incomplete
        // archive must not corrupt the parser or deny otherwise valid output.
        try { return this.archive.accept(event, input); }
        catch { return true; }
        finally { this.options.onArchive?.(this.archive.state); }
      }
      if (event === 'AttachResult') return this.acceptResult(input);
      if (event === 'StreamBegin') return this.begin(input);
      if (event === 'StreamRecord') return this.record(input);
      if (event === 'StreamCaughtUp') return this.caughtUpAt(input);
      if (event === 'AttachmentReady') {
        if (!this.acknowledged || input.sequence !== this.cut) throw new Error('Unacknowledged readiness');
        // A close/fault may arrive before an already queued Ready reply.
        if (this.current.status === 'closed' || this.current.status === 'unreconstructable') return true;
        this.clearTimer();
        this.update({ status: 'ready' });
        this.flushSize();
        return true;
      }
      if (event === 'StreamUnavailable') {
        this.application?.dispose();
        this.application = null;
        this.clearTimer();
        this.update({ status: 'unreconstructable', reason: 'Stream continuity lost; cached snapshot retained' });
        return true;
      }
      return false;
    } catch { this.fail(); return true; }
  }
  private acceptResult(input: Record<string, unknown>): boolean {
    if (this.current.status !== 'attaching' || this.offered) throw new Error('Duplicate attach result');
    const outcome = input.outcome;
    if (typeof outcome === 'string' && refusals.has(outcome)) {
      if (input.attachment_id !== null || input.descriptor !== null) throw new Error('Refusal contains a lease');
      const code = input.exit_code;
      if (outcome === 'closed' && code !== null && (typeof code !== 'number' || !Number.isSafeInteger(code) || code < -2147483648 || code > 2147483647)) throw new Error('Invalid exit status');
      this.clearTimer();
      this.update({ status: outcome as Refusal, exitCode: outcome === 'closed' ? code as number | null : null });
      return true;
    }
    if (!['resume', 'replay-from-start', 'rebuild', 'unreconstructable'].includes(String(outcome))
        || typeof input.attachment_id !== 'string' || !/^[0-9a-f]{32}$/.test(input.attachment_id)) throw new Error('Invalid attach outcome');
    const descriptor = parseStreamDescriptor(input.descriptor);
    if (descriptor.session_id !== this.identity.session_id || descriptor.incarnation !== this.identity.incarnation) throw new Error('Different process');
    if (outcome === 'resume' && (!this.application || !this.requestedCursor || !sameDescriptor(this.application.descriptor, descriptor))) throw new Error('Missing warm parser');
    if (outcome === 'rebuild' && (!descriptor.durable || this.application?.descriptor.stream_epoch === descriptor.stream_epoch)) throw new Error('Rebuild requires a fresh durable stream');
    this.offered = descriptor;
    this.attachmentId = input.attachment_id;
    if (outcome === 'unreconstructable') {
      this.clearTimer();
      this.application?.dispose(); this.application = null;
      this.update({ status: 'unreconstructable', descriptor, reason: 'Live screen cannot be reconstructed; process remains owned' });
    } else { this.kind = outcome as AttachKind; }
    return true;
  }
  private begin(input: Record<string, unknown>): boolean {
    if (!this.offered || !this.kind || this.cut !== null || input.kind !== this.kind
        || !sameDescriptor(this.offered, parseStreamDescriptor(input.descriptor))) throw new Error('Invalid stream begin');
    const cut = parseSequence(input.cut);
    if (cut < parseSequence(this.requestedCursor?.after_sequence ?? '0') && this.kind === 'resume') throw new Error('Cut precedes requested cursor');
    if (this.kind !== 'resume') {
      this.options.beforeReconstruction?.(this.kind);
      const screen = this.options.openScreen(this.offered);
      this.application?.dispose();
      const application = new StreamApplication(this.offered, screen, {
        historyComplete: this.kind !== 'rebuild',
        onRecord: (record, context) => {
          if (this.application !== application) return;
          this.options.onRecord?.(record, context);
        },
        onActivity: (record, context) => {
          if (this.application === application && this.connected) this.options.onActivity?.(record, context);
        },
      });
      this.application = application;
    }
    if (!this.application) throw new Error('Missing parser');
    if (this.kind === 'rebuild') {
      this.archive?.disconnect();
      this.archive = new RecoveredArchive({ ...this.identity, attachment_id: this.attachmentId! }, this.options.cachedHistoryBudget?.());
      this.options.onArchive?.(this.archive.state);
    }
    this.cut = cut.toString();
    this.receivedSequence = this.kind === 'resume' ? parseSequence(this.requestedCursor!.after_sequence) : 0n;
    this.update({ status: 'catching-up', descriptor: this.offered });
    return true;
  }
  private record(input: Record<string, unknown>): boolean {
    if (this.cut === null || !this.application) throw new Error('Record before stream begin');
    const record = parseStreamRecord(input.record);
    const sequence = parseSequence(record.sequence);
    const phase = input.phase;
    if ((phase !== 'catch-up' && phase !== 'live') || phase !== (sequence <= parseSequence(this.cut) ? 'catch-up' : 'live')
        || (phase === 'live' && !this.caughtUp)) throw new Error('Record outside its captured phase');
    const application = this.application;
    const generation = this.generation;
    if (record.session_id !== this.identity.session_id || record.incarnation !== this.identity.incarnation
        || record.stream_epoch !== application.descriptor.stream_epoch) throw new Error('Record identity changed');
    const gap = sequence > this.receivedSequence + 1n;
    if (sequence === this.receivedSequence + 1n) this.receivedSequence = sequence;
    const ended = record.payload.type === 'Closed';
    const fault = record.payload.type === 'Fault' || (record.payload.type === 'Event' && record.payload.payload.type === 'StreamFault');
    if (ended || fault || gap) {
      this.clearTimer();
      this.update({ status: ended ? 'closed' : 'unreconstructable' });
    }
    void application.apply(record, phase).then(() => {
      if (this.generation !== generation || !this.connected || this.application !== application) return;
      if (record.payload.type === 'Closed') this.update({ status: 'closed', exitCode: record.payload.payload.exit_code });
    }, () => {
      if (this.generation !== generation || !this.connected || this.application !== application) return;
      this.clearTimer();
      application.dispose(); this.application = null;
      this.update({ status: 'unreconstructable', reason: 'Stream application failed; cached snapshot retained' });
    });
    return true;
  }
  private caughtUpAt(input: Record<string, unknown>): boolean {
    if (!this.application || this.cut === null || input.sequence !== this.cut || this.caughtUp) throw new Error('Invalid captured cut');
    const application = this.application;
    const generation = this.generation;
    this.caughtUp = true;
    // Enqueue the barrier NOW, before subsequent live records. Reading the
    // application's latest cursor in a later callback could acknowledge a
    // future sequence that the daemon never offered as this attachment's cut.
    void application.resumeCursor().then(cursor => {
      if (this.generation !== generation || !this.connected || this.application !== application) return;
      if (this.current.status === 'closed' || this.current.status === 'unreconstructable') return;
      if (cursor.after_sequence !== this.cut) { this.fail(); return; }
      this.acknowledged = true;
      this.update({ status: 'awaiting-ready' });
      this.mutate('StreamApplied', { sequence: this.cut }, false);
    }, () => {
      if (this.generation === generation && this.connected && this.application === application) this.fail('Parser drain failed; reconstruction is required');
    });
    return true;
  }
  /** A caller doing asynchronous work (clipboard reads) retains this identity
   * and compares it before sending; never silently target a newer lease. */
  mutationIdentity(ready = true): Readonly<MutationIdentity> | null {
    if (!this.connected || !this.attachmentId || this.current.status === 'closed' || (ready && this.current.status !== 'ready')) return null;
    return Object.freeze({ id: this.identity.session_id, incarnation: this.identity.incarnation, attachment_id: this.attachmentId });
  }
  mutate(action: string, payload: Record<string, unknown>, ready = true): boolean {
    if (!ready && action !== 'Kill' && action !== 'StreamApplied') return false;
    const identity = this.mutationIdentity(ready);
    if (!identity) return false;
    return this.send(action, { ...payload, ...identity });
  }
  resize(cols: number, rows: number): void {
    this.desiredSize = parseGrid(cols, rows);
    this.flushSize();
  }
  private flushSize(): void {
    const size = this.desiredSize;
    if (!size || (size.cols === this.sentSize?.cols && size.rows === this.sentSize?.rows)) return;
    if (this.mutate('Resize', size)) this.sentSize = size;
  }
  disconnect(): void {
    ++this.generation;
    this.connected = false;
    this.attachmentId = null;
    this.clearTimer();
    this.archive?.disconnect();
    if (this.archive) this.options.onArchive?.(this.archive.state);
    this.update({ status: 'disconnected' });
  }
  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.application?.dispose(); this.application = null;
  }
}
