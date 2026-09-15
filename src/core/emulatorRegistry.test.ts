import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getEmulator,
  disposeEmulator,
  resetAllEmulators,
  resetEmulator,
  resizeEmulator,
  replaceEmulator,
  onScreenParsed,
} from './emulatorRegistry';
import type { TerminalScreen } from './terminalScreen';

const text = (lines: { spans: { text: string }[] }[]) =>
  lines.map((l) => l.spans.map((s) => s.text).join('').replace(/\s+$/, ''));

/** xterm parses asynchronously; every read must follow the write. */
const feed = (screen: TerminalScreen, data: string) =>
  new Promise<void>((resolve) => {
    const off = screen.onParsed(() => {
      off();
      resolve();
    });
    screen.write(data);
  });

describe('emulator registry', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    resetAllEmulators();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('hands back the same emulator for a session so state survives chunks', async () => {
    await feed(getEmulator('s1'), '\x1b[32mgreen start');
    await feed(getEmulator('s1'), ' and still green');
    const line = getEmulator('s1').getLines()[0];
    expect(line.spans.every((s) => s.fg === '#00ff41')).toBe(true);
    expect(text([line])).toEqual(['green start and still green']);
  });

  it('keeps sessions isolated from one another', async () => {
    await feed(getEmulator('a'), 'output for a\r\n');
    await feed(getEmulator('b'), 'output for b\r\n');
    expect(text(getEmulator('a').getLines())[0]).toBe('output for a');
    expect(text(getEmulator('b').getLines())[0]).toBe('output for b');
  });

  it('produces the same rows whether bytes arrive in one chunk or many', async () => {
    const stream =
      '\x1b]3008;start=x;cwd=/tmp\x1b\\\x1b[?2004l' +
      '\x1b[31mError count: 3\x1b[0m\r\nplain row\r\nDownloading  10%\rDownloading 100%\r\n';

    await feed(getEmulator('whole'), stream);
    for (let i = 0; i < stream.length; i += 7) {
      await feed(getEmulator('split'), stream.slice(i, i + 7));
    }

    expect(text(getEmulator('split').getLines())).toEqual(text(getEmulator('whole').getLines()));
  });

  it('resizes one session without touching another', async () => {
    // A split grid holds panes of different sizes. The old global form resized
    // every emulator to whichever pane reported last.
    resizeEmulator('narrow', 20, 4);
    resizeEmulator('wide', 200, 50);

    await feed(getEmulator('narrow'), 'x'.repeat(25));
    await feed(getEmulator('wide'), 'y'.repeat(25));

    expect(text(getEmulator('narrow').getLines()).length).toBe(2);
    expect(text(getEmulator('wide').getLines()).length).toBe(1);
  });

  it('forgets a session when it is disposed', async () => {
    await feed(getEmulator('gone'), 'stale content\r\n');
    disposeEmulator('gone');
    expect(text(getEmulator('gone').getLines())).toEqual(['']);
  });

  it('reports a parse against the session that produced it', async () => {
    const seen: string[] = [];
    const off = onScreenParsed((id) => seen.push(id));
    await feed(getEmulator('reporter'), 'hello');
    off();
    expect(seen).toContain('reporter');
  });

  it('resets a session screen buffer when instructed', async () => {
    await feed(getEmulator('resettable'), 'first run output\r\n');
    expect(text(getEmulator('resettable').getLines())[0]).toBe('first run output');
    resetEmulator('resettable');
    expect(text(getEmulator('resettable').getLines())).toEqual(['']);
  });

  it('explicit cold replacement uses recorded dimensions and rejects old queued parser work', async () => {
    const old = getEmulator('cold');
    const pending = old.writeAndWait('OLD_PENDING');
    const result = pending.then(() => null, error => error as Error);
    const fresh = replaceEmulator('cold', 4, 3);
    expect((await result)?.message).toMatch(/disposed/i);
    expect(getEmulator('cold')).toBe(fresh);
    expect(fresh).not.toBe(old);
    await fresh.writeAndWait('ABCDE');
    expect(text(fresh.getLines())).toEqual(['ABCD', 'E']);
    expect(() => replaceEmulator('cold', 0, 3)).toThrow();
    expect(getEmulator('cold')).toBe(fresh);
  });

  it('refuses an over-budget grid before replacing the cached screen', () => {
    const cached = getEmulator('bounded');
    expect(() => replaceEmulator('bounded', 1025, 1025)).toThrow();
    expect(getEmulator('bounded')).toBe(cached);
  });
});
