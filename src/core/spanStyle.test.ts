import { describe, it, expect } from 'vitest';
import { spanStyle } from './spanStyle';

/**
 * The grid is the contract.
 *
 * `cellMetrics.quantizeCell` floors the cell to whole pixels and `tracking()`
 * cancels the font's fractional advance against it — which holds the text on
 * the grid only while every glyph advances by the base amount. Measured in
 * Chromium on 2026-09-16 against an 8px cell, two kinds do not:
 *
 *   - `漢` advanced 13px where the two cells it occupies are allotted 16px, so
 *     every column after it on that line was 3px short per wide character;
 *   - `✔`, absent from the primary face and resolved from a fallback in the
 *     stack, advanced 7.81px against 8px, and the error accumulated for the
 *     rest of the line.
 *
 * Either one walks the text out from under a caret that is positioned at
 * `col * cell`, which is the "the caret overlaps the character" report. Pinning
 * each run to its own column count stops the drift crossing a span boundary.
 */
describe('spanStyle grid pinning', () => {
  it('pins a run to exactly the columns the emulator counted', () => {
    const style = spanStyle({ text: 'hello', cols: 5 });
    expect(style.display).toBe('inline-block');
    expect(style.width).toBe('calc(var(--terminal-cell-width, 1ch) * 5)');
  });

  it('pins a double-width run to its cells, not its characters', () => {
    // Two characters, four columns. Sized by character it would be half a cell
    // narrow per glyph and everything after it would slide left.
    expect(spanStyle({ text: '漢字', cols: 4 }).width)
      .toBe('calc(var(--terminal-cell-width, 1ch) * 4)');
  });

  it('keeps the run on its own row', () => {
    expect(spanStyle({ text: 'x', cols: 1 }).verticalAlign).toBe('baseline');
  });

  it('leaves a span with no counted columns alone', () => {
    // Lines restored from a previous version's cache carry no count. They
    // render exactly as they did before rather than collapsing to zero width.
    const style = spanStyle({ text: 'legacy' });
    expect(style.display).toBeUndefined();
    expect(style.width).toBeUndefined();
  });

  it('does not pin a run the emulator counted as zero columns', () => {
    expect(spanStyle({ text: '', cols: 0 }).width).toBeUndefined();
  });

  it('still carries the attributes it always did', () => {
    const style = spanStyle({ text: 'x', cols: 1, bold: true, fg: 'var(--st-fail)', underline: true });
    expect(style.fontWeight).toBe('bold');
    expect(style.color).toBe('var(--st-fail)');
    expect(style.textDecoration).toBe('underline');
  });

  it('keeps inverse video painting the swap, pinned or not', () => {
    const style = spanStyle({ text: 'x', cols: 1, invert: true, fg: '#abcdef' });
    expect(style.backgroundColor).toBe('#abcdef');
    expect(style.color).toBe('var(--ground)');
    expect(style.width).toBe('calc(var(--terminal-cell-width, 1ch) * 1)');
  });
});
