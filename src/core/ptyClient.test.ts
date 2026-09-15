import { afterEach, describe, expect, it, vi } from 'vitest';
import { looksLikeAbsolutePath, type PtyClient } from './ptyClient';
import { getEmulator, resetAllEmulators } from './emulatorRegistry';
import { recoveryFixture, TEST_INCARNATION } from '../test/recoveryFixture';

const clients: PtyClient[] = [];
function fixture() { const result = recoveryFixture(); clients.push(result.client); return result; }
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); resetAllEmulators(); vi.useRealTimers(); });

describe('negotiated telemetry requests', () => {
  it('names the session on screen', () => {
    const { client, sockets } = fixture(); sockets[0].open(); client.setActiveSession('node-7');
    client.bindExisting('node-7', TEST_INCARNATION);
    client.requestTelemetry('/tmp/project');
    expect(sockets[0].sent.at(-1)).toEqual({ action: 'GetTelemetry', payload: { cwd: '/tmp/project', session_id: 'node-7', incarnation: TEST_INCARNATION } });
  });
  it('still names the session when no directory is given', () => {
    const { client, sockets } = fixture(); sockets[0].open(); client.setActiveSession('node-2'); client.requestTelemetry();
    expect(sockets[0].sent.at(-1)).toEqual({ action: 'GetTelemetry', payload: { cwd: null, session_id: 'node-2', incarnation: null } });
  });
  it('drops delayed telemetry for a forgotten or replaced process identity', () => {
    const { client, sockets } = fixture(); sockets[0].open(); client.bindExisting('pane', TEST_INCARNATION);
    const observed = vi.fn(); client.onTelemetry(observed);
    const reply = { session_id: 'pane', incarnation: TEST_INCARNATION, current_dir: '/fixture', rate_used: 0.4 };
    sockets[0].receive('Telemetry', reply);
    expect(observed).toHaveBeenCalledTimes(1);
    client.forgetSession('pane');
    sockets[0].receive('Telemetry', reply);
    client.bindExisting('pane', 'a'.repeat(32));
    sockets[0].receive('Telemetry', reply);
    sockets[0].receive('Telemetry', { ...reply, incarnation: null });
    expect(observed).toHaveBeenCalledTimes(1);
    sockets[0].receive('Telemetry', { ...reply, incarnation: 'a'.repeat(32) });
    expect(observed).toHaveBeenCalledTimes(2);
  });
  it('fences telemetry-unavailable notices to the exact current process', () => {
    const { client, sockets } = fixture(); sockets[0].open(); client.bindExisting('pane', TEST_INCARNATION);
    const unavailable = vi.fn(); client.onTelemetryUnavailable(unavailable);
    sockets[0].receive('TelemetryUnavailable', { session_id: 'pane', incarnation: null });
    sockets[0].receive('TelemetryUnavailable', { session_id: 'pane', incarnation: 'a'.repeat(32) });
    sockets[0].receive('TelemetryUnavailable', { session_id: 'other', incarnation: TEST_INCARNATION });
    expect(unavailable).not.toHaveBeenCalled();
    sockets[0].receive('TelemetryUnavailable', { session_id: 'pane', incarnation: TEST_INCARNATION });
    expect(unavailable).toHaveBeenCalledExactlyOnceWith('pane');
  });
});
describe('global stream routing', () => {
  it('restores a hook arriving before discovery only after its exact identity is bound', () => {
    const { client, sockets } = fixture(); sockets[0].open();
    const onAgentEvent = vi.fn(); client.registerHandler({ onOutput: () => undefined, onAgentEvent });
    const hook = { agent: 'claude', event: 'PermissionRequest', cwd: '/fixture', doom_session_id: 'late',
      incarnation: TEST_INCARNATION, event_id: 'c'.repeat(32), phase: 'catch-up' };
    sockets[0].receive('AgentEvent', hook);
    expect(onAgentEvent).not.toHaveBeenCalled();
    client.bindExisting('late', TEST_INCARNATION);
    expect(onAgentEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      doomSessionId: 'late', incarnation: TEST_INCARNATION, eventId: hook.event_id, phase: 'catch-up',
    }));
    sockets[0].receive('AgentEvent', hook);
    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    const mountedLater = vi.fn(); client.registerHandler({ onOutput: () => undefined, onAgentEvent: mountedLater });
    expect(mountedLater).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ eventId: hook.event_id, phase: 'catch-up' }));
  });
  it('does not let an unidentified or stale-process hook clear a current ask', async () => {
    const { client, sockets } = fixture(); client.bindExisting('pane', TEST_INCARNATION); sockets[0].open(); await sockets[0].ready('pane');
    const onAgentEvent = vi.fn(); client.registerHandler({ onOutput: () => undefined, onAgentEvent });
    const hook = { agent: 'claude', event: 'PermissionRequest', doom_session_id: 'pane', incarnation: TEST_INCARNATION,
      event_id: 'c'.repeat(32), phase: 'live' };
    sockets[0].receive('AgentEvent', hook);
    expect(onAgentEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phase: 'live' }));
    sockets[0].receive('AgentEvent', { ...hook, event: 'Stop', event_id: 'd'.repeat(32), incarnation: 'f'.repeat(32) });
    sockets[0].receive('AgentEvent', { ...hook, event: 'Stop', event_id: 'e'.repeat(32), incarnation: null });
    expect(onAgentEvent).toHaveBeenCalledTimes(1);
  });
  it('delivers a parsed background execution result with exact source identity', async () => {
    const { client, sockets } = fixture(); client.bindExisting('background', TEST_INCARNATION); client.setActiveSession('visible');
    sockets[0].open(); await sockets[0].ready('background');
    const seen: unknown[] = [];
    client.registerHandler({ onOutput: () => undefined, onStreamRecord: (record, context) => seen.push({ record, context }) });
    sockets[0].record('background', { type: 'Event', payload: { type: 'ExecutionEnd', payload: { exit_code: 9 } } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ record: { session_id: 'background', incarnation: TEST_INCARNATION },
      context: { phase: 'live', state: { lastExitCode: 9, lastExecutionDurationMs: null } } });
    expect(client.getSessionId()).toBe('visible');
  });
});
describe('selection is separate from creation and attachment', () => {
  it('uses a pane size measured before explicit creation', () => {
    const { client, sockets } = fixture();
    client.resizeSession('measured', 164, 43); client.ensureSession('measured', '/tmp/probe'); sockets[0].open();
    expect(sockets[0].actions('Create')[0]).toMatchObject({ payload: { id: 'measured', cols: 164, rows: 43, cwd: '/tmp/probe' } });
  });
  it('creates each new intent once and does not replay on selection', () => {
    const { client, sockets } = fixture(); sockets[0].open();
    client.ensureSession('A', '/repo/a'); client.ensureSession('B', '/repo/b'); client.ensureSession('A', '/repo/a');
    client.setActiveSession('A');
    expect(sockets[0].actions('Create').map(request => request.payload.id)).toEqual(['A', 'B']);
    expect(sockets[0].actions('Attach')).toEqual([]);
    expect(sockets[0].actions('Spawn')).toEqual([]);
  });
  it('does not move keyboard focus when binding a background identity', () => {
    const { client } = fixture(); client.setActiveSession('A');
    client.bindExisting('B', TEST_INCARNATION); client.ensureSession('C');
    expect(client.getSessionId()).toBe('A');
  });
  it('reattaches known identities after reconnect without creating or flushing input', async () => {
    const { client, sockets } = fixture();
    for (const id of ['background', 'parked', 'active']) client.bindExisting(id, TEST_INCARNATION);
    client.setActiveSession('active'); sockets[0].open();
    for (const id of ['background', 'parked', 'active']) await sockets[0].ready(id);
    vi.useFakeTimers(); sockets[0].drop();
    expect(client.writeToSession('background', 'OFFLINE')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000); sockets[1].open();
    await vi.waitFor(() => expect(sockets[1].actions('Attach')).toHaveLength(3));
    expect(sockets[1].actions('Attach').map(request => request.payload.id)).toEqual(['background', 'parked', 'active']);
    expect(sockets[1].actions('Create')).toEqual([]); expect(sockets[1].actions('Write')).toEqual([]);
    expect(client.getSessionId()).toBe('active');
  });
});
describe('session inventory correlation', () => {
  it('rejects a correlated directory failure instead of exposing an empty success', async () => {
    const { client, sockets } = fixture(); sockets[0].open();
    const pending = client.browseDirectory('/fixture');
    const check = expect(pending).rejects.toThrow('Directory unavailable');
    const request = sockets[0].actions('BrowseDirectory')[0];
    sockets[0].receive('DirectoryListing', { request_id: request.payload.request_id, current_path: '/fixture', entries: [], error: 'Directory unavailable', truncated: true });
    await check;
  });
  it('correlates a listing by request id without executing its reported command', async () => {
    const { client, sockets } = fixture(); sockets[0].open();
    const pending = client.listSessions(); const request = sockets[0].actions('ListSessions')[0];
    sockets[0].receive('SessionListing', { request_id: 'wrong', sessions: [] });
    sockets[0].receive('SessionListing', { request_id: request.payload.request_id,
      sessions: [{ id: 'orphan', incarnation: TEST_INCARNATION, cwd: '/repo', command: 'codex', durable: true }] });
    await expect(pending).resolves.toMatchObject({ sessions: [{ id: 'orphan' }] });
    expect(sockets[0].actions('Create')).toEqual([]); expect(sockets[0].actions('Attach')).toEqual([]);
  });
});
describe('explicit command submission', () => {
  async function ready() {
    const f = fixture(); f.client.bindExisting('pane', TEST_INCARNATION); f.sockets[0].open(); await f.sockets[0].ready('pane'); return f;
  }
  it('submits a single-line explicit command once without an echo retry timer', async () => {
    const { client, sockets } = await ready();
    expect(client.submitCommandToSession('pane', 'echo hi')).toBe(true);
    expect(sockets[0].actions('Write').map(request => request.payload.data)).toEqual(['echo hi\r']);
  });
  it('does not hold keystrokes behind a command delivery window', async () => {
    const { client, sockets } = await ready();
    client.submitCommandToSession('pane', 'ls'); client.writeToSession('pane', 'x'); client.writeToSession('pane', 'y');
    expect(sockets[0].actions('Write').map(request => request.payload.data)).toEqual(['ls\r', 'x', 'y']);
  });
  it('passes raw typing through a ready ownership fence', async () => {
    const { client, sockets } = await ready(); client.writeToSession('pane', 'plain');
    expect(sockets[0].actions('Write')[0]).toMatchObject({ payload: { data: 'plain', incarnation: TEST_INCARNATION, attachment_id: expect.any(String) } });
  });
  it('refuses multiline automatic submission instead of inventing a paste wrapper', async () => {
    const { client, sockets } = await ready();
    expect(client.submitCommandToSession('pane', 'one\ntwo')).toBe(false);
    expect(sockets[0].actions('Write')).toEqual([]); expect(sockets[0].actions('Paste')).toEqual([]);
  });
});
describe('looksLikeAbsolutePath', () => {
  it('recognises absolute and home-relative paths', () => {
    for (const path of ['/var/home/cleadmon/Projects/Doom Term', '~/Projects', '~']) expect(looksLikeAbsolutePath(path)).toBe(true);
  });
  it('treats bare words as filters', () => {
    for (const path of ['doom', '', 'Doom Term']) expect(looksLikeAbsolutePath(path)).toBe(false);
  });
  it('tolerates surrounding whitespace', () => {
    expect(looksLikeAbsolutePath('  /etc  ')).toBe(true); expect(looksLikeAbsolutePath('   ')).toBe(false);
  });
});
describe('screen lifetime and delayed sizing', () => {
  it('coalesces offline sizing and sends the latest only after readiness', async () => {
    const { client, sockets } = fixture(); client.bindExisting('pane', TEST_INCARNATION);
    client.resizeSession('pane', 114, 50); client.resizeSession('pane', 100, 40);
    expect(sockets[0].sent).toEqual([]); sockets[0].open(); await sockets[0].offer('pane');
    expect(sockets[0].actions('Resize')).toEqual([]); await sockets[0].caughtUp('pane');
    expect(sockets[0].actions('Resize')).toHaveLength(1);
    expect(sockets[0].actions('Resize')[0]).toMatchObject({ payload: { cols: 100, rows: 40 } });
  });
  it('rejects legacy metadata without erasing already-parsed startup output', async () => {
    const { client, sockets } = fixture(); client.bindExisting('pane', TEST_INCARNATION); sockets[0].open(); await sockets[0].ready('pane');
    sockets[0].record('pane', { type: 'Event', payload: { type: 'Output', payload: { data: 'startup banner\r\n$ ' } } });
    await vi.waitFor(() => expect(getEmulator('pane').getLines()[0].spans[0].text).toContain('startup banner'));
    sockets[0].receive('SessionMode', { session_id: 'pane', durable: true });
    expect(client.getIsConnected()).toBe(false);
    expect(getEmulator('pane').getLines()[0].spans[0].text).toContain('startup banner');
  });
  it('does not clear a cached screen merely because creation was requested or offered', async () => {
    const { client, sockets } = fixture(); const old = getEmulator('new');
    await old.writeAndWait('cached lines'); sockets[0].open();
    const creating = client.createSession('new', 80, 24);
    expect(getEmulator('new')).toBe(old); sockets[0].created('new'); await creating;
    expect(getEmulator('new')).toBe(old);
    await sockets[0].offer('new');
    expect(getEmulator('new')).not.toBe(old);
    expect(getEmulator('new').getLines()[0].spans.map(span => span.text).join('').trimEnd()).toBe('');
  });
});
