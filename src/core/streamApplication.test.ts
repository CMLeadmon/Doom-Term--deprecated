import { afterEach, describe, expect, it, vi } from 'vitest';
import { XtermScreen } from './xtermScreen';
import { StreamApplication } from './streamApplication';
import type { StreamPayload, StreamRecord } from './streamProtocol';
import type { Terminal } from '@xterm/headless';

const descriptor = { session_id: 'pane', incarnation: '1'.repeat(32), stream_epoch: '2'.repeat(32),
  clock_epoch: '3'.repeat(32), initial_cols: 40, initial_rows: 10, durable: true };
const output = (data: string): StreamPayload => ({ type: 'Event', payload: { type: 'Output', payload: { data } } });
const record = (sequence: string, payload: StreamPayload, observed_micros = 0): StreamRecord => ({
  session_id: descriptor.session_id, incarnation: descriptor.incarnation, stream_epoch: descriptor.stream_epoch,
  sequence, observed_micros, payload,
});
const plain = (screen: XtermScreen) => screen.getLines().map(line => line.spans.map(span => span.text).join('').trimEnd());
const screens: XtermScreen[] = [];
function screen() { const value = new XtermScreen(40, 10); screens.push(value); return value; }
afterEach(() => { for (const screen of screens.splice(0)) screen.dispose(); vi.unstubAllGlobals(); });

