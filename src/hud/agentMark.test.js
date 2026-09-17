import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markSurface } from './agentMark.js';
import { MARKS } from './plate.js';

test('draws every known agent without throwing, whatever its arity', () => {
  // gemini, codex and opencode take no `dim` parameter; the rest do. Both are
  // passed regardless, exactly as the plate has always done.
  for (const key of Object.keys(MARKS)) {
    const s = markSurface(key, 24, undefined);
    assert.equal(s.w, 24);
    assert.ok(s.data.some((b) => b !== 0), `${key} drew nothing`);
  }
});

test('an unknown key draws the shell mark, never another vendor logo', () => {
  const unknown = markSurface('not-a-real-agent', 24, undefined);
  const shell = markSurface('shell', 24, undefined);
  assert.deepEqual([...unknown.data], [...shell.data]);
});

test('a working mark differs from a halted one', () => {
  const still = markSurface('claude', 24, undefined);
  const lit = markSurface('claude', 24, 0.5);
  assert.notDeepEqual([...still.data], [...lit.data]);
});

test('agy draws the same mark as antigravity, in the same colour', () => {
  assert.deepEqual(
    [...markSurface('agy', 24, undefined).data],
    [...markSurface('antigravity', 24, undefined).data],
  );
});
