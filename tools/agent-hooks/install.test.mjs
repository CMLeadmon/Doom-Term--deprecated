import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInstaller } from './install.mjs';
// The fixtures below are POSIX shell scripts and /usr/bin symlinks. What they
// pin is platform-independent; the way they pin it is not, and translating a
// `sh` fixture into `cmd` would test the translation. Linux CI is the gate for
// this behaviour — these are skipped on Windows, not quietly passing there.
const posixFixture =
  process.platform === 'win32'
    ? { skip: 'POSIX shell fixture; covered by the Linux CI job' }
    : {};


function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "doom-hook-test's-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claude = join(root, '.claude', 'settings.json');
  const codex = join(root, '.codex', 'hooks.json');
  for (const dir of ['.claude', '.codex']) mkdirSync(join(root, dir));
  return { root, claude, codex };
}

test('malformed existing vendor configuration aborts before any file is changed', t => {
  const { root, claude, codex } = fixture(t);
  const original = '{"theme":"dark","hooks":{}}\n';
  writeFileSync(claude, original);
  writeFileSync(codex, '{invalid');
  assert.throws(() => runInstaller({ root }), /invalid.*JSON|JSON.*invalid/i);
  assert.equal(readFileSync(claude, 'utf8'), original);
  assert.equal(readFileSync(codex, 'utf8'), '{invalid');
  assert.equal(existsSync(join(root, '.doom-term')), false);
  assert.equal(existsSync(`${claude}.doom-term-backup`), false);
});

test('unsupported hook shapes fail closed instead of erasing vendor settings', t => {
  const { root, claude } = fixture(t);
  for (const invalid of [[], null, { hooks: [] }, { hooks: { Stop: {} } }, { hooks: { Stop: [{ command: 'foreign' }] } }]) {
    const source = JSON.stringify(invalid);
    writeFileSync(claude, source);
    assert.throws(() => runInstaller({ root }), /configuration|hooks|object/i);
    assert.equal(readFileSync(claude, 'utf8'), source);
  }
});

test('install is additive and idempotent; removal preserves foreign and empty matcher groups', t => {
  const { root, claude } = fixture(t);
  const original = { theme: 'dark', hooks: { Stop: [
    { matcher: 'tool', hooks: [{ type: 'command', command: 'notify-me' }, { type: 'prompt', prompt: 'verify output' }] },
    { matcher: 'future', hooks: [] },
  ] } };
  writeFileSync(claude, JSON.stringify(original));
  runInstaller({ root });
  const installed = readFileSync(claude, 'utf8');
  runInstaller({ root });
  assert.equal(readFileSync(claude, 'utf8'), installed);
  const parsed = JSON.parse(installed);
  assert.deepEqual(parsed.hooks.Stop.slice(0, 2), original.hooks.Stop);
  assert.equal(parsed.hooks.Stop[2].hooks.length, 1);
  runInstaller({ root, remove: true });
  assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')), original);
  assert.deepEqual(JSON.parse(readFileSync(`${claude}.doom-term-backup`, 'utf8')), original);
});

test('installed command quotes a configuration root containing shell punctuation', posixFixture, t => {
  const { root, claude } = fixture(t);
  writeFileSync(claude, '{}');
  runInstaller({ root });
  const command = JSON.parse(readFileSync(claude, 'utf8')).hooks.Stop[0].hooks[0].command;
  // Exercise argv delivery without sending a real hook to any daemon.
  writeFileSync(join(root, '.doom-term/agent-hooks/doom-term-hook.sh'), '#!/bin/sh\nprintf "%s" "$1"\n');
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'claude');
});
