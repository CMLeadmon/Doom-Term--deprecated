import { describe, expect, it } from 'vitest';
import {
  reconcileSessions, sessionBinding, type RecoverableSession, type RecoveryState,
} from './sessionRecovery';

const live = (id: string): RecoverableSession => ({
  id, cwd: `/repo/${id}`, command: 'bash', durable: true, incarnation: '1'.repeat(32),
});
const stored = (id: string) => ({ id, incarnation: '1'.repeat(32) });

describe('reconcileSessions', () => {
  it('separates matches, daemon-only recoverables, and stored snapshots', () => {
    expect(reconcileSessions([stored('kept'), stored('snapshot')], [live('kept'), live('orphan')])).toEqual({
      matched: ['kept'],
      recoverable: [live('orphan')],
      snapshots: ['snapshot'],
    });
  });

  it('deduplicates daemon records by id without mutating input order', () => {
    const rows = [live('orphan'), { ...live('orphan'), command: 'codex' }];
    expect(reconcileSessions([], rows).recoverable).toEqual([live('orphan')]);
    expect(rows).toHaveLength(2);
  });

  it('does not promote legacy id-only storage into an exact process match', () => {
    expect(reconcileSessions(['legacy'], [live('legacy')])).toEqual({ matched: [], snapshots: ['legacy'], recoverable: [live('legacy')] });
  });
  it('preserves a snapshot and offers a replacement incarnation separately', () => {
    const replacement = { ...live('kept'), incarnation: '2'.repeat(32) };
    expect(reconcileSessions([stored('kept')], [replacement])).toEqual({ matched: [], snapshots: ['kept'], recoverable: [replacement] });
  });
  it('does not guess when discovery contains conflicting identities under one logical id', () => {
    const rows = [live('kept'), { ...live('kept'), incarnation: '2'.repeat(32) }];
    expect(reconcileSessions([stored('kept')], rows)).toEqual({ matched: [], snapshots: ['kept'], recoverable: rows });
  });
  it('keeps unidentified durable panes as explicit recovery choices', () => {
    const unknown = { ...live('old'), incarnation: null, identity_status: 'unidentified' as const };
    expect(reconcileSessions([stored('old')], [unknown])).toEqual({ matched: [], snapshots: ['old'], recoverable: [unknown] });
  });
  it('does not turn incomplete discovery into observed absence', () => {
    const state = reconcileSessions([stored('missing'), stored('known')], [live('known')], false);
    expect(state.matched).toEqual(['known']); expect(state.snapshots).toEqual([]);
    expect(sessionBinding('missing', true, true, state)).toBe('waiting');
  });
});

const NOTHING: RecoveryState = { matched: [], recoverable: [], snapshots: [] };

describe('cold startup with a stored active id', () => {
  it('does not bind a restored id before the daemon has been asked', () => {
    // The exact cold-start path. Spawn is attach-or-create, so handing a
    // restored id to it against an empty daemon created a FRESH shell under
    // that id — cached transcript lines with a new process behind them,
    // presented as a recovered session.
    expect(sessionBinding('stored', true, false, NOTHING)).toBe('waiting');
  });

  it('presents a restored id the empty daemon does not hold as a snapshot', () => {
    const state = reconcileSessions([stored('stored')], []);
    expect(state.snapshots).toEqual(['stored']);
    expect(sessionBinding('stored', true, true, state)).toBe('snapshot');
  });

  it('binds a restored id the daemon still holds', () => {
    const state = reconcileSessions([stored('stored')], [live('stored')]);
    expect(state.matched).toEqual(['stored']);
    expect(sessionBinding('stored', true, true, state)).toBe('ready');
  });

  it('never makes a session created in this run wait on recovery', () => {
    // A new terminal has no stored state to lose, and blocking it on a
    // round-trip would be a visible stall on Ctrl+Shift+T.
    expect(sessionBinding('fresh', false, false, NOTHING)).toBe('ready');
  });

  it('keeps waiting while the daemon is unreachable rather than spawning', () => {
    // listSessions rejects on a timeout, so `reconciled` stays false. Releasing
    // the id on failure would restore exactly the bug.
    expect(sessionBinding('stored', true, false, NOTHING)).not.toBe('ready');
  });
});
