import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XtermScreen } from './xtermScreen';
import type { Terminal } from '@xterm/headless';

/** Resolve once the screen reports a parse; xterm's write is asynchronous. */
const parsed = (screen: XtermScreen, data: string) =>
  new Promise<void>((resolve) => {
    const off = screen.onParsed(() => {
      off();
      resolve();
    });
    screen.write(data);
  });

const plain = (lines: { spans: { text: string }[] }[]) =>
  lines.map((l) => l.spans.map((s) => s.text).join('').replace(/\s+$/, ''));

beforeEach(() => {
  // Coalescing runs on a frame; fire it straight through in tests.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('XtermScreen', () => {
  it('keeps a pending-wrap caret inside the last column', async () => {
    const screen = new XtermScreen(10, 5);
    try {
      await parsed(screen, '1234567890');
      expect(screen.getCursor()).toMatchObject({ row: 0, col: 9 });
      await parsed(screen, 'x');
      expect(screen.getCursor()).toMatchObject({ row: 1, col: 1 });
    } finally { screen.dispose(); }
  });

  it('honors cursor hiding across split writes, showing and terminal resets', async () => {
    const screen = new XtermScreen(40, 10);
    try {
      await parsed(screen, '\x1b[?2');
      await parsed(screen, '5l');
      expect(screen.getCursor()).toMatchObject({ visible: false });
      await parsed(screen, '\x1b[?25h');
      expect(screen.getCursor().visible).not.toBe(false);
      await parsed(screen, '\x1b[?25l\x1b[!p');
      expect(screen.getCursor().visible).not.toBe(false);
      await parsed(screen, '\x1b[?25l\x1bc');
      expect(screen.getCursor().visible).not.toBe(false);
      await parsed(screen, '\x1b[?25l');
      screen.reset();
      expect(screen.getCursor().visible).not.toBe(false);
    } finally { screen.dispose(); }
  });

  it('keeps the full viewport while a scrolled terminal clears and redraws', async () => {
    const screen = new XtermScreen(40, 10);
    try {
      await parsed(screen, 'history\r\n'.repeat(20));
      const before = screen.getLines().length;
      await parsed(screen, '\x1b[H\x1b[Jtop');
      expect(screen.getLines()).toHaveLength(before);
      expect(plain(screen.getLines()).at(-1)).toBe('');
    } finally { screen.dispose(); }
  });

  it('retains blank alternate-screen rows when the cursor moves to the top', async () => {
    const screen = new XtermScreen(40, 10);
    try {
      await parsed(screen, '\x1b[?1049h\x1b[Htop');
      expect(screen.getLines()).toHaveLength(10);
    } finally { screen.dispose(); }
  });

  it('reuses unchanged row snapshots when only the prompt changes', async () => {
    const screen = new XtermScreen(40, 10);
    try {
      await parsed(screen, 'history\r\nprompt> ');
      const before = screen.getLines();
      await parsed(screen, 'x');
      const after = screen.getLines();
      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
      expect(plain(before)[1]).toBe('prompt>');
      expect(plain(after)[1]).toBe('prompt> x');
      await parsed(screen, '\x1b[H\x1b[31mhistory');
      expect(screen.getLines()[0]).not.toBe(before[0]);
    } finally { screen.dispose(); }
  });

  it('cannot apply queued old bytes or acknowledgements after a reset', async () => {
    const screen = new XtermScreen(40, 10);
    try {
      const old = screen.writeAndWait('old bytes');
      const rejected = expect(old).rejects.toThrow('reset');
      screen.reset();
      await rejected;
      await screen.writeAndWait('new bytes');
      expect(plain(screen.getLines())[0]).toBe('new bytes');
    } finally { screen.dispose(); }
  });

  it('fails a stalled real parser after five seconds and never acknowledges its late callback', async () => {
    vi.useFakeTimers();
    const screen = new XtermScreen(40, 10);
    let release!: (handled: boolean) => void;
    // Stall the real parser at its supported async OSC-handler boundary; do
    // not replace write(), its callback, or the acknowledgement implementation.
    const terminal = (screen as unknown as { term: Terminal }).term;
    // The bundled ParserApi supports Promise<boolean>; headless's published
    // .d.ts currently omits that union. Narrow this fixture boundary only.
    const parser = terminal.parser as unknown as {
      registerOscHandler(id: number, callback: () => Promise<boolean>): { dispose(): void };
    };
    terminal.options.logLevel = 'error'; // Expected upstream five-second warning.
    const handler = parser.registerOscHandler(777, () => new Promise<boolean>(resolve => { release = resolve; }));
    try {
      const pending = screen.writeAndWait('\x1b]777;pause\x07late bytes');
      const rejected = expect(pending).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      release(true);
      await vi.advanceTimersByTimeAsync(0);
      await expect(screen.drain()).rejects.toThrow('timed out');
      expect(screen.getPasteState().bracketed).toBe(false);
    } finally {
      release?.(true);
      handler.dispose();
      screen.dispose();
      vi.useRealTimers();
    }
  });

  it('acknowledges parser application independently of a paused animation frame', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const screen = new XtermScreen(40, 10);
    try {
      const applied = screen.writeAndWait('\x1b[31m三A');
      expect(plain(screen.getLines())[0]).not.toBe('三A');
      await applied;
      expect(plain(screen.getLines())[0]).toBe('三A');
      expect(screen.getCursor()).toEqual({ row: 0, col: 3 });
    } finally { screen.dispose(); }
  });

  it('drains writes already queued before a disconnect without resetting modes or marks', async () => {
    const screen = new XtermScreen(40, 10);
    try {
      await screen.writeAndWait('history\r\n');
      const mark = screen.mark();
      screen.write('\x1b[31');
      screen.write('mred\r\n');
      await screen.drain();
      expect(plain(screen.linesSince(mark))[0]).toBe('red');
      expect(plain(screen.getLines())[0]).toBe('history');
      expect(screen.getLines()[1].spans[0].fg).toBeDefined();
    } finally { screen.dispose(); }
  });

  it('rejects pending acknowledgements when their emulator is disposed', async () => {
    const screen = new XtermScreen(40, 10);
    const writing = screen.writeAndWait('must not acknowledge a replacement');
    const draining = screen.drain();
    const rejectedWrite = expect(writing).rejects.toThrow('disposed');
    const rejectedDrain = expect(draining).rejects.toThrow('disposed');
    screen.dispose();
    await Promise.all([rejectedWrite, rejectedDrain]);
    await expect(screen.writeAndWait('late')).rejects.toThrow('disposed');
    await expect(screen.drain()).rejects.toThrow('disposed');
  });

  it('announces a parse and then reads back what was written', async () => {
    const screen = new XtermScreen(40, 10);
    await parsed(screen, 'hello');
    expect(plain(screen.getLines())[0]).toBe('hello');
  });

  it('reports alt-screen', async () => {
    const screen = new XtermScreen(40, 10);
    expect(screen.isAltScreen()).toBe(false);
    await parsed(screen, '\x1b[?1049h');
    expect(screen.isAltScreen()).toBe(true);
    await parsed(screen, '\x1b[?1049l');
    expect(screen.isAltScreen()).toBe(false);
  });

  it('reads a block from its mark, not from the top', async () => {
    const screen = new XtermScreen(40, 10);
    await parsed(screen, 'before\r\n');
    const mark = screen.mark();
    await parsed(screen, 'after one\r\nafter two\r\n');
    expect(plain(screen.linesSince(mark))).toContain('after one');
    expect(plain(screen.linesSince(mark))).not.toContain('before');
  });

  it('falls back to the whole buffer for a mark it does not know', async () => {
    // A mark restored from a persisted session belongs to a screen that no
    // longer exists; showing everything beats showing nothing.
    const screen = new XtermScreen(40, 10);
    await parsed(screen, 'restored\r\n');
    expect(plain(screen.linesSince(9999))[0]).toBe('restored');
  });

  it('gives a wide character its second cell', async () => {
    const screen = new XtermScreen(40, 10);
    await parsed(screen, '\u{1f389}A');
    expect(plain(screen.getLines())[0]).toBe('\u{1f389}A');
  });

  it('coalesces a burst of writes into one notification', async () => {
    // This one needs a DEFERRING frame stub. The synchronous stub the other
    // tests use flushes each frame inside the write that scheduled it, which
    // makes coalescing impossible by construction.
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued.push(cb);
      return queued.length;
    });

    const screen = new XtermScreen(40, 10);
    const seen = vi.fn();
    screen.onParsed(seen);
    screen.write('a');
    screen.write('b');
    screen.write('c');
    // Let xterm's parser drain; its write callbacks are asynchronous.
    await new Promise((r) => setTimeout(r, 0));

    // Three writes, one queued frame — that is the coalescing.
    expect(queued.length).toBe(1);
    queued.forEach((cb) => cb(0));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('resizes and stops notifying once disposed', async () => {
    const screen = new XtermScreen(40, 10);
    screen.resize(20, 5);
    const seen = vi.fn();
    screen.onParsed(seen);
    screen.dispose();
    screen.write('ignored');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('what the caret is sitting on', () => {
  /*
   * A block caret is reverse video, so the view has to repaint the character
   * under it in the ground colour. Only the emulator has a width table, so
   * only the emulator can say which character a column holds — the view used
   * to blend the block with the text instead, and `difference` against a fixed
   * amber lands on whatever it lands on (bone #e8dcbc came out navy #083390).
   */
  it('reports the character under the caret', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      // Cursor home, then a step right: the caret is on the 'b'.
      await parsed(screen, 'abc\x1b[3D\x1b[C');
      expect(screen.getCursor()).toMatchObject({ row: 0, col: 1, glyph: 'b' });
    } finally { screen.dispose(); }
  });

  it('says nothing about an empty cell rather than inventing a space', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      await parsed(screen, 'ab');
      // Past the text: there is no character here, so there is no glyph.
      expect(screen.getCursor().glyph).toBeUndefined();
    } finally { screen.dispose(); }
  });

  it('covers both cells of a double-width character', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      await parsed(screen, '漢字\x1b[4D');
      const cursor = screen.getCursor();
      expect(cursor.col).toBe(0);
      expect(cursor.glyph).toBe('漢');
      // One character, two columns. A one-cell caret would clip it in half.
      expect(cursor.cells).toBe(2);
    } finally { screen.dispose(); }
  });

  it('leaves a single-width character on one cell', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      await parsed(screen, 'ab\x1b[2D');
      expect(screen.getCursor().cells).toBeUndefined();
    } finally { screen.dispose(); }
  });
});

