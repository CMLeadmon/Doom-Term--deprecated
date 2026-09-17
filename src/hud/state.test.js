import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPlateState, plateScale, plateWidth } from './state.ts';
import { MARKS, DEFAULT_STATE, DEMO_STATE, FONT_BIG } from './plate.js';

test('no game character survives in the agent well', () => {
  assert.equal(MARKS.marine, undefined);
  assert.equal(MARKS.doom, undefined);
  assert.ok(typeof MARKS.shell === 'function', 'a plain shell still needs a mark');
});

test("the big font can actually draw '--', not just blank space", () => {
  // toPlateState returns '--' for an unknown percentage; if the display font
  // has no dash the slot renders empty, which reads as a value of nothing.
  assert.ok(FONT_BIG['-'], 'FONT_BIG needs a dash glyph');
  assert.notDeepEqual(FONT_BIG['-'], FONT_BIG[' '], 'a dash must not be blank');
});

test('the renderer default invents nothing', () => {
  assert.equal(DEFAULT_STATE.context, '--');
  assert.equal(DEFAULT_STATE.usage, '--');
  assert.equal(DEFAULT_STATE.agentName, '');
  assert.deepEqual(DEFAULT_STATE.table, []);
});

test('demo values still exist for the reference renderer', () => {
  assert.ok(DEMO_STATE.agentName.length > 0);
  assert.equal(DEMO_STATE.table.length, 4);
});

test('environment markers do not claim a verified security sandbox', () => {
  assert.equal(toPlateState({ isolation: 'sandbox' }).sandbox, 'CTNR');
  assert.equal(toPlateState({ isolation: 'worktree' }).sandbox, 'TREE');
  assert.equal(toPlateState({ isolation: 'host' }).sandbox, 'HOST');
  assert.equal(toPlateState({ isolation: 'sandbox' }).modeLabel, 'ENV');
  for (const label of ['CTNR', 'HOST', 'TREE', 'ASK', 'WAIT']) {
    for (const character of label) assert.ok(FONT_BIG[character], `${character} must be drawable`);
  }
});

test('percentages clamp and round to a 3-character field', () => {
  assert.equal(toPlateState({ contextUsed: 0.613 }).context, '61%');
  assert.equal(toPlateState({ contextUsed: 1.5 }).context, '99%');
  assert.equal(toPlateState({ contextUsed: -1 }).context, '0%');
});

test('branch truncates from the left so the leaf survives', () => {
  const s = toPlateState({ branch: 'feature/webgl-compositor-rewrite-phase-two' });
  assert.equal(s.branch.length, 24);
  assert.match(s.branch, /PHASE-TWO$/);
  assert.match(s.branch, /^··/);
});

test('an unknown percentage renders as dashes, never as a number', () => {
  const s = toPlateState({ agent: 'claude', agentName: 'CLAUDE CODE' });
  assert.equal(s.context, '--');
  assert.equal(s.usage, '--');
});

test('no counter table is drawn when nothing has been counted', () => {
  const s = toPlateState({ agent: 'claude' });
  assert.deepEqual(s.table, []);
});

test('a plain shell reports no agent name at all', () => {
  const s = toPlateState({ agent: 'shell', agentName: undefined });
  assert.equal(s.agentName, '');
});

test('isolation renders as a tier name, never invented as FULL', () => {
  assert.equal(toPlateState({ isolation: 'host' }).sandbox, 'HOST');
  assert.equal(toPlateState({ isolation: 'sandbox' }).sandbox, 'CTNR');
  assert.equal(toPlateState({}).sandbox, '--');
});

test('review banners never imply that the terminal approves agent actions', () => {
  assert.equal(toPlateState({ permissionMode: 'auto' }).modeIndicator, 'ASK');
  assert.equal(toPlateState({ permissionMode: 'yolo' }).modeIndicator, '--');
});

test('shell counters have no invented limits or unknown command counts', () => {
  const state = toPlateState({ shellMetrics: { lines: 12, errors: 0, active: 5, totalSessions: 2 } });
  assert.deepEqual(state.table, [['BUF', '12', '--'], ['CMD', '--', '--'], ['SES', '2', '--'], ['BAD', '0', '--']]);
});

