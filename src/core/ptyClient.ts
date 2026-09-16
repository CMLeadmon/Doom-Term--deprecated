import type { SystemTelemetryData } from '../types/terminal';
import { BOOTSTRAP_COLS, BOOTSTRAP_ROWS, replaceEmulator } from './emulatorRegistry';
import type { RecoverableSession } from './sessionRecovery';
import { assertClipboardSize } from './terminalSelection';
import { RecoveryConnection } from './recoveryConnection';
import type { ConnectionState, RecoverySocket } from './recoveryConnection';
import { SessionAttachment } from './sessionAttachment';
import type { AttachmentState, MutationIdentity } from './sessionAttachment';
import type { AppliedContext } from './streamApplication';
import type { StreamRecord } from './streamProtocol';
import type { ArchiveState } from './recoveredArchive';
import { parseGrid } from './terminalGeometry';
import { boundCachedLines } from './presentationCache';

export interface DirectoryEntry { name: string; path: string; is_dir: boolean; is_git_repo: boolean }
export interface DirectoryListing { request_id: string; current_path: string; parent_path?: string; entries: DirectoryEntry[]; truncated?: boolean }
export interface SessionListing { request_id: string; sessions: RecoverableSession[]; discovery_error?: string | null }
export interface AgentHookEvent {
  agent: string; event: 'PermissionRequest' | 'Stop'; cwd: string | null;
  doomSessionId: string; incarnation: string; eventId: string; phase: 'catch-up' | 'live';
}
export interface ArtifactRecord {
  id: string;
  title: string;
  type: 'html' | 'markdown' | 'diff' | 'dashboard' | 'image';
  content: string;
  version: number;
  session_id?: string | null;
  created_at: number;
  updated_at: number;
}
export type DemuxEventHandler = {
  /** Already parsed live output; never feed this into the emulator again. */
  onOutput: (data: string, sessionId: string) => void;
  onStreamRecord?: (record: StreamRecord, context: AppliedContext) => void;
  onStreamActivity?: (record: StreamRecord, context: AppliedContext) => void;
  onInputRefused?: (id: string, reason: string) => void;
  onCwd?: (cwd: string, id: string) => void;
  onPromptStart?: (id: string) => void;
  onCommandStart?: (id: string) => void;
  onExecutionStart?: (id: string) => void;
  onExecutionEnd?: (code: number | null, id: string) => void;
  onTuiMode?: (active: boolean, id: string) => void;
  onAgentState?: (state: string, id: string) => void;
  onAgentEvent?: (event: AgentHookEvent) => void;
  onSessionClosed?: (id: string) => void;
};
interface Pending {
  event: string; sessionId?: string; mutating: boolean;
  resolve(value: Record<string, unknown>): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface CreateIntent {
  cols: number; rows: number; cwd?: string; shell?: string; status: 'unsent' | 'sent' | 'failed';
  resolve(incarnation: string): void; reject(error: Error): void;
}
interface Binding {
  id: string; incarnation?: string; attachment?: SessionAttachment;
  attempted: boolean; create?: CreateIntent; reason?: string;
}
const encoder = new TextEncoder();
const terminalStates = new Set(['ready', 'unreconstructable', 'missing', 'closed', 'replaced', 'busy', 'incompatible', 'failed']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid daemon result');
  return value as Record<string, unknown>;
}
function identity(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value); }

/** Shared browser/native client. Auth is connection-scoped, readiness is
 * attachment-scoped, and no input or accepted creation is queued for replay. */
