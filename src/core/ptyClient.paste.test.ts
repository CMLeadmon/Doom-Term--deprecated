import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { daemonFixture, TEST_INCARNATION } from '../test/daemonFixture';
import { resetAllEmulators } from './emulatorRegistry';

let fixture: ReturnType<typeof daemonFixture>;
beforeEach(() => { fixture = daemonFixture(); fixture.client.bindExisting('pane', TEST_INCARNATION); });
afterEach(() => { fixture.client.dispose(); resetAllEmulators(); vi.useRealTimers(); });
async function connect() {
  fixture.sockets[0].open(); await fixture.sockets[0].ready('pane');
  fixture.sockets[0].sent = []; return fixture.sockets[0];
}
it('refuses paste while offline or awaiting authentication without queueing it', async () => {
  await expect(fixture.client.pasteToSession('pane', 'offline')).rejects.toThrow(/connect|auth/i);
  fixture.sockets[0].openSocket();
  fixture.sockets[0].receive('AuthResult', { success: false });
  await expect(fixture.client.pasteToSession('pane', 'unauthorized')).rejects.toThrow(/connect|auth/i);
  fixture.sockets[0].receive('AuthResult', { success: true }); fixture.sockets[0].negotiate();
  expect(fixture.sockets[0].sent.some(request => request.action === 'Paste' || request.action === 'Write')).toBe(false);
});
it('sends plain clipboard text and resolves only matching request and session ids', async () => {
  const socket = await connect();
  const promise = fixture.client.pasteToSession('pane', "'三\rnext"); const seen = vi.fn(); void promise.then(seen, () => undefined);
  const request = socket.actions('Paste')[0];
  expect(request).toMatchObject({ action: 'Paste', payload: { request_id: expect.any(String), id: 'pane', text: "'三\rnext",
    incarnation: TEST_INCARNATION, attachment_id: socket.bound.get('pane')!.attachment_id } });
  socket.receive('PasteResult', { request_id: request.payload.request_id, session_id: 'other', error: null });
  socket.receive('PasteResult', { request_id: 'unknown', session_id: 'pane', error: null });
  await Promise.resolve(); expect(seen).not.toHaveBeenCalled();
  socket.receive('PasteResult', { request_id: request.payload.request_id, session_id: 'pane', error: null });
  await expect(promise).resolves.toBeUndefined();
});
it('reports child-side refusal without falling back to raw Write', async () => {
  const socket = await connect();
  const promise = fixture.client.pasteToSession('pane', 'one\ntwo');
  socket.receive('PasteResult', { request_id: socket.actions('Paste')[0].payload.request_id, session_id: 'pane',
    error: 'Multiline paste blocked: child mode disabled' });
  await expect(promise).rejects.toThrow(/Multiline paste blocked/);
  expect(socket.sent.map(request => request.action)).toEqual(['Paste']);
});
it('expires a lost result as unknown delivery and never retries', async () => {
  const socket = await connect(); vi.useFakeTimers();
  const promise = fixture.client.pasteToSession('pane', 'text');
  const result = promise.then(() => '', error => (error as Error).message);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await result).toMatch(/timed out.*unknown/i);
  socket.receive('PasteResult', { request_id: socket.actions('Paste')[0].payload.request_id, session_id: 'pane', error: null });
  expect(socket.sent.map(request => request.action)).toEqual(['Paste']);
});
it.each(['onclose', 'onerror'] as const)('rejects pending paste on %s and never replays it after reconnect', async event => {
  const socket = await connect(); vi.useFakeTimers();
  const promise = fixture.client.pasteToSession('pane', 'text');
  const result = promise.then(() => '', error => (error as Error).message);
  socket.readyState = 3; socket[event]?.();
  expect(await result).toMatch(/disconnect.*unknown/i);
  await vi.advanceTimersByTimeAsync(2000); fixture.sockets[1].open();
  expect(fixture.sockets[1].sent.some(request => request.action === 'Paste' || request.action === 'Write')).toBe(false);
});
it.each(['daemon', 'local'])('rejects pending paste when the %s confirms session closure', async owner => {
  const socket = await connect();
  const paste = fixture.client.pasteToSession('pane', 'text');
  const outcome = paste.then(() => '', error => (error as Error).message);
  const killing = owner === 'local' ? fixture.client.killSession('pane') : null;
  socket.record('pane', { type: 'Closed', payload: { exit_code: null } });
  expect(await outcome).toMatch(/closed.*unknown/i);
  if (killing) {
    socket.receive('KillResult', { request_id: socket.actions('Kill')[0].payload.request_id, session_id: 'pane', error: null });
    await expect(killing).resolves.toBe(true);
  }
  await expect(fixture.client.pasteToSession('pane', 'again')).rejects.toThrow(/closed|ready/i);
  expect(socket.actions('Paste')).toHaveLength(1);
});
it('rejects original UTF-8 input over 1 MiB before sending', async () => {
  const socket = await connect();
  await expect(fixture.client.pasteToSession('pane', '三'.repeat(350000))).rejects.toThrow(/1 MiB/);
  expect(socket.sent).toEqual([]);
});
