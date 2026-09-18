import { parseSequence, parseStreamDescriptor, parseStreamRecord } from './streamProtocol';
import type { StreamDescriptor, StreamRecord, ResumeCursor } from './streamProtocol';
import type { TerminalScreen } from './terminalScreen';

export type StreamPhase = 'catch-up' | 'live';
export interface AppliedContext {
  phase: StreamPhase;
  eventId: string;
  clockEpoch: string;
  observedMicros: number;
  state: Readonly<StreamState>;
}
export interface StreamObservers {
  /** False for a discontinuous tmux rebuild; retained counts are not complete. */
  historyComplete?: boolean;
  /** Synchronous projection of already-applied authoritative state. */
  onRecord?: (record: StreamRecord, context: AppliedContext) => void;
  /** New live activity only: never duplicate records or catch-up effects. */
  onActivity?: (record: StreamRecord, context: AppliedContext) => void;
}
export interface StreamState {
  completedCommands: number | null;
  lastExecutionDurationMs: number | null;
  lastExitCode: number | null;
  closed: boolean;
  atPrompt: boolean | null;
  cwd: string | null;
  agentState: string | null;
  isTuiActive: boolean | null;
}

/** One application's lifetime matches one live parser/stream epoch. The caller
 * supplies a fresh screen at recorded initial dimensions for cold replay.
 * Warm reconnection keeps this object and screen; metadata never resets it. */
export class StreamApplication {
  readonly descriptor: Readonly<StreamDescriptor>;
  private cursor = 0n;
  private tail: Promise<unknown> = Promise.resolve();
  private failure: Error | null = null;
  private startedMicros: number | null = null;
  private sourceMicros = 0;
  private pendingEntries = 0;
  private pendingBytes = 0;
  private derived: StreamState = { completedCommands: 0, lastExecutionDurationMs: null, lastExitCode: null, closed: false,
    atPrompt: null, cwd: null, agentState: null, isTuiActive: null };

  constructor(descriptor: StreamDescriptor, private screen: TerminalScreen, private observers: StreamObservers = {}) {
    this.descriptor = parseStreamDescriptor(descriptor);
    if (observers.historyComplete === false) this.derived.completedCommands = null;
  }
  get appliedSequence(): string { return this.cursor.toString(); }
  get state(): Readonly<StreamState> { return Object.freeze({ ...this.derived }); }

  private check(): void { if (this.failure) throw this.failure; }
  private invalidate(error: unknown): Error {
    this.failure ??= error instanceof Error ? error : new Error('Stream application failed');
    this.derived = { ...this.derived, completedCommands: null, lastExecutionDurationMs: null };
    this.startedMicros = null;
    return this.failure;
  }
  private enqueue<T>(work: () => Promise<T>, bytes = 0): Promise<T> {
    if (this.pendingEntries >= 8192 || this.pendingBytes + bytes > 4 * 1024 * 1024) {
      return Promise.reject(this.invalidate(new Error('Stream application queue overflow; reconstruction is required')));
    }
    this.pendingEntries++;
    this.pendingBytes += bytes;
    const result = this.tail.then(() => { this.check(); return work(); })
      .catch(error => { throw this.invalidate(error); })
      .finally(() => { this.pendingEntries--; this.pendingBytes -= bytes; });
    // Observe failures internally without hiding rejection from the caller.
    // Later work checks the sticky failure and can never retry application.
    this.tail = result.catch(() => undefined);
    return result;
  }

  apply(value: unknown, phase: StreamPhase): Promise<'applied' | 'duplicate'> {
    let record: StreamRecord;
    try { this.check(); record = parseStreamRecord(value); }
    catch (error) { return Promise.reject(this.invalidate(error)); }
    return this.enqueue(async () => {
      const meta = this.descriptor;
      if (record.session_id !== meta.session_id || record.incarnation !== meta.incarnation || record.stream_epoch !== meta.stream_epoch) {
        throw new Error('Stream identity changed; reconstruction is required');
      }
      const sequence = parseSequence(record.sequence);
      if (sequence <= this.cursor) return 'duplicate';
      if (this.derived.closed) throw new Error('Stream is closed');
      if (sequence !== this.cursor + 1n) throw new Error('Stream gap; reconstruction is required');
      if (record.observed_micros < this.sourceMicros) throw new Error('Stream source clock moved backwards');
      const payload = record.payload;
      if (payload.type === 'Event' && payload.payload.type === 'Output') {
        await this.screen.writeAndWait(payload.payload.payload.data);
      } else {
        // Even records without bytes belong to this parser's lifetime. Resize
        // alone may silently no-op after disposal; semantic records must not
        // acknowledge a cursor against a dead or failed screen either.
        await this.screen.drain();
        this.check();
        if (payload.type === 'Resize') {
          this.screen.resize(payload.payload.cols, payload.payload.rows);
        } else if (payload.type === 'Fault' || (payload.type === 'Event' && payload.payload.type === 'StreamFault')) {
          throw new Error('Stream fault; reconstruction is required');
        }
      }
      this.check(); // A disposed application cannot acknowledge a late parse.
      if (payload.type === 'Event') {
        const event = payload.payload;
        if (event.type === 'PromptStart' || event.type === 'CommandStart') this.derived.atPrompt = true;
        if (event.type === 'Cwd') this.derived.cwd = event.payload.path;
        if (event.type === 'AgentState') this.derived.agentState = event.payload.state;
        if (event.type === 'TuiMode') this.derived.isTuiActive = event.payload.active;
        if (event.type === 'TuiModeUnknown') this.derived.isTuiActive = null;
        if (event.type === 'ExecutionStart') {
          this.startedMicros = record.observed_micros;
          this.derived.atPrompt = false;
        }
        if (event.type === 'ExecutionEnd') {
          this.derived = {
            ...this.derived,
            completedCommands: this.derived.completedCommands === null ? null : this.derived.completedCommands + 1,
            lastExecutionDurationMs: this.startedMicros === null ? null : (record.observed_micros - this.startedMicros) / 1000,
            lastExitCode: event.payload.exit_code,
          };
          this.startedMicros = null;
        }
      }
      if (payload.type === 'Closed') {
        this.derived = { ...this.derived, closed: true, atPrompt: false, lastExitCode: payload.payload.exit_code };
        this.startedMicros = null;
      }
      const context: AppliedContext = { phase, eventId: `${meta.incarnation}/${meta.stream_epoch}/${record.sequence}`,
        clockEpoch: meta.clock_epoch, observedMicros: record.observed_micros, state: this.state };
      this.observers.onRecord?.(record, context);
      this.check();
      if (phase === 'live') this.observers.onActivity?.(record, context);
      this.check();
      this.sourceMicros = record.observed_micros;
      this.cursor = sequence;
      return 'applied';
    }, new TextEncoder().encode(JSON.stringify(record)).length);
  }

  resumeCursor(): Promise<ResumeCursor> {
    // An ordered barrier, not a snapshot of the promise tail at call time.
    const drained = this.enqueue(async () => {
      await this.screen.drain();
      this.check();
      return { stream_epoch: this.descriptor.stream_epoch, after_sequence: this.appliedSequence };
    });
    // Include application work waiting ahead of this barrier in the deadline.
    // Bounding each individual write would allow a long queue to drain forever.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(this.invalidate(new Error('Stream drain timed out; reconstruction is required'))), 5000);
      void drained.then(
        cursor => { clearTimeout(timer); resolve(cursor); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }
  dispose(): void { this.invalidate(new Error('Stream application is disposed')); }
}
