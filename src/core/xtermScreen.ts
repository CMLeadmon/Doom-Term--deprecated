import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { IMarker } from '@xterm/headless';
import type { AnsiLine, ScreenCursor } from '../types/terminal';
import type { TerminalScreen } from './terminalScreen';
import { linesFrom } from './xtermLines';

/** Matches what the hand-written emulator kept, so scrollback depth is unchanged. */
const SCROLLBACK = 5000;

/** DEC private mode 2026: "everything until the matching reset is one frame". */
const SYNCHRONIZED_OUTPUT = 2026;

/**
 * How long a synchronized update may hold the screen before we draw anyway.
 *
 * A writer that opens 2026 and never closes it — because it crashed, or
 * because its output was truncated — must not be able to freeze the pane. The
 * value is the one the mode's own specification recommends for exactly this.
 */
const SYNC_TIMEOUT_MS = 150;

/**
 * A terminal screen backed by @xterm/headless.
 *
 * Replaces a hand-written VT emulator that had no character-width model at all:
 * it advanced one cell per code point, so every emoji overlapped its neighbour
 * and every column after a wide glyph sheared. xterm ships a real width table,
 * and the Unicode 11 addon puts it on the same table as tmux (utf8proc) and the
 * agent CLIs (string-width) — agreement is the goal, not the number 11.
 */
