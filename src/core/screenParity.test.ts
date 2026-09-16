/**
 * The hand-written emulator's own corpus, run against XtermScreen.
 *
 * This is what makes deleting terminalEmulator.ts safe: every assertion below
 * was written against a real defect that file was fixed for, so a regression in
 * the replacement shows up here rather than in a terminal.
 *
 * DIVERGENCES FROM THE ORIGINAL — each one decided, not drifted:
 *
 *   1. Bare LF. `keeps the active colour across separate writes` feeds '\n'
 *      rather than '\r\n'. The old emulator defaulted convertEol:true ("PTYs
 *      deliver CRLF anyway; this keeps bare-LF streams from staircasing");
 *      xterm defaults it off, so the first run staircased each line further
 *      right. Resolved by setting convertEol on the Terminal rather than by
 *      relaxing the assertion — the behaviour is preserved exactly, and a
 *      staircase would have been a visible regression.
 *
 *   Every other assertion carried across unchanged on the first run: 26 of 27.
 *
 * NOT PORTED: the `shell integration and working directory` suite asserted on
 * the TerminalEvents callbacks, an interface that never had a caller and is now
 * deleted. The Rust demuxer supplies those events — see demuxer.rs
 * (test_osc_133_demuxing, osc_3008_reports_the_working_directory,
 * osc_7_reports_the_working_directory). That the records never reach the screen
 * is still covered here, under `escape sequences never reach the screen`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XtermScreen } from './xtermScreen';

/** xterm parses asynchronously; every read must follow the write. */
const feed = (screen: XtermScreen, data: string) =>
  new Promise<void>((resolve) => {
    const off = screen.onParsed(() => {
      off();
      resolve();
    });
    screen.write(data);
  });

/** Visible text of each rendered row, trailing blanks trimmed. */
const rows = (screen: XtermScreen): string[] =>
  screen.getLines().map((l) => l.spans.map((s) => s.text).join('').replace(/\s+$/, ''));

const make = (cols = 120, r = 30) => new XtermScreen(cols, r);

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('escape sequences never reach the screen', () => {
  it('swallows bracketed paste mode', async () => {
    const s = make();
    await feed(s, '\x1b[?2004hhello\x1b[?2004l');
    expect(rows(s)).toEqual(['hello']);
  });

  it('swallows cursor visibility, synchronised output and cursor style', async () => {
    const s = make();
    await feed(s, '\x1b[?25l\x1b[?2026hframe\x1b[?2026l\x1b[0 q\x1b[?25h');
    expect(rows(s)).toEqual(['frame']);
  });

  it('swallows XTMODKEYS and kitty keyboard sequences', async () => {
    const s = make();
    await feed(s, '\x1b[>4;0m\x1b[>5u\x1b[=1;1u\x1b[?utext');
    expect(rows(s)).toEqual(['text']);
  });

  it('swallows OSC title and shell integration records', async () => {
    const s = make();
    await feed(s, '\x1b]0;user@host:~/dir\x07\x1b]133;D;0\x1b\\ready');
    expect(rows(s)).toEqual(['ready']);
  });

  it('swallows the ptyxis OSC 3008 record that dominates real prompts', async () => {
    const s = make();
    await feed(s, '\x1b]3008;start=abc;machineid=def;cwd=/tmp\x1b\\backend  index.html');
    expect(rows(s)).toEqual(['backend  index.html']);
  });

  it('renders an OSC 8 hyperlink as its label, not its URL', async () => {
    const s = make();
    await feed(s, '\x1b]8;;https://example.dev\x07/rc\x1b]8;;\x07');
    expect(rows(s)).toEqual(['/rc']);
  });

  it('swallows save and restore cursor without emitting stray digits', async () => {
    const s = make();
    await feed(s, '\x1b7text\x1b8');
    expect(rows(s)).toEqual(['text']);
  });
});

