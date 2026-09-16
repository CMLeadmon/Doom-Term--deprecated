/**
 * Terminal cell geometry.
 *
 * Kept pure and separate from the DOM so every branch tests without a canvas —
 * jsdom has no 2D context at all. `measureCell` is the only part that touches
 * the document, and it degrades rather than throwing.
 */

export interface CellMetrics {
  width: number;
  height: number;
}

/**
 * A measurement, kept alongside the integer cell it was quantized into.
 *
 * The raw advance is not a curiosity: it is what the BROWSER will actually
 * advance per glyph, and the difference between it and the cell is what
 * `tracking` has to cancel. See there.
 */
export interface MeasuredCell extends CellMetrics {
  /** The font's real, unrounded advance per column, in pixels. */
  advance: number;
}

export interface GridSize {
  cols: number;
  rows: number;
}

/**
 * A grid smaller than this is one an agent CLI cannot draw into: they divide by
 * `$COLUMNS`, subtract fixed margins from it, and emit negative padding or a
 * division by zero when the answer goes non-positive.
 */
const MIN_COLS = 20;
const MIN_ROWS = 4;

/** Measured over a run of this many glyphs; one glyph's advance rounds badly. */
const SAMPLE_LEN = 100;

/** Used when there is no 2D context to measure with, as in jsdom. */
const FALLBACK: MeasuredCell = { width: 8, height: 16, advance: 8 };

/**
 * Integer cell metrics. A monospace advance is rarely a whole number of pixels
 * at a given size, and the fraction accumulates: quantize once here so every
 * consumer shares one integer rather than each rounding its own way.
 */
export function quantizeCell(rawWidth: number, rawHeight: number): CellMetrics {
  return {
    width: Math.max(1, Math.floor(rawWidth)),
    height: Math.max(1, Math.floor(rawHeight)),
  };
}

/**
 * The letter-spacing that lands a run of glyphs on the integer cell grid.
 *
 * ── WHY A TERMINAL NEEDS THIS ──────────────────────────────────────────────
 *
 * `quantizeCell` floors, so the app's grid is whole pixels. The browser does
 * not: it advances text by the font's real fractional advance, and nothing had
 * ever reconciled the two. Measured in Chromium on 2026-09-16, the `font-mono`
 * stack at 13px advances 7.80127px where the cell is 7px — 0.8px of drift per
 * column, which is a FULL CELL by column 9. Text and the caret were being
 * placed on two different grids: the caret from the integer metric, the glyphs
 * from the font, so the caret sat visibly to the left of the character it was
 * on, further left the longer the line. Long rows also overflowed the pane by
 * ten percent of their width.
 *
 * Negative spacing tightens the gap between glyphs without touching their ink,
 * which is what a terminal cell does anyway. Returns 0 rather than a positive
 * value for a measurement too small to be a real font: `quantizeCell` clamps
 * those up to 1px, and widening to meet the clamp would push text off the grid
 * instead of onto it.
 */
export function tracking(cell: CellMetrics, advance: number): number {
  if (!Number.isFinite(advance) || advance <= 0) return 0;
  return Math.min(0, cell.width - advance);
}

/**
 * Pixels to a terminal grid. Floor, never round: a partly visible column is one
 * the shell would wrap text into and the reader cannot see.
 */
export function gridSize(widthPx: number, heightPx: number, cell: CellMetrics): GridSize {
  return {
    cols: Math.max(MIN_COLS, Math.floor(widthPx / cell.width)),
    rows: Math.max(MIN_ROWS, Math.floor(heightPx / cell.height)),
  };
}

/**
 * Measure the cell of the font an element actually renders with.
 *
 * Returns a usable fallback rather than throwing when there is no 2D context,
 * because a terminal that opens at a slightly wrong size beats one that does
 * not open.
 */
export function measureCell(el: HTMLElement): MeasuredCell {
  const style = getComputedStyle(el);
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return FALLBACK;

  // A bare 2D context has no letter-spacing of its own, so this reads the
  // font's own advance even once `tracking` has been applied to `el` — there
  // is no feedback loop between the measurement and the correction.
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const width = ctx.measureText('M'.repeat(SAMPLE_LEN)).width / SAMPLE_LEN;

  // `line-height: normal` does not parse to a number; fall back to the ratio
  // browsers use for it.
  const lineHeight = parseFloat(style.lineHeight);
  const fontSize = parseFloat(style.fontSize);
  const height = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.2;

  if (!Number.isFinite(width) || width <= 0) return FALLBACK;
  return { ...quantizeCell(width, height), advance: width };
}
