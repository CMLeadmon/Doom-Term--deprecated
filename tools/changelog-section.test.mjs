import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionFor } from './changelog-section.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] — 2026-09-17

### Added

- A foreground witness on Windows.

### Known limitations

- Sessions do not survive a daemon restart on Windows.

## [0.1.0] — 2026-09-16

Initial pre-release.

[0.2.0]: https://github.com/CMLeadmon/Doom-Term/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CMLeadmon/Doom-Term/releases/tag/v0.1.0
`;

test('a version section stops at the next version heading', () => {
  const notes = sectionFor(CHANGELOG, '0.2.0');
  assert.match(notes, /A foreground witness on Windows/);
  assert.match(notes, /Known limitations/);
  assert.doesNotMatch(notes, /Initial pre-release/, 'must not run into 0.1.0');
  assert.doesNotMatch(notes, /^## /m, 'the version heading itself is not part of the notes');
});

test('link definitions at the foot of the file are not release notes', () => {
  // 0.1.0 is the last section, so everything after it — including the link
  // reference block — would otherwise be swept in.
  const notes = sectionFor(CHANGELOG, '0.1.0');
  assert.equal(notes, 'Initial pre-release.');
});

test('a missing version is null, not an empty string', () => {
  // The caller turns this into a non-zero exit. An empty string would read as
  // "there are no changes", which is a different and false claim.
  assert.equal(sectionFor(CHANGELOG, '9.9.9'), null);
});

test('a heading with no body is null rather than blank notes', () => {
  assert.equal(sectionFor(CHANGELOG, 'Unreleased'), null);
});

test('the version is matched literally, not as a pattern', () => {
  // '0.2.0' as a regex would also match '0x2y0'. Dots are escaped.
  const spoofed = CHANGELOG.replace('## [0.2.0] — 2026-09-17', '## [0x2y0] — 2026-09-17');
  assert.equal(sectionFor(spoofed, '0.2.0'), null);
});

test('a bare heading without brackets still resolves', () => {
  assert.match(sectionFor('## 1.2.3\n\nSomething happened.\n', '1.2.3'), /Something happened/);
});