export class PtyClient {
  private static instance: PtyClient;
  private readonly connection: RecoveryConnection;
  private readonly isTauri: boolean;
  private activeSessionId = '';
  private nextRequestId = 0;
  private disposed = false;
  private bindings = new Map<string, Binding>();
  private attaching = new Set<string>();
  private creating = new Set<CreateIntent>();
  private requests = new Map<string, Pending>();
  private sessionSizes = new Map<string, { cols: number; rows: number }>();
  private globalHandlers = new Set<DemuxEventHandler>();
  private sessionHandlers = new Map<string, Set<DemuxEventHandler>>();
  private telemetryHandlers = new Set<(data: SystemTelemetryData) => void>();
  private telemetryUnavailableHandlers = new Set<(id: string) => void>();
  private authHandlers = new Set<(message: string | null) => void>();
  private connectionHandlers = new Set<(state: Readonly<ConnectionState>) => void>();
  private attachmentHandlers = new Set<(id: string, state: Readonly<AttachmentState>) => void>();
  private incarnationHandlers = new Set<(id: string, incarnation: string) => void>();
  private historyHandlers = new Set<(id: string, state: Readonly<ArchiveState>) => void>();
  private cachedHistoryBudgets = new Map<string, { bytes: number; lines: number }>();
  private hooks = new Map<string, { event: AgentHookEvent; bytes: number }>();
  private hookBytes = 0;
  private sessionModeHandlers = new Set<(id: string, durable: boolean, detail: string | null) => void>();
  private artifactHandlers = new Set<(artifact: ArtifactRecord, openPane: boolean, phase: string) => void>();

  constructor(options: { socket?: () => RecoverySocket } = {}) {
    this.isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    this.connection = new RecoveryConnection({
      socket: options.socket ?? (() => {
        const host = this.isTauri ? '127.0.0.1' : window.location.hostname || '127.0.0.1';
        // Callbacks installed below consume only message.data or no event fields.
        return new WebSocket('ws://' + host + ':1421') as unknown as RecoverySocket;
      }),
      onMessage: (event, data) => this.handleServerMessage(event, data),
      onState: state => {
        this.connectionHandlers.forEach(handler => handler(state));
        this.authHandlers.forEach(handler => handler(state.status === 'authenticating' ? state.message : null));
        if (state.status === 'ready') this.pumpBindings();
      },
      onDisconnect: () => {
        this.attaching.clear();
        for (const binding of this.bindings.values()) {
          binding.attempted = false; binding.attachment?.disconnect();
        }
        this.rejectRequests('Connection disconnected');
      },
    });
    this.connection.connect();
  }
  static getInstance(): PtyClient { return this.instance ??= new PtyClient(); }
  getSessionId(): string { return this.activeSessionId; }
  setActiveSession(id: string): void { this.activeSessionId = id; }
  getIsTauri(): boolean { return this.isTauri; }
  getIsConnected(): boolean { return this.connection.state.status === 'ready'; }
  getAuthMessage(): string | null { return this.connection.state.status === 'authenticating' ? this.connection.state.message : null; }
  connect(): void { this.connection.connect(); }
  authenticate(token: string): void { this.connection.authenticate(token); }
  onAuthChange(handler: (message: string | null) => void): () => void {
    this.authHandlers.add(handler); return () => this.authHandlers.delete(handler);
  }
  onConnection(handler: (state: Readonly<ConnectionState>) => void): () => void {
    this.connectionHandlers.add(handler); return () => this.connectionHandlers.delete(handler);
  }
  onAttachment(handler: (id: string, state: Readonly<AttachmentState>) => void): () => void {
    this.attachmentHandlers.add(handler); return () => this.attachmentHandlers.delete(handler);
  }
  onIncarnation(handler: (id: string, incarnation: string) => void): () => void {
    this.incarnationHandlers.add(handler); return () => this.incarnationHandlers.delete(handler);
  }
  onHistory(handler: (id: string, state: Readonly<ArchiveState>) => void): () => void {
    this.historyHandlers.add(handler); return () => this.historyHandlers.delete(handler);
  }
  setCachedHistoryBudget(id: string, lines: unknown): void {
    const cache = boundCachedLines(lines);
    this.cachedHistoryBudgets.set(id, { bytes: cache.bytes, lines: cache.lines.length });
  }
  registerHandler(handler: DemuxEventHandler): () => void {
    this.globalHandlers.add(handler); this.replayHooks(undefined, handler);
    return () => this.globalHandlers.delete(handler);
  }
  registerSessionHandler(id: string, handler: DemuxEventHandler): () => void {
    let handlers = this.sessionHandlers.get(id);
    if (!handlers) { handlers = new Set(); this.sessionHandlers.set(id, handlers); }
    handlers.add(handler);
    this.replayHooks(id, handler);
    return () => { handlers.delete(handler); if (!handlers.size) this.sessionHandlers.delete(id); };
  }
  onTelemetry(handler: (data: SystemTelemetryData) => void): () => void {
    this.telemetryHandlers.add(handler); return () => this.telemetryHandlers.delete(handler);
  }
  onTelemetryUnavailable(handler: (id: string) => void): () => void {
    this.telemetryUnavailableHandlers.add(handler); return () => this.telemetryUnavailableHandlers.delete(handler);
  }
  onSessionMode(handler: (id: string, durable: boolean, detail: string | null) => void): () => void {
    this.sessionModeHandlers.add(handler); return () => this.sessionModeHandlers.delete(handler);
  }
  getSessionMode(id: string): { durable: boolean; detail: string | null } | null {
    const descriptor = this.bindings.get(id)?.attachment?.state.descriptor;
    return descriptor ? { durable: descriptor.durable, detail: descriptor.durable ? null : 'Direct PTY; daemon restart cannot preserve this process' } : null;
  }
  getAttachmentState(id: string): Readonly<AttachmentState> | null { return this.bindings.get(id)?.attachment?.state ?? null; }
  getHistory(id: string): Readonly<ArchiveState> | null { return this.bindings.get(id)?.attachment?.history ?? null; }
  private notify(id: string, callback: (handler: DemuxEventHandler) => void): void {
    this.sessionHandlers.get(id)?.forEach(callback); this.globalHandlers.forEach(callback);
  }
  private refused(id: string, reason: string): false { this.notify(id, handler => handler.onInputRefused?.(id, reason)); return false; }

