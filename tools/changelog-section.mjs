#!/usr/bin/env node
/**
 * The CHANGELOG section for one version, as release notes.
 *
 * `releaseBody` used to be a hardcoded empty string, so every release shipped
 * with no notes at all — the changelog existed and the release did not use it.
 *
 * This FAILS CLOSED. A tag with no matching changelog section exits non-zero
 * and takes the release job with it, because publishing a build whose changes
 * nobody wrote down is worse than not publishing: the assets are the part users
 * cannot reconstruct for themselves, and the notes are the part that tells them
 * what they are installing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Everything between this version's heading and the next `##` heading.
 *
 * Link-reference definitions at the foot of the file (`[0.2.0]: https://...`)
 * start with `[`, not `#`, so they would be swept into the last section. They
 * are dropped explicitly rather than by relying on a version never being last.
 */
export function sectionFor(markdown, version) {
  const lines = String(markdown).split('\n');
  const heading = new RegExp(`^##\\s+\\[?${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const body = lines
    .slice(start + 1, end)
    .filter((line) => !/^\[[^\]]+\]:\s+https?:\/\//.test(line))
    .join('\n')
    .trim();

  return body.length > 0 ? body : null;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const version = process.argv[2];
  if (!version) {
    console.error('usage: changelog-section.mjs <version>   # e.g. 0.2.0');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const section = sectionFor(changelog, version);
  if (!section) {
    console.error(
      `CHANGELOG.md has no non-empty section for ${version}. ` +
        'Write the entry before tagging; a release with no notes is not a release.'
    );
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
