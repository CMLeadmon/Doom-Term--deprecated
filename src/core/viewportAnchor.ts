import type { AnsiLine } from '../types/terminal';

/**
 * Where the reader is, stated as a LINE rather than a pixel.
 *
 * A pixel offset cannot survive a buffer whose rows are deleted from the top
 * while new ones arrive at the bottom — and the correction that used to defend
 * one never executed. `getLines()` always calls `linesFrom(buffer, 0, ...)`, so
 * `lines[0].row` was always 0, so the trimmed delta was always `0 - 0`. Sixty
 * lines of compensation in `RawTerminalView` passed their unit test only
 * because it hand-fed a first row `getLines()` cannot produce.
 *
 * An absolute line number needs no correction at all: row N is still row N
 * after the rows above it are gone.
 */
export type ViewportAnchor =
  | { readonly mode: 'tail' }
  | { readonly mode: 'row'; readonly id: string; readonly offsetPx: number };

/** Following the newest output. The resting state. */
export const TAIL: ViewportAnchor = Object.freeze({ mode: 'tail' as const });

/** `offsetPx` is the anchored line's distance from the top of the viewport. */
export function anchorAt(id: string, offsetPx: number): ViewportAnchor {
  return Object.freeze({ mode: 'row' as const, id, offsetPx });
}

/**
 * The absolute line number an id names, or null when the id is not one of ours.
 *
 * Null rather than a guess. An id minted by something else names a line this
 * function cannot locate, and returning 0 would silently anchor the reader to
 * the top of the buffer — which looks exactly like the bug this replaces.
 */
export function absoluteOf(id: string): number | null {
  if (!id.startsWith('L') || id.length < 2) return null;
  const digits = id.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits);
}

/**
 * The anchored line's index in `lines`, or null when it is not in the window.
 *
 * Arithmetic, not a scan: ids are consecutive, so the first line's number and
 * the anchor's number give the offset directly. A linear search here would run
 * over five thousand rows on every frame of a streaming agent.
 */
export function indexOfAnchor(anchor: ViewportAnchor, lines: readonly AnsiLine[]): number | null {
  if (anchor.mode === 'tail' || lines.length === 0) return null;
  const first = absoluteOf(lines[0].id);
  const want = absoluteOf(anchor.id);
  if (first === null || want === null) return null;
  const index = want - first;
  return index >= 0 && index < lines.length ? index : null;
}

/** Time constant, ms. One 60Hz frame closes about an eighth of the distance. */
const EASE_TAU_MS = 120;

/** Below this the remainder is under a pixel; snap rather than crawl. */
const SNAP_PX = 0.5;

/**
 * One frame of exponential easing toward `target`.
 *
 * Frame-rate independent — the step comes from elapsed milliseconds, so a
 * dropped frame is a longer step rather than a slower scroll. Snaps inside half
 * a pixel so the loop terminates instead of approaching forever.
 */
export function easeScroll(current: number, target: number, dtMs: number, reduced = false): number {
  if (reduced) return target;
  const remaining = target - current;
  if (Math.abs(remaining) <= SNAP_PX) return target;
  return current + remaining * (1 - Math.exp(-dtMs / EASE_TAU_MS));
}