describe('in-line cursor control', () => {
  it('returns to column zero on carriage return instead of starting a new row', async () => {
    const s = make();
    await feed(s, 'Downloading  10%\rDownloading  55%\rDownloading 100%');
    expect(rows(s)).toEqual(['Downloading 100%']);
  });

  it('keeps a spinner on a single row', async () => {
    const s = make();
    for (const f of ['⠋', '⠙', '⠹', '⠸', '⠼']) await feed(s, `\r${f} Building...`);
    expect(rows(s)).toEqual(['⠼ Building...']);
  });

  it('moves the cursor back on backspace so following text overwrites', async () => {
    const s = make();
    await feed(s, 'abcXX\b\bYY');
    expect(rows(s)).toEqual(['abcYY']);
  });

  it('advances to the next eight column stop on tab', async () => {
    const s = make();
    await feed(s, 'a\tb');
    expect(rows(s)).toEqual(['a       b']);
  });

  it('erases to end of line on EL', async () => {
    const s = make();
    await feed(s, 'STALE TEXT HERE\r\x1b[Kfresh');
    expect(rows(s)).toEqual(['fresh']);
  });

  it('pads columns on cursor-forward so words do not fuse', async () => {
    const s = make();
    await feed(s, 'Run\x1b[3C/init\x1b[3Cto create');
    expect(rows(s)).toEqual(['Run   /init   to create']);
  });
});

describe('parser state survives chunk boundaries', () => {
  it('keeps the active colour across separate writes', async () => {
    const s = make();
    await feed(s, '\x1b[32mline one\nline t');
    await feed(s, 'wo\nline three\x1b[0m\n');
    const lines = s.getLines();
    expect(rows(s).slice(0, 3)).toEqual(['line one', 'line two', 'line three']);
    for (const l of lines.slice(0, 3)) {
      expect(l.spans[0].fg).toBe('#00ff41');
    }
  });

  it('reassembles an escape sequence split across two writes', async () => {
    const s = make();
    await feed(s, 'red then \x1b[3');
    await feed(s, '1mRED');
    const line = s.getLines()[0];
    expect(line.spans.map((sp) => sp.text).join('')).toBe('red then RED');
    expect(line.spans[line.spans.length - 1].fg).toBe('#ff4444');
  });

  it('reassembles an OSC split across two writes', async () => {
    const s = make();
    await feed(s, '\x1b]0;some ti');
    await feed(s, 'tle\x07visible');
    expect(rows(s)).toEqual(['visible']);
  });
});

describe('cursor addressing', () => {
  it('places text by absolute position instead of appending it', async () => {
    const s = make(40, 6);
    await feed(s, '\x1b[1;1H┌────────┐');
    await feed(s, '\x1b[2;1H│ Codex  │');
    await feed(s, '\x1b[3;1H└────────┘');
    expect(rows(s)).toEqual(['┌────────┐', '│ Codex  │', '└────────┘']);
  });

  it('overwrites in place when the cursor is moved back up', async () => {
    const s = make(40, 6);
    await feed(s, 'first\r\nsecond\r\n');
    await feed(s, '\x1b[2A\x1b[0Kredrawn');
    expect(rows(s)).toEqual(['redrawn', 'second']);
  });

  it('clears the screen on ED 2', async () => {
    const s = make(40, 6);
    await feed(s, 'junk one\r\njunk two\r\n');
    await feed(s, '\x1b[2J\x1b[Hclean');
    expect(rows(s)).toEqual(['clean']);
  });

  it('erases characters under the cursor on ECH', async () => {
    const s = make(40, 4);
    await feed(s, 'abcdefgh\r\x1b[3C\x1b[3X');
    expect(rows(s)).toEqual(['abc   gh']);
  });
});

describe('alternate screen', () => {
  it('keeps its content separate from the shell buffer', async () => {
    const s = make(40, 5);
    await feed(s, 'shell line\r\n');
    await feed(s, '\x1b[?1049h\x1b[Hfullscreen app');
    expect(s.isAltScreen()).toBe(true);
    expect(rows(s)).toEqual(['fullscreen app', '', '', '', '']);

    await feed(s, '\x1b[?1049l');
    expect(s.isAltScreen()).toBe(false);
    expect(rows(s)).toEqual(['shell line', '']);
  });
});