describe('ordered stream application with real xterm', () => {
  it('acknowledges parse completion, never receipt or animation-frame painting', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const terminal = screen();
    const stream = new StreamApplication(descriptor, terminal);
    const applying = stream.apply(record('1', output('\x1b[31m三')), 'live');
    expect(stream.appliedSequence).toBe('0');
    await applying;
    expect(stream.appliedSequence).toBe('1');
    expect(plain(terminal)[0]).toBe('三');
    expect(terminal.getCursor()).toEqual({ row: 0, col: 2 });
  });

  it('drains queued records for warm resume without resetting split escapes, history or marks', async () => {
    const terminal = screen();
    const stream = new StreamApplication(descriptor, terminal);
    await stream.apply(record('1', output('earlier history\r\n')), 'live');
    const mark = terminal.mark();
    const pending = stream.apply(record('2', output('\x1b[31')), 'live');
    const cursor = stream.resumeCursor();
    await pending;
    expect(await cursor).toEqual({ stream_epoch: descriptor.stream_epoch, after_sequence: '2' });
    await stream.apply(record('3', output('mRED 🚀')), 'catch-up');
    expect(plain(terminal).slice(0, 2)).toEqual(['earlier history', 'RED 🚀']);
    expect(terminal.linesSince(mark)[0].spans[0].fg).toBeDefined();
    expect(terminal.getCursor()).toEqual({ row: 1, col: 6 });
  });

  it('drops duplicates before parsing, counters and activity, but applies unseen catch-up state', async () => {
    const terminal = screen();
    const activity: string[] = [];
    const applied: string[] = [];
    const stream = new StreamApplication(descriptor, terminal, {
      onRecord: record => applied.push(record.sequence),
      onActivity: record => activity.push(record.sequence),
    });
    await stream.apply(record('1', { type: 'Event', payload: { type: 'ExecutionStart' } }, 1000), 'live');
    const end = record('2', { type: 'Event', payload: { type: 'ExecutionEnd', payload: { exit_code: 7 } } }, 6500);
    await stream.apply(end, 'catch-up');
    expect(await stream.apply(end, 'live')).toBe('duplicate');
    expect(await stream.apply(record('1', output('duplicate text')), 'live')).toBe('duplicate');
    expect(plain(terminal)).toEqual(['']);
    expect(stream.state).toMatchObject({ completedCommands: 1, lastExecutionDurationMs: 5.5, lastExitCode: 7 });
    expect(applied).toEqual(['1', '2']);
    expect(activity).toEqual(['1']);
  });

  it('freezes a forward gap and invalidates derived history without applying the raw tail', async () => {
    const terminal = screen();
    const stream = new StreamApplication(descriptor, terminal);
    await stream.apply(record('1', output('valid')), 'live');
    await expect(stream.apply(record('3', output('GAPPED')), 'live')).rejects.toThrow(/gap/i);
    await expect(stream.apply(record('2', output('late')), 'live')).rejects.toThrow(/gap/i);
    await expect(stream.resumeCursor()).rejects.toThrow(/gap/i);
    expect(stream.appliedSequence).toBe('1');
    expect(stream.state.completedCommands).toBeNull();
    expect(plain(terminal)[0]).toBe('valid');
  });

  it('serializes resize and semantic marks after earlier output parsing', async () => {
    const terminal = screen();
    const marked: string[] = [];
    const stream = new StreamApplication(descriptor, terminal, {
      onRecord: record => { if (record.payload.type === 'Resize') marked.push(plain(terminal)[0]); },
    });
    await Promise.all([
      // Keep the pre-resize cursor inside the new width. xterm intentionally
      // clips its current cursor line on shrink; this tests ordering, not a
      // different reflow policy from the terminal implementation.
      stream.apply(record('1', output('AB')), 'catch-up'),
      stream.apply(record('2', { type: 'Resize', payload: { cols: 4, rows: 10 } }), 'catch-up'),
      stream.apply(record('3', output('CDE')), 'catch-up'),
    ]);
    expect(marked).toEqual(['AB']);
    expect(plain(terminal).slice(0, 2)).toEqual(['ABCD', 'E']);
    expect(stream.appliedSequence).toBe('3');
  });

  it('does not advance a disposed application from late parser callbacks', async () => {
    const terminal = screen();
    const applied: string[] = [];
    const stream = new StreamApplication(descriptor, terminal, { onRecord: record => applied.push(record.sequence) });
    const pending = stream.apply(record('1', output('late')), 'live');
    const rejected = expect(pending).rejects.toThrow(/disposed/i);
    await Promise.resolve(); // Submit to the real parser, but do not run its timer.
    expect(terminal.getPasteState().revision).toBeGreaterThan(0);
    stream.dispose();
    await rejected;
    expect(stream.appliedSequence).toBe('0');
    expect(applied).toEqual([]);
  });

  it('refuses further stream work after closure without counting a terminal close as a command', async () => {
    const terminal = screen();
    const stream = new StreamApplication(descriptor, terminal);
    await stream.apply(record('1', { type: 'Closed', payload: { exit_code: 9 } }), 'catch-up');
    expect(stream.state).toMatchObject({ closed: true, completedCommands: 0, lastExitCode: 9 });
    expect(await stream.apply(record('1', { type: 'Closed', payload: { exit_code: 9 } }), 'live')).toBe('duplicate');
    await expect(stream.apply(record('2', output('after exit')), 'live')).rejects.toThrow(/closed/i);
    expect(stream.appliedSequence).toBe('1');
    expect(plain(terminal)).toEqual(['']);
  });

  it('keeps rebuilt history and cross-clock durations unknown until both endpoints are observed', async () => {
    const stream = new StreamApplication({ ...descriptor, clock_epoch: '4'.repeat(32) }, screen(), { historyComplete: false });
    await stream.apply(record('1', { type: 'Event', payload: { type: 'ExecutionEnd', payload: { exit_code: null } } }, 900000), 'catch-up');
    expect(stream.state).toMatchObject({ completedCommands: null, lastExecutionDurationMs: null, lastExitCode: null });
    await stream.apply(record('2', { type: 'Event', payload: { type: 'ExecutionStart' } }, 901000), 'live');
    await stream.apply(record('3', { type: 'Event', payload: { type: 'ExecutionEnd', payload: { exit_code: 0 } } }, 902000), 'live');
    expect(stream.state).toMatchObject({ completedCommands: null, lastExecutionDurationMs: 1 });
  });

  it('bounds pending parse records by serialized bytes and freezes without applying an overflow tail', async () => {
    const terminal = screen();
    const stream = new StreamApplication(descriptor, terminal);
    const pending = Array.from({ length: 80 }, (_, index) => stream.apply(record(String(index + 1), output('x'.repeat(60000))), 'live'));
    const results = await Promise.allSettled(pending);
    expect(results.every(result => result.status === 'rejected' && /overflow/i.test(result.reason.message))).toBe(true);
    expect(stream.appliedSequence).toBe('0');
    expect(plain(terminal)).toEqual(['']);
  });

  it('bounds tiny queued events too, not only their payload bytes', async () => {
    const stream = new StreamApplication(descriptor, screen());
    const pending = Array.from({ length: 8193 }, (_, index) => stream.apply(record(String(index + 1), { type: 'Event', payload: { type: 'PromptStart' } }), 'live'));
    const results = await Promise.allSettled(pending);
    expect(results.every(result => result.status === 'rejected' && /overflow/i.test(result.reason.message))).toBe(true);
    expect(stream.appliedSequence).toBe('0');
  });

  it('copies queued input records and reports stable source identity for semantic projections', async () => {
    const terminal = screen();
    const contexts: unknown[] = [];
    const stream = new StreamApplication(descriptor, terminal, { onRecord: (_record, context) => contexts.push(context) });
    const input = record('1', output('original'), 123);
    const pending = stream.apply(input, 'catch-up');
    input.sequence = '9';
    input.payload = output('mutated');
    await pending;
    expect(plain(terminal)[0]).toBe('original');
    expect(contexts[0]).toMatchObject({ phase: 'catch-up', eventId: `${descriptor.incarnation}/${descriptor.stream_epoch}/1`,
      clockEpoch: descriptor.clock_epoch, observedMicros: 123 });
  });

  it('does not expose another incarnation or backward-clock bytes to the parser', async () => {
    for (const patch of [{ incarnation: '5'.repeat(32) }, { observed_micros: 10 }]) {
      const terminal = screen();
      const stream = new StreamApplication(descriptor, terminal);
      await stream.apply(record('1', output('valid'), 20), 'live');
      await expect(stream.apply({ ...record('2', output('invalid'), 30), ...patch }, 'live')).rejects.toThrow();
      expect(plain(terminal)[0]).toBe('valid');
      expect(stream.appliedSequence).toBe('1');
    }
  });

  it('preserves more than 500 records, history, marks and rendered cells across a warm cut', async () => {
    const terminal = screen();
    const control = screen();
    const stream = new StreamApplication(descriptor, terminal);
    await stream.apply(record('1', output('warm history\r\n')), 'live');
    const mark = terminal.mark();
    const bytes = Array.from({ length: 600 }, (_, index) => `\x1b[3${index % 7}mrow ${index} 三🚀\r\n`);
    await control.writeAndWait('warm history\r\n' + bytes.join(''));
    for (const [offset, phase] of [[0, 'live'], [300, 'catch-up']] as const) {
      await Promise.all(bytes.slice(offset, offset + 300).map((data, index) => stream.apply(record(String(offset + index + 2), output(data)), phase)));
      expect(await stream.resumeCursor()).toEqual({ stream_epoch: descriptor.stream_epoch, after_sequence: String(offset + 301) });
    }
    expect(await stream.apply(record('1', output('duplicate')), 'live')).toBe('duplicate');
    expect(terminal.getLines().map(line => ({ spans: line.spans, wrapped: line.isWrapped })))
      .toEqual(control.getLines().map(line => ({ spans: line.spans, wrapped: line.isWrapped })));
    expect(terminal.getCursor()).toEqual(control.getCursor());
    expect(plain(terminal)[0]).toBe('warm history');
    expect(terminal.linesSince(mark)[0].spans.map(span => span.text).join('').trimEnd()).toBe('row 0 三🚀');
  // 30s, not the 5s default. This drives 600 wide-character rows through a
  // real headless xterm TWICE — once live, once as catch-up — and compares
  // every rendered cell. It takes ~1s on Linux and comfortably over 5s on a
  // Windows runner, so the default timeout failed it there for being slow
  // rather than wrong. Raised here alone: a global bump would hide a real
  // hang in the other 665 tests.
  }, 30_000);

  it('restores semantic state in order while withholding catch-up activity effects', async () => {
    const activity: string[] = [];
    const stream = new StreamApplication(descriptor, screen(), { onActivity: record => activity.push(record.sequence) });
    await stream.apply(record('1', { type: 'Event', payload: { type: 'Cwd', payload: { path: '/work' } } }), 'catch-up');
    await stream.apply(record('2', { type: 'Event', payload: { type: 'AgentState', payload: { state: 'waiting_input' } } }), 'catch-up');
    await stream.apply(record('3', { type: 'Event', payload: { type: 'TuiMode', payload: { active: true } } }), 'catch-up');
    await stream.apply(record('4', { type: 'Event', payload: { type: 'PromptStart' } }), 'catch-up');
    expect(stream.state).toMatchObject({ cwd: '/work', agentState: 'waiting_input', isTuiActive: true, atPrompt: true });
    expect(activity).toEqual([]);
    await stream.apply(record('5', { type: 'Event', payload: { type: 'ExecutionStart' } }), 'live');
    expect(stream.state.atPrompt).toBe(false);
    expect(activity).toEqual(['5']);
  });

  it('bounds the whole reconnect drain to five seconds, not five seconds per queued record', async () => {
    vi.useFakeTimers();
    const terminal = screen();
    const parser = (terminal as unknown as { term: Terminal }).term.parser as unknown as {
      registerOscHandler(id: number, handler: () => Promise<boolean>): { dispose(): void };
    };
    // Both records take three seconds in the real async parser. Individually
    // legal writes must not turn a reconnect's five-second drain into six.
    let parsing = 0;
    const handler = parser.registerOscHandler(777, () => {
      parsing++;
      return new Promise(resolve => setTimeout(() => resolve(true), 3000));
    });
    try {
      const stream = new StreamApplication(descriptor, terminal);
      const first = stream.apply(record('1', output('\x1b]777;wait\x07one')), 'live');
      const second = stream.apply(record('2', output('\x1b]777;wait\x07two')), 'live');
      const drain = stream.resumeCursor();
      let drainError: Error | null = null;
      void drain.catch(error => { drainError = error; });
      const secondResult = second.then(() => null, error => error as Error);
      await vi.advanceTimersByTimeAsync(0);
      expect(parsing).toBe(1);
      // xterm resumes a long async handler on a subsequent timer turn.
      await vi.advanceTimersByTimeAsync(3005);
      await first;
      expect(stream.appliedSequence).toBe('1');
      await vi.advanceTimersByTimeAsync(1995);
      expect((drainError as Error | null)?.message ?? '').toMatch(/drain.*timed out/i);
      await vi.advanceTimersByTimeAsync(1010);
      expect((await secondResult)?.message).toMatch(/drain.*timed out/i);
      expect(stream.appliedSequence).toBe('1');
    } finally { handler.dispose(); vi.useRealTimers(); }
  });

  it('cannot acknowledge semantic or resize records against a disposed screen', async () => {
    for (const payload of [
      { type: 'Resize', payload: { cols: 20, rows: 10 } },
      { type: 'Event', payload: { type: 'ExecutionStart' } },
    ] as StreamPayload[]) {
      const terminal = screen();
      const stream = new StreamApplication(descriptor, terminal);
      terminal.dispose();
      await expect(stream.apply(record('1', payload), 'live')).rejects.toThrow(/disposed/i);
      expect(stream.appliedSequence).toBe('0');
    }
  });

  it('does not dispatch activity after a semantic projection disposes its application', async () => {
    const activity: string[] = [];
    const stream = new StreamApplication(descriptor, screen(), {
      onRecord: () => stream.dispose(),
      onActivity: record => activity.push(record.sequence),
    });
    await expect(stream.apply(record('1', { type: 'Event', payload: { type: 'ExecutionStart' } }), 'live')).rejects.toThrow(/disposed/i);
    expect(activity).toEqual([]);
    expect(stream.appliedSequence).toBe('0');
  });
});