  private replayHooks(id?: string, handler?: DemuxEventHandler): void {
    for (const { event } of this.hooks.values()) {
      if ((id !== undefined && event.doomSessionId !== id)
          || this.bindings.get(event.doomSessionId)?.incarnation !== event.incarnation) continue;
      const restored: AgentHookEvent = { ...event, phase: 'catch-up' };
      if (handler) handler.onAgentEvent?.(restored);
      else this.notify(event.doomSessionId, handler => handler.onAgentEvent?.(restored));
    }
  }
  private receiveHook(data: Record<string, unknown>): void {
    if (typeof data.agent !== 'string' || data.agent.length > 64
        || (data.event !== 'PermissionRequest' && data.event !== 'Stop')
        || typeof data.doom_session_id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(data.doom_session_id)
        || !identity(data.incarnation) || !identity(data.event_id)
        || (data.phase !== 'catch-up' && data.phase !== 'live')
        || (data.cwd != null && (typeof data.cwd !== 'string' || data.cwd.length > 4096))) return;
    const event: AgentHookEvent = { agent: data.agent, event: data.event, doomSessionId: data.doom_session_id,
      incarnation: data.incarnation, eventId: data.event_id, phase: data.phase, cwd: typeof data.cwd === 'string' ? data.cwd : null };
    const key = event.doomSessionId + '/' + event.incarnation;
    const previous = this.hooks.get(key);
    if (previous?.event.eventId === event.eventId) return;
    if (previous) { this.hooks.delete(key); this.hookBytes -= previous.bytes; }
    const bytes = encoder.encode(JSON.stringify(event)).byteLength;
    this.hooks.set(key, { event, bytes }); this.hookBytes += bytes;
    while (this.hooks.size > 256 || this.hookBytes > 1024 * 1024) {
      const [oldKey, old] = this.hooks.entries().next().value!;
      this.hooks.delete(oldKey); this.hookBytes -= old.bytes;
    }
    const binding = this.bindings.get(event.doomSessionId);
    if (binding?.incarnation !== event.incarnation) return;
    // During discovery/catch-up this is restored state, even if the HTTP
    // poster is still live. Notification eligibility begins at readiness.
    const delivered: AgentHookEvent = binding.attachment?.state.status === 'ready' ? event : { ...event, phase: 'catch-up' };
    this.notify(event.doomSessionId, handler => handler.onAgentEvent?.(delivered));
  }