describe('block scoping via marks', () => {
  it('returns only the rows produced after the mark', async () => {
    const s = make(40, 4);
    await feed(s, 'old one\r\nold two\r\n');
    const mark = s.mark();
    await feed(s, 'new one\r\nnew two\r\n');
    const text = s
      .linesSince(mark)
      .map((l) => l.spans.map((sp) => sp.text).join('').replace(/\s+$/, ''));
    expect(text).toEqual(['new one', 'new two', '']);
  });

  it('still scopes correctly after rows have scrolled into scrollback', async () => {
    const s = make(40, 3);
    for (let i = 1; i <= 8; i++) await feed(s, `line ${i}\r\n`);
    const mark = s.mark();
    for (let i = 9; i <= 12; i++) await feed(s, `line ${i}\r\n`);
    const text = s
      .linesSince(mark)
      .map((l) => l.spans.map((sp) => sp.text).join('').replace(/\s+$/, ''));
    expect(text).toEqual(['line 9', 'line 10', 'line 11', 'line 12', '']);
  });
});

describe('error detection is anchored, not keyword soup', () => {
  const flag = async (str: string) => {
    const s = make();
    await feed(s, str);
    return s.getLines()[0].isError === true;
  };

  it('flags real failure announcements', async () => {
    expect(await flag("error: pathspec 'nope' did not match any file(s) known to git")).toBe(true);
    expect(await flag('fatal: not a git repository')).toBe(true);
    expect(await flag('npm ERR! code ELIFECYCLE')).toBe(true);
    expect(await flag('src/main.rs:12:5: error[E0433]: failed to resolve')).toBe(true);
    expect(await flag('Traceback (most recent call last):')).toBe(true);
  });

  it('does not flag ordinary lines that merely contain the word', async () => {
    expect(await flag('src/errorHandler.go')).toBe(false);
    expect(await flag('commit 1a2b3c fix error handling')).toBe(false);
    expect(await flag('69:      /\\b(error|panic|fatal|exception)\\b/i.test(rawLine) ||')).toBe(
      false
    );
    expect(await flag('grep -rn --color=always error src/core/xtermLines.ts')).toBe(false);
    expect(await flag('all tests passed')).toBe(false);
  });
});

describe('regression: bytes captured from the live PTY daemon', () => {
  it('renders a real prompt with no escape debris', async () => {
    const s = make(120, 30);
    await feed(
      s,
      '\x1b[?2004l\r\r\n\x1b]0;cleadmon@SER6-MAX:~/Projects/Doom Term\x07' +
        '\x1b]3008;end=495defbd;exit=success\x1b\\' +
        '\x1b]3008;start=5037d730;machineid=2ad0ceaf;user=cleadmon;hostname=SER6-MAX;cwd=/home/cleadmon/Projects/Doom Term\x1b\\' +
        '\x1b[?2004h\x1b[01;32mcleadmon@SER6-MAX\x1b[00m:\x1b[01;34m~/Projects/Doom Term\x1b[00m$ '
    );
    const text = rows(s);
    expect(text.join('\n')).not.toMatch(/\?2004|]0;|]3008|machineid/);
    expect(text[text.length - 1]).toBe('cleadmon@SER6-MAX:~/Projects/Doom Term$');
  });

  it('renders a real ls row without the OSC blob glued to its front', async () => {
    const s = make(120, 30);
    await feed(
      s,
      '\x1b]3008;start=55e4f8ff;machineid=2ad0ceaf;type=command;cwd=/home/cleadmon/Projects/Doom Term\x1b\\' +
        'backend                 index.html         postcss.config.js\r\n' +
        'dist                    node_modules       public\r\n'
    );
    expect(rows(s)[0]).toBe('backend                 index.html         postcss.config.js');
  });
});
