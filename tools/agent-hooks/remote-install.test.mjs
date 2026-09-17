import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, statSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { installRemoteSnippet } from './install.mjs';

const withHome = (rc) => {
  const root = mkdtempSync(join(tmpdir(), 'doom-remote-'));
  writeFileSync(join(root, '.bashrc'), rc);
  return root;
};

test('installs additively without disturbing the user own config', () => {
  const root = withHome('# my own config\nexport EDITOR=vi\n');
  installRemoteSnippet({ root });
  const after = readFileSync(join(root, '.bashrc'), 'utf8');
  assert.ok(after.includes('# my own config'), "the user's own config was disturbed");
  assert.ok(after.includes('export EDITOR=vi'));
  assert.ok(after.includes('doom-term-hook'), 'the block is not tagged');
  assert.ok(after.includes('DOOM_TERM_BOOTSTRAPPED'));
});

test('is idempotent — a second install does not append a second copy', () => {
  const root = withHome('# mine\n');
  installRemoteSnippet({ root });
  const once = readFileSync(join(root, '.bashrc'), 'utf8');
  installRemoteSnippet({ root });
  const twice = readFileSync(join(root, '.bashrc'), 'utf8');
  assert.equal(
    twice.split('DOOM_TERM_BOOTSTRAPPED').length,
    once.split('DOOM_TERM_BOOTSTRAPPED').length,
  );
});

test('uninstalls exactly, leaving the user own config intact', () => {
  const root = withHome('# mine\nalias ll="ls -l"\n');
  installRemoteSnippet({ root });
  installRemoteSnippet({ root, remove: true });
  const after = readFileSync(join(root, '.bashrc'), 'utf8');
  assert.ok(after.includes('# mine'));
  assert.ok(after.includes('alias ll="ls -l"'));
  assert.ok(!after.includes('DOOM_TERM_BOOTSTRAPPED'), 'the block survived removal');
  assert.ok(!after.includes('doom-term-hook'));
});

test('leaves an rc file that does not exist alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'doom-remote-none-'));
  const results = installRemoteSnippet({ root });
  assert.ok(results.every((r) => !r.changed));
  assert.ok(!existsSync(join(root, '.bashrc')));
});

test('the shipped snippet matches the one the daemon generates', () => {
  // Two halves of one wire format. A drift means a remote emitting frames this
  // build cannot parse, silently. Asked of the compiler rather than scraped out
  // of the Rust source with a regex — that scrape corrupted the script once.
  const shipped = readFileSync(new URL('./doom-term-remote.sh', import.meta.url), 'utf8');
  // node --test does not necessarily inherit a shell's PATH, and rustup puts
  // cargo under CARGO_HOME. Resolve it rather than skip the check: a drift here
  // ships a snippet the daemon cannot parse.
  const cargo = [
    process.env.CARGO,
    join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', 'cargo'),
    'cargo',
  ].find((candidate) => candidate && (candidate === 'cargo' || existsSync(candidate)));
  const generated = execFileSync(
    cargo,
    ['run', '-q', '-p', 'doom-term-pty', '--example', 'remote-snippet'],
    // fileURLToPath, not .pathname: this repository's directory has a space in
    // it and .pathname percent-encodes it into a path that does not exist.
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' },
  );
  const body = shipped.split('\n').filter((l) => !l.startsWith('#') && l.trim()).join('\n');
  assert.equal(body.trim(), generated.trim(), 'shipped snippet drifted from the Rust source');
  assert.ok(body.includes('SetUserVar=doomterm='));
  assert.ok(body.includes('"v":1'), 'schema version drifted from remote.rs');
});

test('every interpolated value is JSON-escaped', () => {
  // A directory name may legally contain a double quote. Without escaping,
  // `cd 'legit","agent":"claude'` closes the JSON string and injects fields the
  // template never emits — and remote.rs's clean() passes them, because it only
  // rejects control characters.
  const shipped = readFileSync(new URL('./doom-term-remote.sh', import.meta.url), 'utf8');
  assert.ok(shipped.includes('__dq'), 'no escaping helper in the shipped snippet');
  for (const value of ['$PWD', '$USER', '$__db']) {
    assert.ok(
      shipped.includes(`__dq "${value}"`),
      `${value} is interpolated without escaping`,
    );
  }
});

// Creating a symlink on Windows needs developer mode or elevation.
test('a symlinked rc file is patched through, not replaced', { skip: process.platform === 'win32' }, () => {
  // rename(2) replaces the link, not its target, so a dotfiles-managed rc file
  // would be orphaned and silently re-linked away on the next apply.
  const store = mkdtempSync(join(tmpdir(), 'doom-dotfiles-'));
  const real = join(store, 'bashrc');
  writeFileSync(real, '# managed elsewhere\n');
  const root = mkdtempSync(join(tmpdir(), 'doom-remote-link-'));
  symlinkSync(real, join(root, '.bashrc'));

  installRemoteSnippet({ root });
  assert.ok(lstatSync(join(root, '.bashrc')).isSymbolicLink(), 'the symlink was replaced');
  assert.ok(readFileSync(real, 'utf8').includes('DOOM_TERM_BOOTSTRAPPED'),
    'the real file was never patched');
});

// POSIX permission bits only. Windows' chmod toggles a read-only flag and
// nothing else, and this route targets remote Linux hosts anyway.
test('the rc file keeps its own permissions', { skip: process.platform === 'win32' }, () => {
  // These files routinely carry exported tokens, and this route targets shared
  // hosts. Widening 0600 to 0644 exposes them to every other local user.
  const root = mkdtempSync(join(tmpdir(), 'doom-remote-mode-'));
  const rc = join(root, '.bashrc');
  writeFileSync(rc, '# mine\n');
  chmodSync(rc, 0o600);
  installRemoteSnippet({ root });
  assert.equal(statSync(rc).mode & 0o777, 0o600);
});