test('scale is chosen for legibility, not for the largest that fits', () => {
  assert.equal(plateScale(1), 2);
  assert.equal(plateScale(2), 3, 'HiDPI gets a step up so the caps stay readable');
  assert.equal(Number.isInteger(plateScale(1)), true);
  // The old rule, floor(width / 480), made a 1920px window 4x — and therefore
  // gained no logical width at all, so the elastic centre could never grow.
  assert.notEqual(plateScale(1), 4);
});

test('HiDPI falls back to integer 2x when 3x would clip the status controls', () => {
  assert.equal(plateScale(2, 1280), 2);
  assert.equal(plateScale(2, 1440), 3);
});

test('logical width grows with the window instead of staying at 480', () => {
  assert.equal(plateWidth(1440, 2), 720);
  assert.equal(plateWidth(1920, 2), 960);
  assert.equal(plateWidth(2880, 3), 960);
});

test('logical width never drops below the reference plate', () => {
  // Under 480 the right group would collide with the centre panel.
  assert.equal(plateWidth(600, 2), 480);
  assert.equal(plateWidth(0, 2), 480);
});

test('logical width is always an integer — the geometry is integer pixels', () => {
  assert.equal(Number.isInteger(plateWidth(1337, 2)), true);
  assert.equal(Number.isInteger(plateWidth(1001, 3)), true);
});

test('a working row animates on its own evidence, not the focused session', () => {
  // `pulse` drives the agent MARK, and it is gated on the session you are
  // looking at. Reusing it for the rows would leave a background agent's glyph
  // frozen for as long as your own prompt sat idle — which is exactly when you
  // most want to see it moving. The rows get their own phase.
  const working = [{ sessionId: 'a', n: '1', name: 'BUSY', status: 'working', tag: 'CLAU' }];
  const state = toPlateState({ agentBusy: false, waiting: working }, 0.25);

  assert.equal(state.pulse, undefined, 'an idle focused agent must not pulse its mark');
  assert.equal(state.phase, 0.25, 'the rows still get a phase to animate on');
});

test('the row phase is withheld when nothing is actually working', () => {
  // Axiom 3 again: an animation is a claim that something is happening. With
  // no working row there is nothing to claim, and the loop should be able to
  // stop rather than idle at 60fps against an unchanging image.
  const quiet = [{ sessionId: 'a', n: '1', name: 'IDLE', status: 'quiet', tag: 'SH' }];
  assert.equal(toPlateState({ agentBusy: false, waiting: quiet }, 0.25).phase, undefined);
  assert.equal(toPlateState({ agentBusy: false, waiting: [] }, 0.25).phase, undefined);
});

test('a remote session names the remote in the ENV cell', () => {
  // It read HOST for every SSH session, which was true of the laptop and
  // useless about the machine the work was on.
  const state = toPlateState({ isolation: 'host', remoteHost: 'devbox' });
  assert.equal(state.modeIndicator, '@DEVBOX');
  assert.equal(state.modeLabel, 'ENV');
});

test('a local session still reports its isolation', () => {
  assert.equal(toPlateState({ isolation: 'host' }).modeIndicator, 'HOST');
  assert.equal(toPlateState({ isolation: 'worktree' }).modeIndicator, 'TREE');
  assert.equal(toPlateState({ isolation: 'sandbox' }).modeIndicator, 'CTNR');
});

test('a long remote host is truncated from the left, keeping what identifies it', () => {
  const state = toPlateState({ isolation: 'host', remoteHost: 'build-runner-eu-west-2' });
  assert.ok(state.modeIndicator.length <= 8);
  assert.ok(state.modeIndicator.endsWith('WEST-2'));
});

test('a pending approval still outranks the remote host', () => {
  // WAIT is the one thing more urgent than which machine you are on.
  const state = toPlateState({ isolation: 'host', remoteHost: 'devbox', pendingApproval: true });
  assert.equal(state.modeIndicator, 'WAIT');
});
