import { describe, it, expect } from 'vitest';
import { TAIL, anchorAt, absoluteOf, indexOfAnchor, easeScroll } from './viewportAnchor';
import type { AnsiLine } from '../types/terminal';

const line = (n: number): AnsiLine => ({
  id: `L${n}`, row: n, spans: [{ text: `${n}` }], timestamp: 0,
});

describe('viewportAnchor', () => {
  it('parses an absolute number out of an id', () => {
    expect(absoluteOf('L42')).toBe(42);
    expect(absoluteOf('L0')).toBe(0);
  });

  it('refuses an id it did not mint rather than guessing', () => {
    // Returning 0 for an unrecognised id would anchor the reader to the top of
    // the buffer, which is indistinguishable from the bug this replaces.
    expect(absoluteOf('row-42')).toBeNull();
    expect(absoluteOf('L')).toBeNull();
    expect(absoluteOf('Lx')).toBeNull();
    expect(absoluteOf('L-1')).toBeNull();
    expect(absoluteOf('')).toBeNull();
  });

  it('resolves an anchor to an index in O(1), not by scanning', () => {
    const lines = [line(10), line(11), line(12)];
    expect(indexOfAnchor(anchorAt('L11', 0), lines)).toBe(1);
    expect(indexOfAnchor(anchorAt('L10', 0), lines)).toBe(0);
    expect(indexOfAnchor(anchorAt('L12', 0), lines)).toBe(2);
  });

  it('holds the same index as the window slides, which is the whole point', () => {
    // Two lines trimmed: the window now begins at L12, and L13 is one row in
    // rather than three. A pixel offset could not express that.
    expect(indexOfAnchor(anchorAt('L13', 0), [line(10), line(11), line(12), line(13)])).toBe(3);
    expect(indexOfAnchor(anchorAt('L13', 0), [line(12), line(13), line(14), line(15)])).toBe(1);
  });

  it('returns null for a line that has been trimmed away', () => {
    const lines = [line(10), line(11), line(12)];
    expect(indexOfAnchor(anchorAt('L9', 0), lines)).toBeNull();
    expect(indexOfAnchor(anchorAt('L13', 0), lines)).toBeNull();
  });

  it('has no index for the tail — the tail is wherever the buffer ends', () => {
    expect(indexOfAnchor(TAIL, [line(10)])).toBeNull();
  });

  it('resolves nothing against an empty buffer', () => {
    expect(indexOfAnchor(anchorAt('L10', 0), [])).toBeNull();
  });

  it('eases toward a target and settles exactly, never asymptotically', () => {
    let at = 0;
    for (let i = 0; i < 200; i++) at = easeScroll(at, 100, 16);
    expect(at).toBe(100);
  });

  it('jumps straight to the target when motion is reduced', () => {
    expect(easeScroll(0, 100, 16, true)).toBe(100);
  });

  it('never overshoots, in either direction', () => {
    expect(easeScroll(0, 100, 16)).toBeLessThanOrEqual(100);
    expect(easeScroll(0, 100, 16)).toBeGreaterThan(0);
    expect(easeScroll(100, 0, 16)).toBeGreaterThanOrEqual(0);
    expect(easeScroll(100, 0, 16)).toBeLessThan(100);
  });

  it('takes a longer step for a longer frame, so a dropped frame does not slow it', () => {
    const short = easeScroll(0, 100, 16);
    const long = easeScroll(0, 100, 32);
    expect(long).toBeGreaterThan(short);
  });
});
