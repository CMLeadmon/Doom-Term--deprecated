import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DAEMON_PORT, daemonPort } from './daemonPort';

type Injectable = { __DOOM_TERM_DAEMON_PORT__?: unknown };

function inject(value: unknown): void {
  (globalThis as Injectable).__DOOM_TERM_DAEMON_PORT__ = value;
}

afterEach(() => {
  delete (globalThis as Injectable).__DOOM_TERM_DAEMON_PORT__;
});

describe('daemonPort', () => {
  it('falls back to the default when the shell injected nothing', () => {
    expect(daemonPort()).toBe(DEFAULT_DAEMON_PORT);
  });

  it('uses the port the desktop shell injected', () => {
    inject(53124);
    expect(daemonPort()).toBe(53124);
  });

  // The injected value is the only thing standing between the frontend and the
  // stranger on the default port, so a malformed one must not silently become
  // a connection to something else. Anything that is not a usable port falls
  // back to the default rather than being coerced.
  it.each([
    ['a string', '1421'],
    ['zero', 0],
    ['negative', -1],
    ['out of range', 70000],
    ['fractional', 1421.5],
    ['NaN', Number.NaN],
    ['null', null],
  ])('ignores %s and uses the default', (_label, value) => {
    inject(value);
    expect(daemonPort()).toBe(DEFAULT_DAEMON_PORT);
  });
});