export class XtermScreen implements TerminalScreen {
  private term: Terminal;
  private cursorVisible = true;
  private renderedLines: AnsiLine[] = [];
  private listeners = new Set<() => void>();
  private marks = new Map<number, IMarker>();
  private nextMarkId = 1;
  private frame = 0;
  private scheduled = false;
  /** Open synchronized updates. A frame published inside one is a torn frame. */
  private syncDepth = 0;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** A frame fell due while the screen was held. Publish it on release. */
  private syncPending = false;
  private disposed = false;
  private inputRevision = 0;
  private pendingWrites = 0;
  private submitted = 0;
  private applied = 0;
  private parserGeneration = 0;
  private parserFailure: Error | null = null;
  private boundaries = new Set<{
    target: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(cols: number, rows: number) {
    this.term = this.createTerminal(cols, rows);
  }

  private createTerminal(cols: number, rows: number): Terminal {
    const terminal = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK,
      // Treat LF as CRLF, as the emulator this replaces did. A PTY with ONLCR
      // delivers CRLF anyway, so this only matters for a stream that emits bare
      // LF — and without it that stream staircases across the screen.
      convertEol: true,
      // registerMarker and the unicode API are proposed API and throw without this.
      allowProposedApi: true,
    });
    // Headless exposes no public DECTCEM state. Observe parsed commands, then
    // return false so xterm still applies every parameter (including other modes).
    this.cursorVisible = true;
    for (const [final, set] of [['h', true], ['l', false]] as const) {
      terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
        if (params.includes(25)) this.cursorVisible = set;
        // DECSET/DECRST 2026 — synchronized output. See `syncDepth`.
        if (params.includes(SYNCHRONIZED_OUTPUT)) this.setSynchronized(set);
        return false;
      });
    }
    const showCursor = () => { this.cursorVisible = true; return false; };
    terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, showCursor);
    terminal.parser.registerEscHandler({ final: 'c' }, showCursor);
    try {
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = '11';
    } catch (err) {
      // Non-fatal by design: a terminal on the old width table renders as it did
      // yesterday, which is far better than a terminal that does not open.
      console.warn('[terminal] could not activate Unicode 11 widths', err);
    }
    return terminal;
  }

  write(data: string): void {
    if (this.disposed || this.parserFailure || !data) return;
    this.inputRevision++;
    this.pendingWrites++;
    const ticket = ++this.submitted;
    const generation = this.parserGeneration;
    this.term.write(data, () => {
      if (this.disposed || this.parserFailure || generation !== this.parserGeneration) return;
      this.pendingWrites--;
      this.applied = ticket;
      for (const boundary of this.boundaries) {
        if (boundary.target > this.applied) continue;
        clearTimeout(boundary.timer);
        this.boundaries.delete(boundary);
        boundary.resolve();
      }
      this.scheduleNotify();
    });
  }

  writeAndWait(data: string): Promise<void> {
    this.write(data);
    return this.drain();
  }

  drain(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Terminal screen is disposed'));
    if (this.parserFailure) return Promise.reject(this.parserFailure);
    if (this.applied === this.submitted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const boundary = {
        target: this.submitted, resolve, reject,
        timer: setTimeout(() => {
          this.parserFailure = new Error('Terminal parser drain timed out; reconstruction is required');
          this.rejectBoundaries(this.parserFailure);
        }, 5000),
      };
      this.boundaries.add(boundary);
    });
  }

  private rejectBoundaries(error: Error): void {
    for (const boundary of this.boundaries) {
      clearTimeout(boundary.timer);
      boundary.reject(error);
    }
    this.boundaries.clear();
  }

  /**
   * One notification per frame, however many chunks arrived.
   *
   * A busy agent delivers many writes per frame and each one used to drive a
   * full React update over the whole scrollback.
   */
  /**
   * Hold the screen for the length of one repaint, or let it go.
   *
   * A full-screen repaint does not arrive in one piece. tmux repaints a pane by
   * homing the cursor and rewriting every row, and the daemon hands us that in
   * 8 KiB chunks; a frame published between two of them shows a screen that is
   * half old and half new. The text survives that — most rows repaint to the
   * same thing — but the CARET does not: mid-repaint it is wherever the redraw
   * has got to, which is the top of the pane. Sampled in Chromium on
   * 2026-09-16 during streaming output, the caret jumped to exactly one
   * viewport height above the tail (`cursorY === 0`) for a single frame and
   * snapped back — the "cursor flashes to a different area" report.
   *
   * Mode 2026 is the writer telling us where the seams are. `terminal-features
   * ,*:sync` in the tmux config is what makes tmux emit it around each repaint.
   * Nesting is counted rather than latched: a writer inside a writer must not
   * release the screen early.
   */
  private setSynchronized(open: boolean): void {
    if (open) {
      this.syncDepth++;
      if (this.syncTimer === null) {
        this.syncTimer = setTimeout(() => {
          // The update never closed. Draw rather than freeze.
          this.syncDepth = 0;
          this.syncTimer = null;
          this.releaseSynchronized();
        }, SYNC_TIMEOUT_MS);
      }
      return;
    }
    if (this.syncDepth === 0) return;
    this.syncDepth--;
    if (this.syncDepth > 0) return;
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.releaseSynchronized();
  }

  /** Drop any hold and its timer, without publishing. */
  private clearSynchronized(): void {
    this.syncDepth = 0;
    this.syncPending = false;
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private releaseSynchronized(): void {
    if (!this.syncPending) return;
    this.syncPending = false;
    this.scheduleNotify();
  }

  private scheduleNotify(): void {
    if (this.disposed) return;
    // Held for the rest of this repaint; the frame is owed, not dropped.
    if (this.syncDepth > 0) {
      this.syncPending = true;
      return;
    }
    if (this.scheduled) return;
    // Set BEFORE scheduling, and guard on this rather than on the frame handle:
    // a callback that runs synchronously would otherwise fire before the
    // assignment completes, leaving a stale handle that swallows every later
    // notification. The handle is kept only so dispose() can cancel it.
    this.scheduled = true;
    this.frame = requestAnimationFrame(() => {
      this.scheduled = false;
      this.frame = 0;
      if (this.disposed) return;
      for (const cb of [...this.listeners]) cb();
    });
  }

  onParsed(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  isAltScreen(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  getPasteState(): { revision: number; bracketed: boolean } {
    return {
      revision: this.inputRevision,
      bracketed: !this.disposed && !this.parserFailure && this.pendingWrites === 0 && this.term.modes.bracketedPasteMode,
    };
  }

  /**
   * Returns an opaque handle rather than a line number: the marker underneath
   * is trim-compensated by xterm, so a block keeps pointing at its own output
   * even after scrollback drops rows above it. The handle is a number because
   * it is persisted on the block.
   */
  mark(): number {
    const id = this.nextMarkId++;
    const marker = this.term.registerMarker(0);
    if (marker) {
      this.marks.set(id, marker);
      marker.onDispose(() => this.marks.delete(id));
    }
    return id;
  }

  getLines(): AnsiLine[] {
    this.renderedLines = linesFrom(this.term.buffer.active, 0, this.renderedLines);
    return this.renderedLines;
  }

  /**
   * The caret, in the same coordinates `getLines()` returns.
   *
   * `getLines` starts at absolute row 0, so `baseY + cursorY` indexes it
   * directly. Both are read together and from the same buffer object so a
   * frame cannot land between them and pair a new row with an old column.
   */
  getCursor(): ScreenCursor {
    const buffer = this.term.buffer.active;
    const row = buffer.baseY + buffer.cursorY;
    // Pending autowrap keeps cursorX == cols until the next glyph arrives.
    const col = Math.min(buffer.cursorX, this.term.cols - 1);
    // The cell under the caret, read here because this is the only place with
    // a width table. A block caret is reverse video: the view repaints this
    // character in the ground colour on the block, which is the only way it
    // stays readable. Blending the block with whatever colour the program
    // chose produces an arbitrary third colour instead — measured at
    // difference(#e0a92c, #e8dcbc) = #083390, navy on amber.
    const cell = buffer.getLine(row)?.getCell(col);
    const glyph = cell?.getChars() ?? '';
    const width = cell?.getWidth() ?? 1;
    return {
      row,
      col,
      ...(glyph === '' || glyph === ' ' ? {} : { glyph }),
      ...(width === 2 ? { cells: 2 } : {}),
      ...(this.cursorVisible ? {} : { visible: false }),
    };
  }

  linesSince(mark: number): AnsiLine[] {
    const marker = this.marks.get(mark);
    // An unknown mark is a restored session's, or one whose line has scrolled
    // out. Everything beats nothing.
    if (!marker) return this.getLines();
    return linesFrom(this.term.buffer.active, marker.line);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.inputRevision++;
    this.term.resize(cols, rows);
  }

  reset(): void {
    if (this.disposed) return;
    this.rejectBoundaries(new Error('Terminal screen was reset'));
    // A half-open synchronized update belongs to the parser being thrown away.
    this.clearSynchronized();
    this.parserGeneration++;
    this.submitted = 0;
    this.applied = 0;
    this.pendingWrites = 0;
    this.parserFailure = null;
    this.inputRevision++;
    // xterm.reset() leaves its asynchronous write queue alive. A replacement
    // parser is required so old queued bytes cannot enter the new screen.
    const { cols, rows } = this.term;
    this.term.dispose();
    this.term = this.createTerminal(cols, rows);
    this.marks.clear();
    this.renderedLines = [];
  }

  dispose(): void {
    this.inputRevision++;
    this.disposed = true;
    this.rejectBoundaries(new Error('Terminal screen is disposed'));
    this.clearSynchronized();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.scheduled = false;
    this.listeners.clear();
    this.marks.clear();
    this.term.dispose();
  }
}
