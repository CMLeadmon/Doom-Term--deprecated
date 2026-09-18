import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonConnection } from './daemonConnection';
import { diagnostics } from './diagnostics';

const epoch = 'a'.repeat(32);
class Socket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: { action: string; payload?: unknown }[] = [];
  close = vi.fn(() => { this.readyState = 3; });
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(event: string, data?: unknown) { this.onmessage?.({ data: JSON.stringify({ event, data }) }); }
  negotiate() { this.receive('Protocol', { version: 2, daemon_epoch: epoch }); this.receive('Negotiated', { version: 2, daemon_epoch: epoch }); }
}
const connections: DaemonConnection[] = [];
afterEach(() => { connections.splice(0).forEach(value => value.dispose()); vi.useRealTimers(); });
function fixture() {
  const sockets: Socket[] = [];
  const events = vi.fn(); const states = vi.fn(); const disconnected = vi.fn();
  const connection = new DaemonConnection({ socket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    onMessage: events, onState: states, onDisconnect: disconnected });
  connections.push(connection); connection.connect();
  return { connection, sockets, events, states, disconnected };
}
describe('negotiated recovery connection', () => {
  it('sends no discovery or mutation until the server advertises v2 and confirms the same daemon epoch', () => {
    const f = fixture(); const socket = f.sockets[0]; socket.open();
    expect(f.connection.send('ListSessions', { request_id: 'read' })).toBe('refused');
    expect(socket.sent).toEqual([]);
    socket.receive('Protocol', { version: 2, daemon_epoch: epoch });
    expect(socket.sent).toEqual([{ action: 'Negotiate', payload: { version: 2 } }]);
    expect(f.connection.state.status).toBe('negotiating');
    socket.receive('Negotiated', { version: 2, daemon_epoch: epoch });
    expect(f.connection.state.status).toBe('ready');
    expect(f.connection.send('ListSessions', { request_id: 'read' })).toBe('sent');
  });

  it('keeps authentication separate from protocol readiness and does not echo the credential to observers', () => {
    const f = fixture(); const socket = f.sockets[0]; socket.open();
    socket.receive('AuthResult', { success: false, message: 'Authentication required' });
    f.connection.authenticate('private-token');
    expect(socket.sent).toEqual([{ action: 'Auth', payload: { token: 'private-token' } }]);
    socket.receive('AuthResult', { success: true, message: 'Authenticated' });
    expect(f.connection.state.status).not.toBe('ready');
    socket.negotiate(); expect(f.connection.state.status).toBe('ready');
    expect(JSON.stringify(f.states.mock.calls)).not.toContain('private-token');
    expect(f.events).not.toHaveBeenCalled();
  });

  it('resends only remembered authentication on a new challenge, never offline input', async () => {
    vi.useFakeTimers(); const f = fixture(); const first = f.sockets[0]; first.open();
    first.receive('AuthResult', { success: false }); f.connection.authenticate('secret');
    first.receive('AuthResult', { success: true }); first.negotiate();
    first.readyState = 3; first.onclose?.();
    expect(f.connection.send('Write', { data: 'OFFLINE' })).toBe('refused');
    await vi.advanceTimersByTimeAsync(2000);
    const next = f.sockets[1]; next.open(); next.receive('AuthResult', { success: false });
    expect(next.sent).toEqual([{ action: 'Auth', payload: { token: 'secret' } }]);
    next.receive('AuthResult', { success: true }); next.negotiate();
    expect(next.sent.map(value => value.action)).toEqual(['Auth', 'Negotiate']);
    expect(f.disconnected).toHaveBeenCalledTimes(1);
  });

  it('ignores all callbacks from an obsolete socket, including close after the replacement is ready', async () => {
    vi.useFakeTimers(); const f = fixture(); const first = f.sockets[0]; first.open(); first.negotiate();
    const oldClose = first.onclose!; const oldMessage = first.onmessage!;
    first.readyState = 3; oldClose(); await vi.advanceTimersByTimeAsync(2000);
    const next = f.sockets[1]; next.open(); next.negotiate();
    oldMessage({ data: JSON.stringify({ event: 'StreamRecord', data: { session_id: 'wrong' } }) }); oldClose();
    expect(f.events).not.toHaveBeenCalled(); expect(f.disconnected).toHaveBeenCalledTimes(1);
    expect(f.connection.state.status).toBe('ready');
  });

  it.each(['legacy', 'changed-epoch', 'unoffered-ready', 'pre-auth-discovery'])('fails closed on %s without legacy fallback or automatic reconnect loops', async defect => {
    vi.useFakeTimers(); const f = fixture(); const socket = f.sockets[0]; socket.open();
    if (defect === 'legacy') socket.receive('SessionMode', {});
    if (defect === 'changed-epoch') { socket.receive('Protocol', { version: 2, daemon_epoch: epoch }); socket.receive('Negotiated', { version: 2, daemon_epoch: 'b'.repeat(32) }); }
    if (defect === 'unoffered-ready') socket.receive('Negotiated', { version: 2, daemon_epoch: epoch });
    if (defect === 'pre-auth-discovery') { socket.receive('AuthResult', { success: false }); socket.receive('Protocol', { version: 2, daemon_epoch: epoch }); }
    expect(f.connection.state.status).toBe('incompatible'); expect(socket.close).toHaveBeenCalled();
    expect(f.events).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000); expect(f.sockets).toHaveLength(1);
  });

  it('bounds outbound socket buffering and reports a thrown send as unknown, never unsent', () => {
    const f = fixture(); const socket = f.sockets[0]; socket.open(); socket.negotiate();
    socket.bufferedAmount = 8 * 1024 * 1024;
    expect(f.connection.send('Write', { data: 'full' })).toBe('refused');
    expect(f.connection.state.status).toBe('disconnected');
    const g = fixture(); const next = g.sockets[0]; next.open(); next.negotiate();
    next.send = () => { throw new Error('transport failure'); };
    expect(g.connection.send('Write', { data: 'unknown' })).toBe('unknown');
    expect(g.connection.state.status).toBe('disconnected');
  });

  it('bounds incoming frames before JSON dispatch and discards oversized data without echoing it or disconnecting', () => {
    diagnostics.clear();
    const f = fixture(); const socket = f.sockets[0]; socket.open(); socket.negotiate();
    socket.onmessage?.({ data: 'sensitive'.repeat(600000) });
    expect(f.connection.state.status).toBe('ready'); expect(f.events).not.toHaveBeenCalled();
    expect(diagnostics.snapshot().counters.framesDropped).toBe(1);
    expect(JSON.stringify(f.states.mock.calls)).not.toContain('sensitive');
  });

  it('expires a silent handshake and cleans all timers on disposal', async () => {
    vi.useFakeTimers(); const f = fixture(); f.sockets[0].open();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.connection.state.status).toBe('disconnected'); expect(f.sockets[0].close).toHaveBeenCalled();
    f.connection.dispose(); await vi.advanceTimersByTimeAsync(60000);
    expect(f.sockets).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('expires a silent established connection thirty seconds after its last observed frame', async () => {
    vi.useFakeTimers(); const f = fixture(); const socket = f.sockets[0]; socket.open(); socket.negotiate();
    await vi.advanceTimersByTimeAsync(10000);
    expect(socket.sent.filter(request => request.action === 'Ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000); socket.receive('Pong');
    await vi.advanceTimersByTimeAsync(29999); expect(f.connection.state.status).toBe('ready');
    await vi.advanceTimersByTimeAsync(1); expect(f.connection.state.status).toBe('disconnected');
    expect(socket.close).toHaveBeenCalled();
    expect(f.connection.send('Write', { data: 'stale' })).toBe('refused');
  });

  it('does not leak a heartbeat when a ready-state observer immediately disconnects the socket', () => {
    vi.useFakeTimers(); const socket = new Socket();
    const connection = new DaemonConnection({ socket: () => socket, onMessage: () => undefined,
      onState: state => { if (state.status === 'ready') connection.restart('observer closed'); } });
    connections.push(connection); connection.connect(); socket.open(); socket.negotiate();
    expect(connection.state.status).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(1); // Only the bounded reconnect timer.
  });
});

describe('stream faults are not protocol incompatibilities', () => {
  // The attachment state machine throws for ordinary stream-state assertions
  // ("Record outside its captured phase", "Unacknowledged readiness",
  // "Record identity changed"). Those ran inside the frame-decoding try, so one
  // of them permanently marked the daemon incompatible with retry disabled:
  // output kept rendering while every keystroke was refused forever.
  it('restarts and reconnects when the consumer rejects a record', () => {
    vi.useFakeTimers();
    const f = fixture(); const socket = f.sockets[0]; socket.open(); socket.negotiate();
    expect(f.connection.state.status).toBe('ready');
    f.events.mockImplementationOnce(() => { throw new Error('Record outside its captured phase'); });
    socket.receive('StreamRecord', { record: { session_id: 'pane' } });
    expect(f.connection.state.status).toBe('disconnected');
    expect(f.connection.state.message ?? '').not.toMatch(/update both shells/);
    expect(f.disconnected).toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(f.sockets).toHaveLength(2);
  });

  it('drops a malformed frame without setting incompatible or disconnecting', () => {
    diagnostics.clear();
    const f = fixture(); const socket = f.sockets[0]; socket.open(); socket.negotiate();
    socket.onmessage?.({ data: 'not json at all' });
    expect(f.connection.state.status).toBe('ready');
    expect(diagnostics.snapshot().counters.framesDropped).toBe(1);
    expect(f.sockets).toHaveLength(1);
  });

  it('ignores an unrecognized event without setting incompatible or disconnecting', () => {
    diagnostics.clear();
    const f = fixture(); const socket = f.sockets[0]; socket.open(); socket.negotiate();
    socket.receive('SomeFutureDaemonEvent', { futureData: 123 });
    expect(f.connection.state.status).toBe('ready');
    expect(diagnostics.snapshot().counters.unknownEvents).toBe(1);
    expect(f.sockets).toHaveLength(1);
  });

  it('ignores an unnegotiated event received before ready without setting incompatible', () => {
    diagnostics.clear();
    const f = fixture(); const socket = f.sockets[0]; socket.open();
    socket.receive('StreamRecord', { record: { session_id: 'pane' } });
    expect(f.connection.state.status).not.toBe('incompatible');
    expect(diagnostics.snapshot().counters.unknownEvents).toBe(1);
  });
});
