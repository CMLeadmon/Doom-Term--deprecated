import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  // Two halves of one wire format. If they drift, a remote instrumented by the
  // rc route emits a frame this build cannot parse — and says nothing about it.
  const shipped = readFileSync(new URL('./doom-term-remote.sh', import.meta.url), 'utf8');
  const rust = readFileSync(
    new URL('../../crates/doom-term-pty/src/shell_integration.rs', import.meta.url),
    'utf8',
  );
  const concat = rust.match(/pub fn remote_enrichment_snippet\(\)[\s\S]*?\.to_string\(\)/)[0];
  const parts = [...concat.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  // Unescape RUST string literals only — a single pass, so \\n stays the two
  // characters the shell needs rather than becoming a newline. The snippet is
  // full of shell escapes (tr -d '\n', printf '\033]...') that the REMOTE
  // shell interprets; converting them here would compare against a script that
  // could never work.
  const generated = parts.join('').replace(/\\(.)/g, (_, c) => (c === 'n' ? '\\n' : c));
  const shippedBody = shipped.split('\n').filter((l) => !l.startsWith('#') && l.trim()).join('\n');
  assert.ok(
    shippedBody.includes('SetUserVar=doomterm='),
    'the shipped snippet stopped emitting the frame',
  );
  assert.ok(shippedBody.includes('"v":1'), 'schema version drifted from remote.rs');
  assert.equal(shippedBody.trim(), generated.trim(), 'shipped snippet drifted from the Rust source');
});