describe('synchronized output', () => {
  /*
   * A repaint does not arrive in one piece. tmux redraws a pane by homing the
   * cursor and rewriting every row; the daemon delivers that in 8 KiB chunks,
   * and a frame published between two of them is half old and half new. Most
   * rows repaint to the same text so nothing looks wrong — except the caret,
   * which mid-repaint is at the top of the pane. Sampled in Chromium on
   * 2026-09-16 during streaming output, it landed exactly one viewport height
   * above the tail for a single frame and snapped back.
   */

  // A real frame, not the straight-through stub the rest of the file uses:
  // coalescing is the behaviour under test, and a synchronous rAF cannot
  // coalesce anything.
  let pending: FrameRequestCallback[] = [];
  beforeEach(() => {
    pending = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      pending.push(cb);
      return pending.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  const paint = () => { const due = pending; pending = []; for (const cb of due) cb(0); };

  /** xterm's write callback is asynchronous however frames are scheduled. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const frames = (screen: XtermScreen) => {
    let count = 0;
    screen.onParsed(() => { count++; });
    return () => count;
  };

  it('publishes no frame while an update is open', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      screen.write('before');
      await settle();
      paint();
      const seen = frames(screen);
      screen.write('\x1b[?2026h');
      screen.write('\x1b[Hhalf a repaint');
      await settle();
      paint();
      expect(seen()).toBe(0);
    } finally { screen.dispose(); }
  });

  it('publishes exactly one frame when the update closes', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      screen.write('before');
      await settle();
      paint();
      const seen = frames(screen);
      screen.write('\x1b[?2026h');
      screen.write('\x1b[Hrepaint');
      await settle();
      paint();
      expect(seen()).toBe(0);
      screen.write('\x1b[?2026l');
      await settle();
      paint();
      expect(seen()).toBe(1);
      expect(plain(screen.getLines())[0]).toBe('repaint');
    } finally { screen.dispose(); }
  });

  it('counts nesting, so an inner close does not release the screen', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      const seen = frames(screen);
      screen.write('\x1b[?2026h\x1b[?2026h');
      screen.write('x');
      await settle();
      paint();
      screen.write('\x1b[?2026l');
      await settle();
      paint();
      expect(seen()).toBe(0);
      screen.write('\x1b[?2026l');
      await settle();
      paint();
      expect(seen()).toBe(1);
    } finally { screen.dispose(); }
  });

  it('draws anyway when an update is never closed', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      const seen = frames(screen);
      screen.write('\x1b[?2026h');
      screen.write('stranded');
      await settle();
      paint();
      expect(seen()).toBe(0);
      // A writer that crashed mid-update must not freeze the pane. The hold is
      // capped at the value mode 2026's own specification recommends.
      await new Promise((resolve) => setTimeout(resolve, 200));
      paint();
      expect(seen()).toBe(1);
    } finally { screen.dispose(); }
  });

  it('does not carry a half-open update across a reset', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      screen.write('\x1b[?2026h');
      await settle();
      screen.reset();
      const seen = frames(screen);
      screen.write('after');
      await settle();
      paint();
      expect(seen()).toBeGreaterThan(0);
    } finally { screen.dispose(); }
  });

  it('still hides and shows the caret inside the same handler', async () => {
    const screen = new XtermScreen(20, 5);
    try {
      // Mode 25 and mode 2026 share one CSI ? h/l handler; neither may eat the
      // other, and xterm must still apply every parameter itself.
      screen.write('\x1b[?25l');
      await settle();
      expect(screen.getCursor().visible).toBe(false);
      screen.write('\x1b[?2026h\x1b[?25h\x1b[?2026l');
      await settle();
      expect(screen.getCursor().visible).not.toBe(false);
    } finally { screen.dispose(); }
  });
});
