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
