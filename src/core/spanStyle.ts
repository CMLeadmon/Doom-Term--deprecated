import type { CSSProperties } from 'react';
import type { AnsiSpan } from '../types/terminal';

/**
 * Inline style for one rendered span.
 *
 * Shared by the block view and the raw view so the two cannot drift — they
 * previously disagreed about which attributes existed at all.
 */
export function spanStyle(span: AnsiSpan, isErrorLine = false): CSSProperties {
  // A flagged row tints only what the program left uncoloured. Anything the
  // program coloured itself — a grep match, git status, ls — keeps its colour;
  // overriding it destroys the highlighting the user asked for.
  const fg = span.fg ?? (isErrorLine ? 'var(--st-fail)' : undefined);
  const bg = span.bg;

  const style: CSSProperties = {
    fontWeight: span.bold ? 'bold' : 'normal',
    fontStyle: span.italic ? 'italic' : 'normal',
  };

  /*
   * Put the run on the grid instead of hoping the text lands there.
   *
   * `tracking()` cancels the difference between the font's advance and the
   * integer cell, and that is enough while every glyph advances by the same
   * amount. Two kinds routinely do not, and both were measured live in
   * Chromium on 2026-09-16 against an 8px cell:
   *
   *   - a double-width character advances by its own width, 13px, where the
   *     grid gives the two cells it occupies 16px. Every column after it on
   *     that line is then 3px short per character, and 6px short by the second
   *     one — three quarters of a cell.
   *   - a character the primary font does not have is resolved from a FALLBACK
   *     in the stack and advances by THAT font's amount, 7.81px against 8px.
   *     Agent CLIs print those constantly (box drawing, spinners, check marks,
   *     Nerd Font symbols), and the error accumulates for the whole line.
   *
   * Either one walks the text out from under a caret that is placed by
   * arithmetic. An inline-block of exactly the run's own column count means
   * the drift cannot cross a span boundary: the next run starts on its column
   * whatever happened inside this one. `overflow: hidden` is deliberately NOT
   * set — clipping a glyph is worse than a sub-pixel overhang.
   */
  if (typeof span.cols === 'number' && span.cols > 0) {
    style.display = 'inline-block';
    style.width = `calc(var(--terminal-cell-width, 1ch) * ${span.cols})`;
    // An inline-block's baseline is its last line box's; keep it explicit so a
    // fallback glyph with different metrics cannot lift the run off the row.
    style.verticalAlign = 'baseline';
  }

  if (span.invert) {
    // Inverse video is how a TUI draws selection and cursors; dropping it makes
    // the selected row indistinguishable from its neighbours.
    style.color = bg ?? 'var(--ground)';
    style.backgroundColor = fg ?? 'var(--ink)';
  } else {
    style.color = fg;
    style.backgroundColor = bg;
  }

  const decoration = [
    span.underline ? 'underline' : null,
    span.strikethrough ? 'line-through' : null,
  ].filter(Boolean);
  if (decoration.length > 0) style.textDecoration = decoration.join(' ');

  // SGR 2 is a relative reduction. It used to be 0.6, which drove already-dim
  // tokens under 2:1 against the ground; 0.78 stays legible on every palette entry.
  if (span.dim) style.opacity = 0.78;

  return style;
}
