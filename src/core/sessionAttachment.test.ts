import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionAttachment } from './sessionAttachment';
import { XtermScreen } from './xtermScreen';
import type { StreamDescriptor, StreamPayload } from './streamProtocol';

const descriptor: StreamDescriptor = { session_id: 'pane', incarnation: '1'.repeat(32), stream_epoch: '2'.repeat(32),
  clock_epoch: '3'.repeat(32), initial_cols: 40, initial_rows: 10, durable: true };
const token = '4'.repeat(32);
const identity = { session_id: 'pane', incarnation: descriptor.incarnation };
const bound = { ...identity, attachment_id: token };
const output = (data: string): StreamPayload => ({ type: 'Event', payload: { type: 'Output', payload: { data } } });
const screens: XtermScreen[] = [];
const attachments: SessionAttachment[] = [];
afterEach(() => { attachments.splice(0).forEach(value => value.dispose()); screens.splice(0).forEach(value => value.dispose()); vi.useRealTimers(); });
function fixture() {
  const sent: { action: string; payload: Record<string, unknown> }[] = [];
  const activity: string[] = [];
  const applied: string[] = [];
  const failed = vi.fn();
  const openScreen = vi.fn((meta: StreamDescriptor) => {
    const screen = new XtermScreen(meta.initial_cols, meta.initial_rows); screens.push(screen); return screen;
  });
  const attachment = new SessionAttachment(identity, {
    send: (action, payload) => { sent.push({ action, payload }); return true; }, openScreen,
    onActivity: record => activity.push(record.sequence), onRecord: record => applied.push(record.sequence),
    onFailure: failed,
  });
  attachments.push(attachment);
  const accept = (event: string, data: unknown) => attachment.accept(event, data);
  const result = (request_id = 'attach-1', outcome = 'replay-from-start', meta = descriptor, attachment_id = token) =>
    accept('AttachResult', { request_id, session_id: 'pane', outcome, descriptor: meta, attachment_id });
  const begin = (cut: string, kind = 'replay-from-start', meta = descriptor, attachment_id = token) =>
    accept('StreamBegin', { ...bound, attachment_id, descriptor: meta, kind, cut });
  const record = (sequence: string, payload: StreamPayload, phase = 'catch-up', attachment_id = token, meta = descriptor) =>
    accept('StreamRecord', { attachment_id, phase, record: { ...identity, stream_epoch: meta.stream_epoch, sequence, observed_micros: 0, payload } });
  const caughtUp = (sequence: string, attachment_id = token) => accept('StreamCaughtUp', { ...bound, attachment_id, sequence });
  const ready = (sequence: string, attachment_id = token) => accept('AttachmentReady', { ...bound, attachment_id, sequence });
  const ack = async () => { await vi.waitFor(() => expect(sent.some(value => value.action === 'StreamApplied')).toBe(true)); };
  const text = () => screens.at(-1)!.getLines().map(line => line.spans.map(span => span.text).join('').trimEnd()).join('\n');
  return { attachment, sent, activity, applied, failed, openScreen, accept, result, begin, record, caughtUp, ready, ack, text };
}

