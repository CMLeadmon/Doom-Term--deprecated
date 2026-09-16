import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// The fixtures below are POSIX shell scripts and /usr/bin symlinks. What they
// pin is platform-independent; the way they pin it is not, and translating a
// `sh` fixture into `cmd` would test the translation. Linux CI is the gate for
// this behaviour — these are skipped on Windows, not quietly passing there.
const posixFixture =
  process.platform === 'win32'
    ? { skip: 'POSIX shell fixture; covered by the Linux CI job' }
    : {};


test('the desktop verification command cannot succeed without compiling the shell', posixFixture, () => {
  const dir = mkdtempSync(join(tmpdir(), 'doom-tauri-check-'));
  try {
    const cargo = join(dir, 'cargo');
    writeFileSync(cargo, '#!/bin/sh\necho "The system library dbus-1 required by crate libdbus-sys was not found." >&2\nexit 101\n');
    chmodSync(cargo, 0o700);
    const result = spawnSync(process.execPath, [resolve('tools/check-tauri.mjs')], {
      env: { ...process.env, PATH: dir }, encoding: 'utf8',
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /ENVIRONMENT BLOCK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
