import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPlateState, pulsePhase, PULSE_PERIOD_MS } from './state.ts';
import { MARKS, AGENT_COLORS, markTones, renderPlate, PLATE_480 } from './plate.js';

/** The 24x24 agent well, as RGBA bytes, for one plate state. */
function wellPixels(state) {
  const s = renderPlate(state, 1, PLATE_480);
  const out = [];
  for (let y = 4; y < 28; y++) {
    for (let x = PLATE_480.markX; x < PLATE_480.markX + PLATE_480.markW; x++) {
      const d = (y * s.w + x) * 4;
      out.push(s.data[d], s.data[d + 1], s.data[d + 2]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- identity

test('no agent draws another vendor mark', () => {
  // agy resolved to the `gemini` key and MARKS.agy was an alias of MARKS.claude,
  // so Antigravity drew Anthropic's burst. Each product gets its own drawing.
  assert.notEqual(MARKS.antigravity, MARKS.claude);
  assert.notEqual(MARKS.antigravity, MARKS.gemini);
  assert.notEqual(MARKS.aider, MARKS.claude);
  assert.equal(MARKS.agy, MARKS.antigravity, 'agy and antigravity are one product');
});

test('every agent has its own colour, and none of them is Claude copper', () => {
  const copper = AGENT_COLORS.claude;
  for (const key of ['codex', 'gemini', 'antigravity', 'grok', 'copilot', 'opencode']) {
    assert.ok(AGENT_COLORS[key], `${key} needs a colour`);
    assert.notEqual(AGENT_COLORS[key], copper, `${key} must not be painted in Claude's colour`);
  }
});

test('antigravity is drawn in its own colour, not the one before it', () => {
  const agy = wellPixels({ agent: 'antigravity' });
  const claude = wellPixels({ agent: 'claude' });
  const gemini = wellPixels({ agent: 'gemini' });
  assert.notDeepEqual(agy, claude);
  assert.notDeepEqual(agy, gemini);
});

test('an unknown agent falls back to the shell mark rather than a borrowed logo', () => {
  const unknown = wellPixels({ agent: 'not-a-real-agent' });
  const shell = wellPixels({ agent: 'shell' });
  assert.deepEqual(unknown, shell);
});

// ---------------------------------------------------------------- the pulse

test('a halted agent is drawn still', () => {
  // The same state twice must produce identical pixels: an indicator that never
  // stops moving cannot report that the agent stopped.
  const a = wellPixels({ agent: 'claude' });
  const b = wellPixels({ agent: 'claude' });
  assert.deepEqual(a, b);
  assert.equal(markTones('claude', undefined).ring, null, 'no ring when halted');
});

test('a working agent is drawn differently at different points in the cycle', () => {
  const trough = wellPixels({ agent: 'claude', pulse: 0 });
  const peak = wellPixels({ agent: 'claude', pulse: 0.5 });
  const mid = wellPixels({ agent: 'claude', pulse: 0.25 });
  assert.notDeepEqual(trough, peak);
  assert.notDeepEqual(trough, mid);
  assert.notDeepEqual(peak, mid);
});

test('working is visibly different from halted', () => {
  assert.notDeepEqual(wellPixels({ agent: 'claude', pulse: 0.5 }), wellPixels({ agent: 'claude' }));
});

test('the mark brightens towards the peak and dims towards the trough', () => {
  const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  const base = lum(markTones('claude', undefined).core);
  assert.ok(lum(markTones('claude', 0.5).core) > base, 'peak is brighter than steady');
  assert.ok(lum(markTones('claude', 0).core) < base, 'trough is darker than steady');
});

test('the cycle is continuous — the end of one phase meets the start of the next', () => {
  const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  // A raised cosine, so 0 and 1 are the same point. A discontinuity here would
  // show as a hitch once per cycle.
  assert.ok(Math.abs(lum(markTones('claude', 0.999).core) - lum(markTones('claude', 0).core)) < 4);
});

test('the pulse runs at twice a second', () => {
  assert.equal(PULSE_PERIOD_MS, 500);
  assert.equal(pulsePhase(0), 0);
  assert.equal(pulsePhase(250), 0.5);
  assert.equal(pulsePhase(500), 0, 'wraps at the period');
  assert.equal(pulsePhase(1000), 0, 'and stays in phase a second later');
});

test('plate state pulses only while the agent is busy', () => {
  assert.equal(toPlateState({ agent: 'claude', agentBusy: true }, 0.5).pulse, 0.5);
  assert.equal(toPlateState({ agent: 'claude', agentBusy: false }, 0.5).pulse, undefined);
  assert.equal(toPlateState({ agent: 'claude' }, 0.5).pulse, undefined, 'unknown is not busy');
});

/** Marks that stand in for a plain shell, which correctly has no vendor colour. */
const SHELL_ALIASES = new Set(['shell', 'terminal', 'bash', 'zsh', 'fish', 'none']);

test('every vendor mark has a vendor colour, so none falls back to the shell tan', () => {
  for (const key of Object.keys(MARKS)) {
    if (SHELL_ALIASES.has(key)) continue;
    assert.ok(
      AGENT_COLORS[key],
      `${key} draws a vendor mark but has no vendor colour, so markTones falls back to C.tan`,
    );
  }
});

test('agy and antigravity are one product, and one colour', () => {
  // MARKS.agy = MARKS.antigravity has been true since agy was added; the colour
  // table never followed, so an agy session drew the prism in the shell's tan.
  assert.equal(AGENT_COLORS.agy, AGENT_COLORS.antigravity);
});
