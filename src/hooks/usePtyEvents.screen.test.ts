import { describe, it, expect } from 'vitest';
import { applyScreenToNode, advanceReportedTuiState, resolveTuiState } from './usePtyEvents';
import type { StreamRecord } from '../core/streamProtocol';
import type { SessionNode } from '../types/sessionTree';
import type { AnsiLine } from '../types/terminal';

const LINES: AnsiLine[] = [
  { id: '0', spans: [{ text: '$ echo hello' }], isError: false, timestamp: 0 },
  { id: '1', spans: [{ text: 'hello' }], isError: false, timestamp: 0 },
];

const node = (over: Partial<SessionNode> = {}): SessionNode => ({
  id: 'n', groupId: 'g', title: 'T', number: 1, kind: 'terminal', cwd: '/x',
  gitBranch: '', activeBlockId: null, isTuiActive: false, agentState: 'idle',
  tuiLines: [], commandHistory: [], createdAt: 0, ...over,
});

describe('applyScreenToNode', () => {
  /*
   * The regression this exists for.
   *
   * Output used to be routed two ways: the screen's own grid for an alt-screen
   * program or an inline agent, and a re-read slice of scrollback for anything
   * else, because "anything else" was drawn by the block editor. Deleting the
   * block editor left that branch feeding a view that no longer existed, so a
   * plain shell rendered a completely blank terminal. Caught in the browser,
   * not by any unit test — which is why this one is here.
   */
  it('feeds the screen to a plain shell — there is only one view now', () => {
    const n = applyScreenToNode(node({ isTuiActive: false, foregroundAgent: null }), LINES, false);
    expect(n.tuiLines).toEqual(LINES);
  });

  it('feeds the screen to a full-screen program', () => {
    expect(applyScreenToNode(node(), LINES, true).tuiLines).toEqual(LINES);
  });

  it('feeds the screen to an inline agent that never set alt-screen', () => {
    const n = applyScreenToNode(node({ foregroundAgent: 'claude' }), LINES, false);
    expect(n.tuiLines).toEqual(LINES);
  });

  it('records the alt-screen state it was told', () => {
    expect(applyScreenToNode(node(), LINES, true).isTuiActive).toBe(true);
    expect(applyScreenToNode(node({ isTuiActive: true }), LINES, false).isTuiActive).toBe(false);
  });

  it('does not mutate the node it was given', () => {
    const original = node();
    applyScreenToNode(original, LINES, true);
    expect(original.tuiLines).toEqual([]);
    expect(original.isTuiActive).toBe(false);
  });
});

describe('daemon TUI state lifetime', () => {
  const record = (streamEpoch: string, active?: boolean): StreamRecord => ({
    session_id: 'n', incarnation: '1'.repeat(32), stream_epoch: streamEpoch,
    sequence: '1', observed_micros: 1,
    payload: active === undefined
      ? { type: 'Event', payload: { type: 'PromptStart' } }
      : { type: 'Event', payload: { type: 'TuiMode', payload: { active } } },
  });

  it('does not carry a TUI observation across a reconstructed stream', () => {
    const old = advanceReportedTuiState(undefined, record('2'.repeat(32), true));
    expect(old.active).toBe(true);
    const rebuilt = advanceReportedTuiState(old, record('3'.repeat(32)));
    expect(rebuilt).toEqual({ stream: '1'.repeat(32) + '/' + '3'.repeat(32) });
  });

  // The daemon stops being able to see the alternate screen when tmux stops
  // answering. Holding the last report left a pane that had been full-screen
  // flagged that way for the life of the stream: no scrollback, and a wheel
  // with nowhere to go. Forgetting is what lets resolveTuiState fall back to
  // the emulator.
  it('forgets a stale TUI observation when the daemon says it can no longer see', () => {
    const epoch = '2'.repeat(32);
    const seen = advanceReportedTuiState(undefined, record(epoch, true));
    expect(seen.active).toBe(true);

    const unknown: StreamRecord = {
      session_id: 'n', incarnation: '1'.repeat(32), stream_epoch: epoch,
      sequence: '2', observed_micros: 2,
      payload: { type: 'Event', payload: { type: 'TuiModeUnknown' } },
    };
    const forgotten = advanceReportedTuiState(seen, unknown);
    expect(forgotten.active).toBeUndefined();
    expect(forgotten.stream).toBe(seen.stream);
    // Unknown must defer to the emulator rather than assert a state of its own.
    expect(resolveTuiState(false, forgotten.active)).toBe(false);
    expect(resolveTuiState(true, forgotten.active)).toBe(true);
  });

  it('keeps reporting after an unknown, so recovery is not one-way', () => {
    const epoch = '2'.repeat(32);
    const seen = advanceReportedTuiState(undefined, record(epoch, true));
    const forgotten = advanceReportedTuiState(seen, {
      session_id: 'n', incarnation: '1'.repeat(32), stream_epoch: epoch,
      sequence: '2', observed_micros: 2,
      payload: { type: 'Event', payload: { type: 'TuiModeUnknown' } },
    });
    const regained = advanceReportedTuiState(forgotten, record(epoch, false));
    expect(regained.active).toBe(false);
  });
});