  private attachBinding(binding: Binding): void {
    const id = binding.id;
    binding.attachment = new SessionAttachment({ session_id: id, incarnation: binding.incarnation! }, {
      send: (action, payload) => this.connection.send(action, payload) === 'sent',
      openScreen: descriptor => replaceEmulator(id, descriptor.initial_cols, descriptor.initial_rows),
      cachedHistoryBudget: () => this.cachedHistoryBudgets.get(id) ?? { bytes: 0, lines: 0 },
      onArchive: state => this.historyHandlers.forEach(handler => handler(id, state)),
      onRecord: (record, context) => {
        this.notify(id, handler => handler.onStreamRecord?.(record, context));
        if (record.payload.type === 'Closed') this.notify(id, handler => handler.onSessionClosed?.(id));
      },
      onActivity: (record, context) => {
        this.notify(id, handler => handler.onStreamActivity?.(record, context));
        if (record.payload.type === 'Event' && record.payload.payload.type === 'Output') {
          const text = record.payload.payload.payload.data;
          this.notify(id, handler => handler.onOutput(text, id));
        }
      },
      onState: state => {
        this.attachmentHandlers.forEach(handler => handler(id, state));
        if (state.descriptor) this.sessionModeHandlers.forEach(handler => handler(id, state.descriptor!.durable, this.getSessionMode(id)?.detail ?? null));
        if (state.status === 'closed') this.rejectRequests('Session closed', id, true);
        if (terminalStates.has(state.status)) { this.attaching.delete(id); this.pumpBindings(); }
      },
      onFailure: reason => this.connection.restart(reason),
    });
    const size = this.sessionSizes.get(id);
    if (size) binding.attachment.resize(size.cols, size.rows);
    this.incarnationHandlers.forEach(handler => handler(id, binding.incarnation!));
  }
  bindExisting(id: string, incarnation: string): boolean {
    if (!identity(incarnation)) return this.refused(id, 'Unknown incarnation; explicit recovery is required');
    const existing = this.bindings.get(id);
    if (existing) return existing.incarnation === incarnation || this.refused(id, 'Session identity changed; cached snapshot retained');
    const binding: Binding = { id, incarnation, attempted: false };
    this.bindings.set(id, binding); this.attachBinding(binding); this.replayHooks(id); this.pumpBindings();
    return this.bindings.get(id) === binding;
  }
  /** Only a newly introduced UI node implies Create. Restores supply identity. */
  ensureSession(id: string, cwd?: string, incarnation?: string): void {
    if (incarnation) { this.bindExisting(id, incarnation); return; }
    if (this.bindings.has(id)) return;
    const size = this.sessionSizes.get(id);
    void this.createSession(id, size?.cols ?? BOOTSTRAP_COLS, size?.rows ?? BOOTSTRAP_ROWS, cwd).catch(() => undefined);
  }
  createSession(id: string, cols: number, rows: number, cwd?: string, shell?: string): Promise<string> {
    if (this.disposed || this.bindings.has(id)) return Promise.reject(new Error('Creation conflict; existing state was not changed'));
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id)) return Promise.reject(new Error('Invalid session id'));
    try { parseGrid(cols, rows); } catch (error) { return Promise.reject(error); }
    const binding: Binding = { id, attempted: false };
    const created = new Promise<string>((resolve, reject) => { binding.create = { cols, rows, cwd, shell, status: 'unsent', resolve, reject }; });
    // A caller can consume UI refusal state without awaiting a launch. Preserve
    // rejection for awaiting callers while observing it internally as well.
    void created.catch(() => undefined);
    this.bindings.set(id, binding); this.pumpBindings(); return created;
  }
  spawnSession(id: string, cols: number, rows: number, cwd?: string, shell?: string): void {
    void this.createSession(id, cols, rows, cwd, shell).catch(error => this.refused(id, (error as Error).message));
  }
  private pumpBindings(): void {
    if (!this.getIsConnected() || this.disposed) return;
    for (const binding of this.bindings.values()) {
      const intent = binding.create;
      if (intent?.status === 'unsent' && this.creating.size < 4) {
        intent.status = 'sent'; this.creating.add(intent);
        void this.request('Create', { id: binding.id, cols: intent.cols, rows: intent.rows, cwd: intent.cwd ?? null, shell: intent.shell ?? null },
          'CreateResult', true, binding.id, 15000).then(result => {
          if (this.bindings.get(binding.id) !== binding) {
            throw new Error('Session forgotten; creation may have completed. Discover before recovering it.');
          }
          if (result.error !== null) {
            const code = object(result.error).code;
            throw new Error(code === 'conflict' ? 'Creation conflict; no attachment was assumed' : 'Create failed; outcome is unknown. Discover before trying again.');
          }
          if (!identity(result.incarnation)) throw new Error('Invalid creation result; outcome is unknown');
          binding.incarnation = result.incarnation; binding.create = undefined;
          this.attachBinding(binding);
          if (this.bindings.get(binding.id) !== binding) {
            throw new Error('Session forgotten after creation; discover before recovering it.');
          }
          this.replayHooks(binding.id); intent.resolve(result.incarnation);
        }).catch(error => {
          intent.status = 'failed'; binding.reason = (error as Error).message;
          intent.reject(error as Error);
          if (this.bindings.get(binding.id) === binding) this.refused(binding.id, binding.reason);
        }).finally(() => { this.creating.delete(intent); this.pumpBindings(); });
      }
      if (binding.attachment && !binding.attempted && this.attaching.size < 4) {
        binding.attempted = true; this.attaching.add(binding.id);
        void binding.attachment.attach('attach-' + this.nextRequestId++).catch(() => this.connection.restart('Attachment failed; no input was replayed'));
      }
    }
  }
  private request(action: string, payload: Record<string, unknown>, event: string, mutating: boolean, sessionId?: string, timeout = 5000): Promise<Record<string, unknown>> {
    if (!this.getIsConnected()) return Promise.reject(new Error('Connection is not ready; request was not sent'));
    if (this.requests.size >= 128) return Promise.reject(new Error('Too many pending requests; nothing was sent'));
    return new Promise((resolve, reject) => {
      const requestId = 'request-' + this.nextRequestId++;
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error(action + ' timed out' + (mutating ? '; delivery is unknown. Check before retrying.' : '')));
      }, timeout);
      this.requests.set(requestId, { event, sessionId, mutating, resolve, reject, timer });
      const outcome = this.connection.send(action, { ...payload, request_id: requestId });
      if (outcome !== 'sent') {
        this.requests.delete(requestId); clearTimeout(timer);
        reject(new Error(outcome === 'unknown' ? action + ' delivery is unknown' : action + ' was refused; nothing was sent'));
      }
    });
  }
  private rejectRequests(reason: string, sessionId?: string, preserveKill = false): void {
    for (const [id, pending] of this.requests) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      // A Kill commonly causes its close record before the correlated result
      // reaches the socket. Closure rejects input, not that confirmation.
      if (preserveKill && pending.event === 'KillResult') continue;
      this.requests.delete(id); clearTimeout(pending.timer);
      pending.reject(new Error(reason + (pending.mutating ? '; delivery is unknown. Check before retrying.' : '; request canceled')));
    }
  }
  private handleServerMessage(event: string, value: unknown): void {
    if (event === 'Pong') return;
    const data = object(value);
    if (typeof data.request_id === 'string') {
      const pending = this.requests.get(data.request_id);
      if (pending && pending.event === event && (pending.sessionId === undefined || pending.sessionId === data.session_id)) {
        this.requests.delete(data.request_id); clearTimeout(pending.timer); pending.resolve(data); return;
      }
    }
    if (event === 'Telemetry') {
      if (data.session_id != null) {
        if (typeof data.session_id !== 'string') return;
        const incarnation = this.bindings.get(data.session_id)?.incarnation;
        if (!incarnation || data.incarnation !== incarnation) return;
      }
      this.telemetryHandlers.forEach(handler => handler(data as unknown as SystemTelemetryData)); return;
    }
    if (event === 'TelemetryUnavailable') {
      if (typeof data.session_id !== 'string' || !identity(data.incarnation)) return;
      if (this.bindings.get(data.session_id)?.incarnation !== data.incarnation) return;
      this.telemetryUnavailableHandlers.forEach(handler => handler(data.session_id as string)); return;
    }
    if (event === 'AgentEvent') {
      this.receiveHook(data); return;
    }
    if (event === 'ArtifactEvent') {
      const artifact = data.artifact as unknown as ArtifactRecord;
      const openPane = Boolean(data.open_pane);
      const phase = String(data.phase || 'live');
      this.artifactHandlers.forEach(handler => handler(artifact, openPane, phase));
      return;
    }
    if (event === 'OperationError') {
      if (typeof data.session_id === 'string') this.refused(data.session_id, 'Operation refused; attachment is not ready or delivery is unknown');
      return;
    }
    const id = event === 'StreamRecord' ? object(data.record).session_id : data.session_id;
    if (typeof id === 'string') this.bindings.get(id)?.attachment?.accept(event, data);
  }
  onArtifact(handler: (artifact: ArtifactRecord, openPane: boolean, phase: string) => void): () => void {
    this.artifactHandlers.add(handler);
    return () => this.artifactHandlers.delete(handler);
  }
  inputReadiness(id: string): string | null {
    const binding = this.bindings.get(id);
    if (binding?.reason) return binding.reason;
    if (!this.getIsConnected()) return 'Connection disconnected or not negotiated; input was not sent';
    if (!binding?.attachment) return 'Session is not ready; input was not sent';
    const state = binding.attachment.state;
    return state.status === 'ready' ? null : state.reason ?? 'Session ' + state.status + '; input was not sent';
  }
  captureInputIdentity(id: string): Readonly<MutationIdentity> | null {
    return this.getIsConnected() ? this.bindings.get(id)?.attachment?.mutationIdentity() ?? null : null;
  }
  writeToSession(id: string, data: string): boolean {
    const reason = this.inputReadiness(id); if (reason) return this.refused(id, reason);
    if (encoder.encode(data).length > 65536) return this.refused(id, 'Input exceeds the write limit; nothing was sent');
    return this.bindings.get(id)?.attachment?.mutate('Write', { data }) ?? false;
  }
  write(data: string): boolean { return this.writeToSession(this.activeSessionId, data); }
  /** Explicit submission has no echo waiter or held keystrokes. Multiline
   * text requires child-checked paste, never invented bracket framing. */
  submitCommandToSession(id: string, command: string): boolean {
    if (/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(command)) return this.refused(id, 'Use child-checked paste for multiline/control input; nothing was sent');
    return this.writeToSession(id, command + '\r');
  }
  submitCommand(command: string): boolean { return this.submitCommandToSession(this.activeSessionId, command); }
  async pasteToSession(id: string, text: string, expected?: Readonly<MutationIdentity> | null): Promise<void> {
    assertClipboardSize(text);
    const permit = this.captureInputIdentity(id);
    if (!permit) throw new Error(this.inputReadiness(id) ?? 'Session not ready');
    if (expected !== undefined && (!expected || expected.id !== permit.id || expected.incarnation !== permit.incarnation || expected.attachment_id !== permit.attachment_id)) {
      throw new Error('Terminal ownership changed while reading the clipboard; paste was not sent');
    }
    const result = await this.request('Paste', { ...permit, text }, 'PasteResult', true, id, 10000);
    if (result.error !== null) throw new Error(typeof result.error === 'string' ? result.error : 'Invalid paste result; delivery is unknown');
  }
  resizeSession(id: string, cols: number, rows: number): void {
    this.sessionSizes.set(id, parseGrid(cols, rows)); this.bindings.get(id)?.attachment?.resize(cols, rows);
  }
  sendSignalToSession(id: string, signal: 'SIGINT' | 'SIGTSTP' | 'EOF' | 'SIGKILL' | 'ctrl+c' | 'ctrl+z' | 'ctrl+d'): boolean {
    if (signal === 'SIGKILL') { void this.killSession(id); return true; }
    const reason = this.inputReadiness(id); if (reason) return this.refused(id, reason);
    return this.bindings.get(id)?.attachment?.mutate('Signal', { signal }) ?? false;
  }
  sendSignal(signal: 'SIGINT' | 'SIGTSTP' | 'EOF' | 'SIGKILL' | 'ctrl+c' | 'ctrl+z' | 'ctrl+d'): boolean { return this.sendSignalToSession(this.activeSessionId, signal); }
  async killSession(id: string): Promise<boolean> {
    const permit = this.bindings.get(id)?.attachment?.mutationIdentity(false);
    if (!permit) return this.refused(id, 'No current lifecycle ownership; process was not killed');
    try {
      const result = await this.request('Kill', { ...permit }, 'KillResult', true, id, 10000);
      if (result.error !== null) throw new Error('Kill refused or delivery unknown; keep the cached session');
      return true;
    } catch (error) { return this.refused(id, (error as Error).message); }
  }
  /** Local presentation removal is explicit, separate from process killing. */
  forgetSession(id: string): void {
    const binding = this.bindings.get(id);
    this.bindings.delete(id);
    binding?.attachment?.dispose();
    if (binding?.create?.status === 'unsent') {
      binding.create.status = 'failed';
      binding.create.reject(new Error('Session forgotten; creation was not sent'));
    }
    this.attaching.delete(id); this.sessionSizes.delete(id); this.rejectRequests('Session forgotten', id);
    this.cachedHistoryBudgets.delete(id);
    for (const [key, hook] of this.hooks) {
      if (hook.event.doomSessionId === id) { this.hooks.delete(key); this.hookBytes -= hook.bytes; }
    }
  }
  async browseDirectory(path?: string): Promise<DirectoryListing> {
    if (this.isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return { ...await invoke<Omit<DirectoryListing, 'request_id'>>('browse_directory', { path: path || null }), request_id: 'tauri' };
      } catch { /* The negotiated daemon is the fallback, never legacy commands. */ }
    }
    const listing = await this.request('BrowseDirectory', { path: path || null }, 'DirectoryListing', false);
    if (listing.error) throw new Error(typeof listing.error === 'string' ? listing.error : 'Directory unavailable');
    if (typeof listing.current_path !== 'string' || !Array.isArray(listing.entries)) throw new Error('Invalid directory response');
    return listing as unknown as DirectoryListing;
  }
  async listSessions(): Promise<SessionListing> { return await this.request('ListSessions', {}, 'SessionListing', false) as unknown as SessionListing; }
  async recoverLegacy(session: RecoverableSession): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(session.id) || !session.durable || session.identity_status !== 'unidentified'
        || session.incarnation != null || typeof session.pane !== 'string' || !/^%[0-9]{1,20}$/.test(session.pane)
        || !Number.isInteger(session.root_pid) || session.root_pid! <= 0 || session.root_pid! > 0xffffffff) {
      throw new Error('An exact observed legacy pane and root pid are required');
    }
    try {
      const result = await this.request('RecoverLegacy', { id: session.id, pane: session.pane, root_pid: session.root_pid },
        'RecoverLegacyResult', true, session.id, 10000);
      if (result.error !== null || !identity(result.incarnation)) throw new Error('Legacy recovery refused or outcome unknown; discover before trying again');
      return result.incarnation;
    } catch (error) {
      this.refused(session.id, (error as Error).message); throw error;
    }
  }
  async createWorktree(cwd: string, branch: string): Promise<{ path: string; branch: string }> {
    const result = await this.request('CreateWorktree', { cwd, branch }, 'WorktreeCreated', true, undefined, 30000);
    if (result.error || typeof result.path !== 'string' || typeof result.branch !== 'string') throw new Error('Worktree failed or outcome unknown; check git worktree list before retrying');
    return { path: result.path, branch: result.branch };
  }
  requestTelemetry(cwd?: string): void {
    this.connection.send('GetTelemetry', { cwd: cwd ?? null, session_id: this.activeSessionId || null,
      incarnation: this.bindings.get(this.activeSessionId)?.incarnation ?? null });
  }
  dispose(): void {
    this.disposed = true; this.connection.dispose();
    for (const binding of this.bindings.values()) {
      binding.attachment?.dispose();
      if (binding.create?.status === 'unsent') binding.create.reject(new Error('Client disposed; creation was not sent'));
    }
    this.bindings.clear(); this.cachedHistoryBudgets.clear(); this.hooks.clear(); this.hookBytes = 0;
  }
}

export function looksLikeAbsolutePath(value: string): boolean {
  const path = value.trim(); return path.startsWith('/') || path === '~' || path.startsWith('~/');
}
export const ptyClient = PtyClient.getInstance();
