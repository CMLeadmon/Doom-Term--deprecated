import { afterEach, describe, expect, it, vi } from 'vitest';
import { PtyClient } from './ptyClient';
import { resetAllEmulators } from './emulatorRegistry';
import type { RecoverySocket } from './recoveryConnection';

const incarnation = '1'.repeat(32); const epoch = '2'.repeat(32); const attachment = '3'.repeat(32);
class Socket implements RecoverySocket {
  readyState = 0; bufferedAmount = 0;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: { action: string; payload: Record<string, unknown> }[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  receive(event: string, data: unknown) { this.onmessage?.({ data: JSON.stringify({ event, data }) }); }
  open() {
    this.readyState = 1; this.onopen?.();
    this.receive('Protocol', { version: 2, daemon_epoch: epoch }); this.receive('Negotiated', { version: 2, daemon_epoch: epoch });
  }
  attaches() { return this.sent.filter(value => value.action === 'Attach'); }
  async ready(id: string) {
    await vi.waitFor(() => expect(this.attaches().some(value => value.payload.id === id)).toBe(true));
    const request = this.attaches().find(value => value.payload.id === id)!;
    const descriptor = { session_id: id, incarnation, stream_epoch: epoch, clock_epoch: epoch, initial_cols: 40, initial_rows: 10, durable: true };
    this.receive('AttachResult', { request_id: request.payload.request_id, session_id: id, outcome: 'replay-from-start', attachment_id: attachment, descriptor });
    this.receive('StreamBegin', { session_id: id, incarnation, attachment_id: attachment, descriptor, kind: 'replay-from-start', cut: '0' });
    this.receive('StreamCaughtUp', { session_id: id, incarnation, attachment_id: attachment, sequence: '0' });
    await vi.waitFor(() => expect(this.sent.some(value => value.action === 'StreamApplied' && value.payload.id === id)).toBe(true));
    this.receive('AttachmentReady', { session_id: id, incarnation, attachment_id: attachment, sequence: '0' });
  }
}
const clients: PtyClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); resetAllEmulators(); vi.useRealTimers(); });
function fixture() {
  const sockets: Socket[] = [];
  const client = new PtyClient({ socket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  clients.push(client); return { client, sockets };
}
describe('public PTY client recovery', () => {
  it('identifies an explicitly selected legacy pane without creating or attaching it', async () => {
    const { client, sockets } = fixture(); sockets[0].open();
    const recovered = client.recoverLegacy({ id: 'legacy', durable: true, identity_status: 'unidentified', pane: '%7', root_pid: 123 });
    const request = sockets[0].sent.at(-1)!;
    expect(request).toMatchObject({ action: 'RecoverLegacy', payload: { id: 'legacy', pane: '%7', root_pid: 123 } });
    sockets[0].receive('RecoverLegacyResult', { request_id: request.payload.request_id, session_id: 'wrong', incarnation, error: null });
    const settled = vi.fn(); void recovered.then(settled, settled);
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    sockets[0].receive('RecoverLegacyResult', { request_id: request.payload.request_id, session_id: 'legacy', incarnation, error: null });
    await expect(recovered).resolves.toBe(incarnation);
    expect(sockets[0].sent.some(value => ['Create', 'Attach', 'Write'].includes(value.action))).toBe(false);
    expect(client.getAttachmentState('legacy')).toBeNull();
  });

  it('refuses unidentified or replaced recovery targets without an exact legacy observation', async () => {
    const { client, sockets } = fixture(); sockets[0].open();
    for (const target of [
      { id: 'legacy', durable: true },
      { id: 'legacy', durable: true, identity_status: 'replaced' as const, pane: '%1', root_pid: 1 },
      { id: 'legacy', durable: true, identity_status: 'unidentified' as const, pane: '%1', root_pid: 0 },
    ]) await expect(client.recoverLegacy(target)).rejects.toThrow(/exact.*legacy/i);
    expect(sockets[0].sent.some(value => value.action === 'RecoverLegacy')).toBe(false);
  });

  it('does not retry legacy identification whose reply was lost', async () => {
    vi.useFakeTimers(); const { client, sockets } = fixture(); sockets[0].open();
    const recovered = client.recoverLegacy({ id: 'legacy', durable: true, identity_status: 'unidentified', pane: '%7', root_pid: 123 });
    const outcome = recovered.catch(error => (error as Error).message);
    sockets[0].readyState = 3; sockets[0].onclose?.();
    await expect(outcome).resolves.toMatch(/unknown/i);
    await vi.advanceTimersByTimeAsync(2000); sockets[1].open();
    expect(sockets[1].sent.some(value => ['RecoverLegacy', 'Attach', 'Create'].includes(value.action))).toBe(false);
  });

  it('settles a forgotten unsent create without sending it after negotiation', async () => {
    const { client, sockets } = fixture();
    const created = client.createSession('forgotten', 80, 24);
    const settled = vi.fn(); void created.then(settled, settled);
    client.forgetSession('forgotten');
    await Promise.resolve();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/not sent/i) }));
    sockets[0].open();
    expect(sockets[0].sent.some(value => value.action === 'Create')).toBe(false);
  });

  it('does not resurrect a forgotten binding when its create result has just arrived', async () => {
    const { client, sockets } = fixture(); sockets[0].open();
    const changed = vi.fn(); client.onIncarnation(changed);
    const created = client.createSession('forgotten', 80, 24);
    const request = sockets[0].sent.find(value => value.action === 'Create')!;
    sockets[0].receive('CreateResult', { request_id: request.payload.request_id, session_id: 'forgotten', incarnation, error: null });
    // The result is received, but the promise continuation has not run yet.
    client.forgetSession('forgotten');
    const replacement = 'a'.repeat(32);
    client.bindExisting('forgotten', replacement);
    await expect(created).rejects.toThrow(/forgotten.*discover/i);
    expect(changed.mock.calls).toEqual([['forgotten', replacement]]);
    expect(sockets[0].attaches().map(value => value.payload.incarnation)).toEqual([replacement]);
    expect(sockets[0].sent.filter(value => value.action === 'Kill')).toEqual([]);
  });

  it('does not undo a subscriber forgetting a binding during its identity notification', () => {
    const { client } = fixture();
    client.onIncarnation(id => client.forgetSession(id));
    client.bindExisting('forgotten', incarnation);
    expect(client.getAttachmentState('forgotten')).toBeNull();
  });

  it('creates only an explicit new intent, correlates its incarnation, and then separately attaches', async () => {
    const { client, sockets } = fixture();
    const created = client.createSession('fresh', 90, 30, '/tmp');
    sockets[0].open();
    const request = sockets[0].sent.find(value => value.action === 'Create')!;
    expect(request.payload).toMatchObject({ id: 'fresh', cols: 90, rows: 30, cwd: '/tmp' });
    expect(sockets[0].attaches()).toEqual([]);
    sockets[0].receive('CreateResult', { request_id: request.payload.request_id, session_id: 'other', incarnation, error: null });
    expect(sockets[0].attaches()).toEqual([]);
    sockets[0].receive('CreateResult', { request_id: request.payload.request_id, session_id: 'fresh', incarnation, error: null });
    await expect(created).resolves.toBe(incarnation);
    await sockets[0].ready('fresh');
    expect(client.writeToSession('fresh', 'ready')).toBe(true);
    expect(sockets[0].sent.at(-1)).toMatchObject({ action: 'Write', payload: { id: 'fresh', incarnation, attachment_id: attachment, data: 'ready' } });
    expect(sockets[0].sent.some(value => value.action === 'Spawn')).toBe(false);
  });

  it('attaches every known background/parked identity with concurrency four, independent of focus', async () => {
    const { client, sockets } = fixture();
    for (let index = 0; index < 7; index++) client.bindExisting(`pane-${index}`, incarnation);
    client.setActiveSession('pane-6'); sockets[0].open();
    await vi.waitFor(() => expect(sockets[0].attaches()).toHaveLength(4));
    expect(sockets[0].sent.some(value => value.action === 'Create')).toBe(false);
    await sockets[0].ready('pane-0');
    await vi.waitFor(() => expect(sockets[0].attaches()).toHaveLength(5));
    expect(client.getSessionId()).toBe('pane-6');
    client.bindExisting('pane-0', incarnation);
    expect(sockets[0].attaches()).toHaveLength(5);
  });

  it('never queues typing or resends an accepted create after its reply is lost', async () => {
    vi.useFakeTimers(); const { client, sockets } = fixture(); sockets[0].open();
    const creation = client.createSession('uncertain', 80, 24);
    const result = creation.then(() => 'resolved', error => (error as Error).message);
    sockets[0].readyState = 3; sockets[0].onclose?.();
    expect(client.writeToSession('uncertain', 'OFFLINE')).toBe(false);
    await expect(result).resolves.toMatch(/unknown/i);
    await vi.advanceTimersByTimeAsync(2000); sockets[1].open();
    await vi.advanceTimersByTimeAsync(10000);
    expect(sockets[1].sent.filter(value => ['Create', 'Write', 'Spawn'].includes(value.action))).toEqual([]);
    expect(client.inputReadiness('uncertain')).toMatch(/unknown/i);
  });

  it('fences paste correlation to both ids and rejects uncertainty on disconnection without retry', async () => {
    const { client, sockets } = fixture(); client.bindExisting('paste', incarnation); sockets[0].open(); await sockets[0].ready('paste');
    const paste = client.pasteToSession('paste', 'text'); const settled = vi.fn(); void paste.then(settled, settled);
    const request = sockets[0].sent.at(-1)!;
    expect(request).toMatchObject({ action: 'Paste', payload: { id: 'paste', incarnation, attachment_id: attachment, text: 'text' } });
    sockets[0].receive('PasteResult', { request_id: request.payload.request_id, session_id: 'other', error: null });
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    sockets[0].readyState = 3; sockets[0].onclose?.();
    await expect(paste).rejects.toThrow(/unknown/i);
  });

  it('cannot let a captured clipboard identity silently target a newer controller', async () => {
    const { client, sockets } = fixture(); client.bindExisting('paste', incarnation); sockets[0].open(); await sockets[0].ready('paste');
    const permit = client.captureInputIdentity('paste');
    expect(permit).toMatchObject({ id: 'paste', incarnation, attachment_id: attachment });
    sockets[0].readyState = 3; sockets[0].onclose?.();
    await expect(client.pasteToSession('paste', 'late clipboard', permit)).rejects.toThrow(/changed|not ready|disconnected/i);
    expect(sockets[0].sent.some(value => value.action === 'Paste')).toBe(false);
  });
});