describe('one exact session attachment', () => {
  it('cold replays at recorded geometry and gates input on parse-applied acknowledgement plus daemon readiness', async () => {
    const f = fixture();
    await f.attachment.attach('attach-1');
    expect(f.sent).toEqual([{ action: 'Attach', payload: { request_id: 'attach-1', id: 'pane', incarnation: descriptor.incarnation, resume: null } }]);
    expect(f.attachment.mutate('Write', { data: 'early' })).toBe(false);
    f.result();
    expect(f.openScreen).not.toHaveBeenCalled(); // An offer is not a parser reset.
    f.begin('1'); f.record('1', output('hello 三'));
    expect(f.text()).toBe('');
    f.caughtUp('1');
    expect(f.sent.some(value => value.action === 'StreamApplied')).toBe(false);
    await f.ack();
    expect(f.text()).toBe('hello 三');
    expect(f.activity).toEqual([]);
    expect(f.attachment.state.status).toBe('awaiting-ready');
    expect(f.attachment.mutate('Write', { data: 'still early' })).toBe(false);
    f.ready('1');
    expect(f.attachment.mutate('Write', { data: 'accepted' })).toBe(true);
    expect(f.sent.at(-1)).toEqual({ action: 'Write', payload: { id: 'pane', incarnation: descriptor.incarnation, attachment_id: token, data: 'accepted' } });
  });

  it('drains warm queued bytes, retains a split escape and never replays refused input', async () => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result(); f.begin('1');
    f.record('1', output('history\r\n\x1b[31')); f.caughtUp('1'); await f.ack(); f.ready('1');
    f.record('2', output('mRED'), 'live');
    f.attachment.disconnect();
    expect(f.attachment.mutate('Write', { data: 'OFFLINE' })).toBe(false);
    await f.attachment.attach('attach-2');
    expect(f.sent.at(-1)?.payload.resume).toEqual({ stream_epoch: descriptor.stream_epoch, after_sequence: '2' });
    const nextToken = '5'.repeat(32);
    f.result('attach-2', 'resume', descriptor, nextToken); f.begin('3', 'resume', descriptor, nextToken);
    f.record('3', output(' tail'), 'catch-up', nextToken); f.caughtUp('3', nextToken);
    await vi.waitFor(() => expect(f.sent.filter(value => value.action === 'StreamApplied')).toHaveLength(2));
    f.ready('3', nextToken);
    expect(f.text()).toBe('history\nRED tail');
    expect(f.openScreen).toHaveBeenCalledTimes(1);
    expect(f.sent.some(value => value.action === 'Write')).toBe(false);
    expect(f.attachment.state.status).toBe('ready');
  });

  it('ignores old attachment and request callbacks without resetting or changing the new controller', async () => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result(); f.begin('0'); f.caughtUp('0'); await f.ack();
    f.attachment.disconnect(); await f.attachment.attach('attach-2');
    expect(f.result()).toBe(false);
    const nextToken = '5'.repeat(32); f.result('attach-2', 'resume', descriptor, nextToken); f.begin('0', 'resume', descriptor, nextToken);
    expect(f.record('1', output('STALE'), 'live')).toBe(false);
    expect(f.ready('0')).toBe(false);
    expect(f.accept('StreamUnavailable', { ...bound })).toBe(false);
    f.caughtUp('0', nextToken);
    await vi.waitFor(() => expect(f.sent.filter(value => value.action === 'StreamApplied')).toHaveLength(2));
    f.ready('0', nextToken);
    expect(f.text()).toBe(''); expect(f.openScreen).toHaveBeenCalledTimes(1); expect(f.failed).not.toHaveBeenCalled();
  });

  it('acknowledges the captured cut even when later live records are already queued', async () => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result(); f.begin('1');
    f.record('1', output('catch-up')); f.caughtUp('1'); f.record('2', output(' LIVE'), 'live');
    await f.ack();
    expect(f.sent.find(value => value.action === 'StreamApplied')?.payload.sequence).toBe('1');
    await vi.waitFor(() => expect(f.applied).toEqual(['1', '2']));
    expect(f.activity).toEqual(['2']);
    f.ready('1'); expect(f.attachment.state.status).toBe('ready');
  });

  it('coalesces offline desired geometry without resizing the parser until an ordered record', async () => {
    const f = fixture();
    f.attachment.resize(80, 24); f.attachment.resize(90, 30);
    await f.attachment.attach('attach-1'); f.result(); f.begin('0'); f.caughtUp('0'); await f.ack();
    expect(f.sent.some(value => value.action === 'Resize')).toBe(false);
    const resize = vi.spyOn(screens.at(-1)!, 'resize'); f.ready('0');
    expect(f.sent.at(-1)).toMatchObject({ action: 'Resize', payload: { cols: 90, rows: 30 } });
    expect(resize).not.toHaveBeenCalled();
    f.record('1', { type: 'Resize', payload: { cols: 90, rows: 30 } }, 'live');
    await vi.waitFor(() => expect(resize).toHaveBeenCalledExactlyOnceWith(90, 30));
    f.attachment.resize(90, 30);
    expect(f.sent.filter(value => value.action === 'Resize')).toHaveLength(1);
  });

  it('keeps an unreconstructable process read-only but permits explicit lifecycle control', async () => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result('attach-1', 'unreconstructable');
    expect(f.openScreen).not.toHaveBeenCalled();
    expect(f.attachment.state.status).toBe('unreconstructable');
    expect(f.attachment.mutate('Write', { data: 'refused' })).toBe(false);
    expect(f.attachment.mutate('Kill', { request_id: 'kill' }, false)).toBe(true);
    expect(f.sent.at(-1)?.payload).toMatchObject({ id: 'pane', incarnation: descriptor.incarnation, attachment_id: token });
  });

  it.each(['missing', 'closed', 'replaced', 'busy', 'incompatible', 'failed'])('never falls back to Create on a %s outcome', async outcome => {
    const f = fixture(); await f.attachment.attach('attach-1');
    f.accept('AttachResult', { request_id: 'attach-1', session_id: 'pane', outcome, attachment_id: null, descriptor: null, exit_code: null });
    expect(f.attachment.state.status).toBe(outcome);
    expect(f.attachment.mutate('Kill', {}, false)).toBe(false);
    expect(f.sent).toHaveLength(1); expect(f.openScreen).not.toHaveBeenCalled();
  });

  it.each(['cut', 'early-ready', 'phase', 'descriptor'])('fails closed for an invalid %s transition', async defect => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result();
    if (defect === 'descriptor') f.begin('1', 'replay-from-start', { ...descriptor, clock_epoch: '6'.repeat(32) });
    else {
      f.begin('1');
      if (defect === 'cut') f.caughtUp('2');
      if (defect === 'early-ready') f.ready('1');
      if (defect === 'phase') f.record('1', output('wrong'), 'live');
    }
    expect(f.attachment.state.status).toBe('failed'); expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.attachment.mutate('Write', { data: 'refused' })).toBe(false);
    expect(f.sent.filter(value => value.action === 'StreamApplied')).toHaveLength(0);
  });

  it('revokes readiness on receipt of closure, before the parser callback, without losing the final record', async () => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result(); f.begin('0'); f.caughtUp('0'); await f.ack(); f.ready('0');
    f.record('1', { type: 'Closed', payload: { exit_code: 7 } }, 'live');
    expect(f.attachment.mutate('Write', { data: 'after close' })).toBe(false);
    await vi.waitFor(() => expect(f.applied).toEqual(['1']));
    expect(f.attachment.state).toMatchObject({ status: 'closed', exitCode: 7 });
  });

  it('does not acknowledge a parser completion after the owning socket disconnected', async () => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result(); f.begin('1');
    f.record('1', output('queued')); f.caughtUp('1'); f.attachment.disconnect();
    await vi.waitFor(() => expect(f.applied).toEqual(['1']));
    expect(f.sent.some(value => value.action === 'StreamApplied')).toBe(false);
    expect(f.attachment.state.status).toBe('disconnected');
  });

  it('bounds a stalled handshake and does not resend an uncertain attach', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.attachment.attach('attach-1');
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.attachment.state.status).toBe('failed'); expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.sent).toHaveLength(1);
  });

  it('freezes input immediately on a received forward gap, before asynchronous parsing catches it', async () => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result(); f.begin('0'); f.caughtUp('0'); await f.ack(); f.ready('0');
    f.record('2', output('GAPPED'), 'live');
    expect(f.attachment.mutate('Write', { data: 'unsafe' })).toBe(false);
    await vi.waitFor(() => expect(f.attachment.state.status).toBe('unreconstructable'));
    expect(f.text()).toBe('');
  });

  it('receives rebuilt history separately, with cached-budget accounting and no live parser side effects', async () => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result('attach-1', 'rebuild'); f.begin('1', 'rebuild');
    const capture = { ...bound, capture_id: '6'.repeat(32) };
    f.accept('HistoryBegin', { ...capture, cols: 80, rows: 24, bytes: 8, lines: 1, chunks: 1,
      history_at_limit: false, potentially_overlapping: true, potentially_incomplete: true });
    f.accept('HistoryChunk', { ...capture, ordinal: 0, data: '\x1b[31mOLD' });
    f.accept('HistoryComplete', { ...capture, bytes: 8, chunks: 1 });
    expect(f.attachment.history).toMatchObject({ status: 'complete', data: '\x1b[31mOLD' });
    expect(f.text()).toBe('');
    f.record('1', output('LIVE')); f.caughtUp('1'); await f.ack(); f.ready('1');
    expect(f.text()).toBe('LIVE');
    expect(screens.at(-1)!.getLines()[0].spans[0].fg).not.toBe('#cd0000');
  });

  it('does not authorize a generic input mutation through the read-only lifecycle path', async () => {
    const f = fixture(); await f.attachment.attach('attach-1'); f.result('attach-1', 'unreconstructable');
    expect(f.attachment.mutate('Write', { data: 'unsafe' }, false)).toBe(false);
  });
});
