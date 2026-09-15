export interface RecoverySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(text: string): void;
  close(): void;
}
interface Options {
  socket(): RecoverySocket;
  onMessage(event: string, data: unknown): void;
  onState?: (state: Readonly<ConnectionState>) => void;
  onDisconnect?: () => void;
}
export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'authenticating' | 'negotiating' | 'ready' | 'incompatible';
  daemonEpoch: string | null;
  message: string | null;
}
export type SendOutcome = 'sent' | 'refused' | 'unknown';
const encoder = new TextEncoder();
const MAX_INBOUND = 4 * 1024 * 1024;
const MAX_OUTBOUND_BUFFER = 8 * 1024 * 1024;
const MAX_COMMAND = 6 * 1024 * 1024 + 65536;
const legacyEvents = new Set(['PtyEvent', 'SessionMode', 'SessionClosed']);

/** One negotiated socket generation. This layer never stores commands for
 * reconnection. WebSocket ping/pong is handled by the browser implementation. */
export class RecoveryConnection {
  private current: Readonly<ConnectionState> = Object.freeze({ status: 'disconnected', daemonEpoch: null, message: null });
  private socket: RecoverySocket | null = null;
  private generation = 0;
  private offeredEpoch: string | null = null;
  private challengeSeen = false;
  private authenticated = false;
  private authAttempted = false;
  private token = ''; // Memory only; never included in observable state.
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private options: Options) {}
  get state(): Readonly<ConnectionState> { return this.current; }
  private update(patch: Partial<ConnectionState>): void {
    this.current = Object.freeze({ ...this.current, ...patch });
    this.options.onState?.(this.current);
  }
  private clearHandshake(): void {
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }
  private clearLiveness(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.livenessTimer !== null) clearTimeout(this.livenessTimer);
    this.heartbeatTimer = null; this.livenessTimer = null;
  }
  private observedFrame(): void {
    if (this.current.status !== 'ready') return;
    if (this.livenessTimer !== null) clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => this.restart('Daemon liveness expired; input disabled and in-flight delivery may be unknown'), 30000);
  }
  private disconnect(status: 'disconnected' | 'incompatible', message: string, retry: boolean): void {
    const socket = this.socket;
    this.socket = null;
    ++this.generation;
    this.clearHandshake();
    this.clearLiveness();
    this.offeredEpoch = null;
    this.update({ status, daemonEpoch: null, message });
    if (socket) {
      try { socket.close(); } catch { /* Already failed. */ }
      this.options.onDisconnect?.();
    }
    if (retry && !this.disposed && this.reconnectTimer === null) {
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, 2000);
    }
  }
  /** Explicit restart releases every lease; no accepted operation is replayed. */
  restart(reason = 'Connection interrupted; in-flight delivery may be unknown'): void {
    this.disconnect('disconnected', reason, true);
  }
  connect(): void {
    if (this.disposed || this.socket) return;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const generation = ++this.generation;
    this.challengeSeen = false;
    this.authenticated = false;
    this.authAttempted = false;
    this.offeredEpoch = null;
    this.update({ status: 'connecting', daemonEpoch: null, message: null });
    try {
      const socket = this.options.socket();
      this.socket = socket;
      const current = () => this.socket === socket && this.generation === generation && !this.disposed;
      // Includes opening the network connection, not just the first frame.
      this.handshakeTimer = setTimeout(() => {
        if (current()) this.restart('Protocol handshake timed out; no terminal input was enabled');
      }, 60000);
      socket.onopen = () => {
        // Wait for the server's auth challenge or authenticated advertisement.
        // Sending Auth unconditionally would itself be a legacy assumption.
        if (!current()) return;
      };
      socket.onmessage = event => {
        if (!current()) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > MAX_INBOUND || encoder.encode(event.data).length > MAX_INBOUND) throw new Error('Invalid frame');
          const message: unknown = JSON.parse(event.data);
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
          const { event: name, data } = message as Record<string, unknown>;
          if (typeof name !== 'string') throw new Error('Invalid event');
          this.receive(name, data);
          this.observedFrame();
        } catch {
          // Never log raw messages or exceptions containing terminal contents.
          this.disconnect('incompatible', 'Invalid or incompatible recovery protocol; update both shells together', false);
        }
      };
      socket.onclose = () => { if (current()) this.restart(); };
      socket.onerror = () => { if (current()) this.restart('Connection failed; in-flight delivery may be unknown'); };
    } catch {
      this.restart('Could not connect to the terminal daemon');
    }
  }
  private receive(event: string, value: unknown): void {
    const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (event === 'AuthResult') {
      if (typeof data.success !== 'boolean' || this.offeredEpoch) throw new Error('Invalid authentication transition');
      this.challengeSeen = true;
      this.authenticated = data.success;
      this.update({ status: 'authenticating', message: data.success ? null : 'Authentication required' });
      if (!data.success && this.token && !this.authAttempted) this.authenticate(this.token);
      return;
    }
    if (event === 'Protocol' || event === 'Negotiated') {
      if (data.version !== 2 || typeof data.daemon_epoch !== 'string' || !/^[0-9a-f]{32}$/.test(data.daemon_epoch)
          || (this.challengeSeen && !this.authenticated)) throw new Error('Incompatible protocol');
      const epoch = data.daemon_epoch;
      if (event === 'Protocol') {
        if (this.offeredEpoch !== null) {
          if (this.offeredEpoch !== epoch) throw new Error('Daemon epoch changed inside socket');
          return;
        }
        this.offeredEpoch = epoch;
        this.update({ status: 'negotiating', message: null });
        this.rawSend('Negotiate', { version: 2 });
      } else {
        if (this.offeredEpoch !== epoch || !['negotiating', 'ready'].includes(this.current.status)) throw new Error('Unoffered protocol');
        if (this.current.status === 'ready') return;
        this.clearHandshake();
        // Browser WebSocket handles protocol-level ping/pong invisibly. Use a
        // negotiated read-only Ping to observe daemon liveness in this client.
        this.heartbeatTimer = setInterval(() => this.send('Ping'), 10000);
        // Observers may synchronously close on failed admission. Install the
        // timer first so that close can clean it up, never leave a late timer.
        this.update({ status: 'ready', daemonEpoch: epoch, message: null });
      }
      return;
    }
    if (this.current.status !== 'ready' || event === 'Incompatible' || legacyEvents.has(event)) throw new Error('Unnegotiated event');
    this.options.onMessage(event, value);
  }
  authenticate(token: string): void {
    if (encoder.encode(token).length > 4096) throw new Error('Authentication token is too large');
    this.token = token;
    if (!this.socket || this.socket.readyState !== 1 || this.offeredEpoch) return;
    this.authAttempted = true;
    this.rawSend('Auth', { token });
  }
  private rawSend(action: string, payload?: unknown): SendOutcome {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return 'refused';
    let raw: string;
    try { raw = JSON.stringify({ action, payload }); } catch { return 'refused'; }
    const bytes = encoder.encode(raw).length;
    if (bytes > MAX_COMMAND) return 'refused';
    if (socket.bufferedAmount + bytes > MAX_OUTBOUND_BUFFER) {
      this.restart('Socket input buffer is full; new input was refused and older delivery may be unknown');
      return 'refused';
    }
    try { socket.send(raw); return 'sent'; }
    catch { this.restart('Connection failed during send; delivery is unknown'); return 'unknown'; }
  }
  send(action: string, payload?: unknown): SendOutcome {
    if (this.current.status !== 'ready' || action === 'Auth' || action === 'Negotiate') return 'refused';
    return this.rawSend(action, payload);
  }
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.disconnect('disconnected', 'Connection disposed', false);
    this.token = '';
  }
}
