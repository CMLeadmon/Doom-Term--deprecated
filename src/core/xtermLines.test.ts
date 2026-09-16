import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { linesFrom } from './xtermLines';
import { DOOM_PALETTE } from './palette';

/** xterm parses on a scheduled callback, so every read must follow the write. */
const feed = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

const makeTerm = (cols = 40, rows = 10) => {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 100 });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  return term;
};

// Trailing whitespace is trimmed the way the sibling suites do: a blank row
// deliberately carries a single space so its div does not collapse to no height.
const plain = (lines: { spans: { text: string }[] }[]) =>
  lines.map((l) => l.spans.map((s) => s.text).join('').replace(/\s+$/, ''));

describe('linesFrom', () => {
  it('renders plain text as a single span', async () => {
    const term = makeTerm();
    await feed(term, 'hello world');
    expect(plain(linesFrom(term.buffer.active, 0))[0]).toBe('hello world');
  });

  it('splits a run at each attribute change and maps the Doom palette', async () => {
    const term = makeTerm();
    await feed(term, 'plain \x1b[32mgreen\x1b[0m');
    const spans = linesFrom(term.buffer.active, 0)[0].spans;
    expect(spans[0].text).toBe('plain ');
    expect(spans[0].fg).toBeUndefined();
    expect(spans[1].text).toBe('green');
    expect(spans[1].fg).toBe(DOOM_PALETTE.green);
  });

  it('carries every attribute the span model has', async () => {
    const term = makeTerm();
    await feed(term, '\x1b[1;3;4;7;9;2mx');
    const s = linesFrom(term.buffer.active, 0)[0].spans[0];
    expect(s.bold).toBe(true);
    expect(s.italic).toBe(true);
    expect(s.underline).toBe(true);
    expect(s.invert).toBe(true);
    expect(s.strikethrough).toBe(true);
    expect(s.dim).toBe(true);
  });

  it('reads a 24-bit colour as rgb()', async () => {
    const term = makeTerm();
    await feed(term, '\x1b[38;2;10;20;30mx');
    expect(linesFrom(term.buffer.active, 0)[0].spans[0].fg).toBe('rgb(10, 20, 30)');
  });

  it('emits a wide character once, not twice', async () => {
    // The live defect: with no width model a two-cell glyph advanced one cell
    // and every column after it sheared.
    const term = makeTerm();
    await feed(term, '\u{1f389}A');
    expect(plain(linesFrom(term.buffer.active, 0))[0]).toBe('\u{1f389}A');
  });

  it('trims trailing blanks so a row is not full-width whitespace', async () => {
    const term = makeTerm();
    await feed(term, 'short');
    expect(plain(linesFrom(term.buffer.active, 0))[0]).toBe('short');
  });

  it('flags a line that announces a failure', async () => {
    const term = makeTerm();
    await feed(term, 'error: something broke');
    expect(linesFrom(term.buffer.active, 0)[0].isError).toBe(true);
  });

  it('does not flag an ordinary line that merely contains the word', async () => {
    const term = makeTerm();
    await feed(term, 'grep -rn error src/');
    expect(linesFrom(term.buffer.active, 0)[0].isError).toBe(false);
  });

  it('starts where it is told, for a block reading from its mark', async () => {
    const term = makeTerm();
    await feed(term, 'one\r\ntwo\r\nthree\r\n');
    expect(plain(linesFrom(term.buffer.active, 1))).toEqual(['two', 'three', '']);
  });

  it('gives every row a stable id for React to key on', async () => {
    const term = makeTerm();
    await feed(term, 'a\r\nb\r\n');
    const ids = linesFrom(term.buffer.active, 0).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks wrapped continuation lines with isWrapped', async () => {
    const term = makeTerm(10, 5);
    await feed(term, '1234567890ABCDE');
    const lines = linesFrom(term.buffer.active, 0);
    expect(lines.length).toBe(2);
    expect(lines[0].isWrapped).toBe(false);
    expect(lines[1].isWrapped).toBe(true);
  });
});

describe('column counts, so the view can put a run on the grid', () => {
  /*
   * `letter-spacing` pulls text onto the integer cell grid only while every
   * glyph advances by the same amount. Measured in Chromium on 2026-09-16
   * against an 8px cell: a double-width character advanced 13px where the grid
   * gives its two cells 16px, and a character resolved from a fallback font in
   * the stack advanced 7.81px against 8px. Both walk the rest of the line out
   * from under a caret that is placed at `col * cell`. The view can only pin a
   * run to its columns if it is told how many columns the run has.
   */
  it('counts the columns of a plain run', async () => {
    const term = makeTerm();
    await feed(term, 'hello');
    expect(linesFrom(term.buffer.active, 0)[0].spans[0].cols).toBe(5);
  });

  it('counts a double-width character as the two cells it occupies', async () => {
    const term = makeTerm();
    term.unicode.activeVersion = '11';
    await feed(term, '漢字');
    // One box per wide character, each exactly its own two columns. Sharing a
    // box, the second would start wherever the first glyph's own advance left
    // it — measured 13px against the 16px its cells are given.
    const spans = linesFrom(term.buffer.active, 0)[0].spans;
    expect(spans.map((s) => s.text)).toEqual(['漢', '字']);
    expect(spans.map((s) => s.cols)).toEqual([2, 2]);
  });

  it('gives every non-ASCII cell its own box and leaves ASCII in long runs', async () => {
    const term = makeTerm();
    // A fallback-font glyph between two ASCII runs: the glyph is boxed alone,
    // the ASCII either side stays whole.
    await feed(term, 'ok ✔ done');
    const spans = linesFrom(term.buffer.active, 0)[0].spans;
    expect(spans.map((s) => s.text)).toEqual(['ok ', '✔', ' done']);
    expect(spans.map((s) => s.cols)).toEqual([3, 1, 5]);
  });

  it('boxes each character of a box-drawing rule separately', async () => {
    const term = makeTerm();
    // Sharing one box, each segment lands at the fallback face's own advance
    // and the rule slides further off its columns with every glyph.
    await feed(term, '┌───┐');
    const spans = linesFrom(term.buffer.active, 0)[0].spans;
    expect(spans).toHaveLength(5);
    expect(spans.every((s) => s.cols === 1)).toBe(true);
  });

  it('counts each run separately when an attribute changes mid-line', async () => {
    const term = makeTerm();
    await feed(term, 'ab\x1b[31mcde\x1b[0m');
    const spans = linesFrom(term.buffer.active, 0)[0].spans;
    expect(spans.map((s) => s.cols)).toEqual([2, 3]);
  });

  it('gives the placeholder on a blank line a column, so it is still on the grid', async () => {
    const term = makeTerm();
    await feed(term, '\r\n');
    expect(linesFrom(term.buffer.active, 0)[0].spans[0]).toMatchObject({ text: ' ', cols: 1 });
  });
});
