import type { AnsiLine, ScreenCursor } from '../types/terminal';

/**
 * What the app needs from a terminal screen, independent of who parses.
 *
 * Extracted so `@xterm/headless` can be dropped in behind the existing
 * consumers rather than rewriting them, and so both implementations can be run
 * against the same tests while the swap is proven.
 */
export interface TerminalScreen {
  /**
   * Feed bytes. Parsing is ASYNCHRONOUS — the buffer is not updated when this
   * returns. Read only after `onParsed` fires.
   */
  write(data: string): void;

  /** Resolves at parser application, independent of frame-coalesced painting. */
  writeAndWait(data: string): Promise<void>;

  /** Drain already-submitted writes; reject after five seconds or on disposal. */
  drain(): Promise<void>;

  /**
   * Fires after a batch of writes has been parsed, coalesced to at most one
   * call per frame. Returns an unsubscribe.
   */
  onParsed(cb: () => void): () => void;

  isAltScreen(): boolean;

  /** Input safety: output/reset changes invalidate an outstanding clipboard read. */
  getPasteState(): { revision: number; bracketed: boolean };

  /**
   * An opaque handle to the cursor's current row, for `linesSince`. A plain
   * number because it is persisted on the block (`TerminalBlock.outputMark`).
   */
  mark(): number;

  getLines(): AnsiLine[];

  /**
   * Where the caret is, as an index into `getLines()` and a column.
   *
   * The app drew no cursor at all until 2026-09-01, which is most of why
   * "you cannot read input text" was the first thing anyone said about it:
   * with a shell that prints its prompt and then waits, there was nothing on
   * screen distinguishing a live terminal from a screenshot of one.
   */
  getCursor(): ScreenCursor;

  /** Rows from `mark` to the end. Falls back to everything if the mark is gone. */
  linesSince(mark: number): AnsiLine[];

  resize(cols: number, rows: number): void;
  reset(): void;
  dispose(): void;
}
