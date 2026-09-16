import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/headless';
import type { AnsiLine, AnsiSpan } from '../types/terminal';
import { looksLikeError, parse256Color } from './palette';

/**
 * An xterm buffer to the span model the block and raw views render.
 *
 * Pure and buffer-shaped rather than terminal-shaped so it tests against a
 * plain Terminal with no wrapper lifecycle in the way.
 */

type Attr = Omit<AnsiSpan, 'text'>;

/**
 * xterm reports colour three ways and the predicates are the stable API — the
 * raw mode constants are internal encoding. RGB arrives packed in one integer.
 */
function colourOf(cell: IBufferCell, fg: boolean): string | undefined {
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return undefined;
  const value = fg ? cell.getFgColor() : cell.getBgColor();
  if (fg ? cell.isFgPalette() : cell.isBgPalette()) return parse256Color(value);
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`;
}

/** xterm's attribute predicates return numbers, not booleans. */
function attrOf(cell: IBufferCell): Attr {
  return {
    fg: colourOf(cell, true),
    bg: colourOf(cell, false),
    bold: !!cell.isBold(),
    dim: !!cell.isDim(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    strikethrough: !!cell.isStrikethrough(),
    invert: !!cell.isInverse(),
  };
}

function sameAttr(a: Attr, b: Attr): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.invert === b.invert
  );
}

/** Last column holding anything worth drawing; trailing blanks carry no information. */
function lastInkedColumn(line: IBufferLine, probe: IBufferCell): number {
  for (let x = line.length - 1; x >= 0; x--) {
    const cell = line.getCell(x, probe);
    if (!cell) continue;
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars();
    if (chars !== '' && chars !== ' ') return x;
    if (!cell.isBgDefault()) return x;
  }
  return -1;
}

function lineToAnsi(line: IBufferLine, id: string, probe: IBufferCell, row?: number): AnsiLine {
  const spans: AnsiSpan[] = [];
  let run: Attr | null = null;
  let text = '';

  const flush = () => {
    if (text.length === 0) return;
    spans.push({ text, ...(run ?? {}) });
    text = '';
  };

  const end = lastInkedColumn(line, probe);
  for (let x = 0; x <= end; x++) {
    const cell = line.getCell(x, probe);
    if (!cell) continue;
    // Width 0 is the trailing half of a wide character; its glyph already came
    // with the leading cell. Emitting it is how an emoji renders twice.
    if (cell.getWidth() === 0) continue;
    const attr = attrOf(cell);
    if (run === null || !sameAttr(run, attr)) {
      flush();
      run = attr;
    }
    // An untouched cell reports the empty string, not a space.
    text += cell.getChars() || ' ';
  }
  flush();

  const plain = spans.map((s) => s.text).join('');
  if (spans.length === 0) spans.push({ text: ' ' });

  return { id, row, spans, isError: looksLikeError(plain), timestamp: Date.now(), isWrapped: !!line.isWrapped };
}

/**
 * Last row worth rendering.
 *
 * `buffer.length` spans the whole viewport, so reading to it returns a screenful
 * of blank rows after every short command. The cursor's row is the floor: it
 * stays even when blank, because that is where the next output lands.
 */
function lastUsedLine(buffer: IBuffer, probe: IBufferCell): number {
  // Once the screen has scrolled, blank viewport rows are physical terminal
  // cells too. Trimming them makes every erase/home redraw shrink scrollHeight
  // and pulls history into view. Alternate screens always occupy a full grid.
  if (buffer.baseY > 0 || buffer.type === 'alternate') return buffer.length - 1;
  const cursorLine = buffer.baseY + buffer.cursorY;
  let last = Math.min(cursorLine, buffer.length - 1);
  for (let y = buffer.length - 1; y > last; y--) {
    const line = buffer.getLine(y);
    if (line && lastInkedColumn(line, probe) >= 0) {
      last = y;
      break;
    }
  }
  return last;
}

/**
 * Rows from `startLine` to the last one holding anything.
 *
 * The id is the absolute buffer line. It shifts by one each time scrollback
 * trims, which costs a re-render of the rows below; a monotonic id would need a
 * line-creation event xterm does not expose.
 */
export function linesFrom(buffer: IBuffer, startLine: number, previous: AnsiLine[] = []): AnsiLine[] {
  const out: AnsiLine[] = [];
  const probe = buffer.getNullCell();
  const from = Math.max(0, startLine);
  const to = lastUsedLine(buffer, probe);
  for (let y = from; y <= to; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const next = lineToAnsi(line, `row-${y}`, probe, y);
    const old = previous[y - from];
    // Preserve immutable row identity so React.memo can skip unchanged history.
    // Compare attributes as well as text: an SGR-only repaint must still render.
    const unchanged = old && old.row === y && old.isWrapped === next.isWrapped
      && old.isError === next.isError && old.spans.length === next.spans.length
      && old.spans.every((span, i) => span.text === next.spans[i].text && sameAttr(span, next.spans[i]));
    out.push(unchanged ? old : next);
  }
  return out;
}
