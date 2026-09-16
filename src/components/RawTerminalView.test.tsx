import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { RawTerminalView, keyToBytes } from './RawTerminalView';
import { ptyClient } from '../core/ptyClient';
import { resetScrollback, stateOf } from '../core/scrollback';

// jsdom has no ResizeObserver, and a pane given a session id constructs one.
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

const key = (over: Partial<Parameters<typeof keyToBytes>[0]>) =>
  keyToBytes({ key: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...over });

describe('keyToBytes', () => {
  it('sends plain characters as themselves', () => {
    expect(key({ key: 'a' })).toBe('a');
    expect(key({ key: '?' })).toBe('?');
  });

  it('encodes the named keys a TUI listens for', () => {
    expect(key({ key: 'Enter' })).toBe('\r');
    expect(key({ key: 'Backspace' })).toBe('\x7f');
    expect(key({ key: 'Escape' })).toBe('\x1b');
    expect(key({ key: 'ArrowUp' })).toBe('\x1b[A');
    expect(key({ key: 'Home' })).toBe('\x1b[H');
    expect(key({ key: 'End' })).toBe('\x1b[F');
    expect(key({ key: 'Delete' })).toBe('\x1b[3~');
  });

  it('encodes Ctrl+letter as its control character', () => {
    // Only ctrl+c/d/z used to be handled, so an agent's readline bindings —
    // Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+W — never reached it at all.
    expect(key({ key: 'a', ctrlKey: true })).toBe('\x01');
    expect(key({ key: 'e', ctrlKey: true })).toBe('\x05');
    expect(key({ key: 'u', ctrlKey: true })).toBe('\x15');
    expect(key({ key: 'w', ctrlKey: true })).toBe('\x17');
  });

  it('encodes Shift+Enter as the newline an agent composer listens for', () => {
    // ESC CR is not a guess. It is the sequence Claude Code's own
    // `/terminal-setup` installs into iTerm2, VS Code, Alacritty and Zed for
    // exactly this key — verified in the shipped 2.1.260 binary, which carries
    // `{key:"shift+enter", command:"…sendSequence", args:{text:"\x1B\r"}}`.
    // Plain Enter still submits, which is the whole point.
    expect(key({ key: 'Enter', shiftKey: true })).toBe('\x1b\r');
    expect(key({ key: 'Enter' })).toBe('\r');
  });

  it('encodes Alt+Enter the same way, because that is what Alt means', () => {
    // Alt+key is ESC-prefixed everywhere else in this table; Enter was the one
    // named key that silently dropped the prefix and submitted instead.
    expect(key({ key: 'Enter', altKey: true })).toBe('\x1b\r');
  });

  it('leaves Ctrl+Enter to the process', () => {
    // Ctrl+Enter has no legacy encoding, and inventing one would put bytes on
    // the wire that no agent asked for.
    expect(key({ key: 'Enter', ctrlKey: true })).toBe('\r');
  });

  it('encodes Shift+Tab as back-tab, not a plain tab', () => {
    expect(key({ key: 'Tab' })).toBe('\t');
    expect(key({ key: 'Tab', shiftKey: true })).toBe('\x1b[Z');
  });

  it('encodes Alt+key with an ESC prefix', () => {
    expect(key({ key: 'b', altKey: true })).toBe('\x1bb');
  });

  it('sends nothing for keys that are not input', () => {
    expect(key({ key: 'Shift' })).toBeNull();
    expect(key({ key: 'F5' })).toBeNull();
    expect(key({ key: 'v', metaKey: true })).toBeNull();
  });
});

describe('RawTerminalView', () => {
  const base = {
    lines: [],
    onWrite: vi.fn(),
    onPasteText: vi.fn().mockResolvedValue(undefined),
    onSendSignal: vi.fn(),
  };

  it('does not draw a caret hidden by the foreground application', () => {
    render(<RawTerminalView {...base} isActive
      lines={[{ id: 'row', spans: [{ text: 'TUI' }], timestamp: 0 }]}
      cursor={{ row: 0, col: 1, visible: false }} />);
    expect(screen.queryByTestId('terminal-cursor')).toBeNull();
  });

  it('restores detached scrollback on remount before following new output', () => {
    resetScrollback('remount');
    const lines = [{ id: 'line', spans: [{ text: 'tail' }], timestamp: 0 }];
    const props = { ...base, sessionId: 'remount', isActive: true, lines };
    const first = render(<RawTerminalView {...props} />);
    const scroller = screen.getByTestId('raw-terminal').firstElementChild as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    fireEvent.wheel(scroller, { deltaY: -100 });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    first.unmount();
    render(<RawTerminalView {...props} />);
    const restored = screen.getByTestId('raw-terminal').firstElementChild as HTMLDivElement;
    expect(restored.scrollTop).toBe(300);
    expect(stateOf('remount').detached).toBe(true);
  });

  it('keeps an unfocused split pane following newly arriving output', () => {
    const first = [{ id: 'line', spans: [{ text: 'first' }], timestamp: 0 }];
    const view = render(<RawTerminalView {...base} sessionId="background-follow" isActive={false} lines={first} />);
    const scroller = screen.getByTestId('raw-terminal').firstElementChild as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    view.rerender(<RawTerminalView {...base} sessionId="background-follow" isActive={false}
      lines={[...first, { id: 'next', spans: [{ text: 'next' }], timestamp: 0 }]} />);
    expect(scroller.scrollTop).toBe(1000);
  });

  it('takes the keyboard as soon as it is the active pane', () => {
    // Without this the view mounted unfocused: its keydown handler could not be
    // reached, every keystroke fell through to the window shortcuts, and the
    // terminal looked broken with nothing on screen saying why.
    render(<RawTerminalView {...base} isActive />);
    expect(document.activeElement).toBe(screen.getByTestId('raw-terminal'));
  });

  it('keeps following the tail across layout scrolls until the user explicitly scrolls', () => {
    resetScrollback('follow');
    render(<RawTerminalView {...base} sessionId="follow" isActive lines={[
      { id: 'line', spans: [{ text: 'tail' }], timestamp: 0 },
    ]} />);
    const scroller = screen.getByTestId('raw-terminal').firstElementChild as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    scroller.scrollTop = 400;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(1000);
    expect(stateOf('follow').detached).toBe(false);

    fireEvent.wheel(scroller, { deltaY: -100 });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(300);
    expect(stateOf('follow').detached).toBe(true);
    resetScrollback('follow');
  });

  it('releases the tail on the wheel itself, not on the scroll event that follows', () => {
    // A `scroll` event is dispatched asynchronously, but a running agent
    // re-renders this view every frame. Output landing in the gap between the
    // wheel and the scroll event used to run the follow effect while the view
    // still believed it was attached, which yanked the reader straight back to
    // the bottom and then swallowed the intent flag. Scrolling up during a
    // build was a fight you could not win.
    resetScrollback('race');
    const lines = [{ id: 'a', row: 0, spans: [{ text: 'a' }], timestamp: 0 }];
    const props = { ...base, sessionId: 'race', isActive: true };
    const view = render(<RawTerminalView {...props} lines={lines} />);
    const scroller = screen.getByTestId('raw-terminal').firstElementChild as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });

    fireEvent.wheel(scroller, { deltaY: -100 });
    scroller.scrollTop = 300;
    expect(stateOf('race').detached).toBe(true);

    // The agent writes another line before the scroll event is delivered.
    view.rerender(
      <RawTerminalView {...props} lines={[...lines, { id: 'b', row: 1, spans: [{ text: 'b' }], timestamp: 0 }]} />,
    );
    expect(scroller.scrollTop).toBe(300);

    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(300);
    expect(stateOf('race').detached).toBe(true);
    resetScrollback('race');
  });

  it('leaves the viewport alone when a pane merely becomes the active one', () => {
    // Panes stay mounted, so the browser has kept this one's scroll offset.
    // Re-running the follow effect on activation threw that away and reached
    // for the newest output, which is the jump you saw on every switch.
    resetScrollback('switch');
    const lines = [{ id: 'a', row: 0, spans: [{ text: 'a' }], timestamp: 0 }];
    const props = { ...base, sessionId: 'switch', lines };
    const view = render(<RawTerminalView {...props} isActive={false} />);
    const scroller = screen.getByTestId('raw-terminal').firstElementChild as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    scroller.scrollTop = 250;

    view.rerender(<RawTerminalView {...props} isActive />);
    expect(scroller.scrollTop).toBe(250);
    resetScrollback('switch');
  });

  it('holds a detached reader on the same text while scrollback trims above them', () => {
    // xterm drops the oldest row once the buffer passes its 5000-line limit, so
    // every row below slides up one line box. A reader pinned to a pixel offset
    // watched the text they were reading crawl away for as long as the agent
    // kept writing. The absolute buffer row is on every line, so the count is
    // measured rather than guessed.
    const rowHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 17 });
    try {
      resetScrollback('trim');
      const props = { ...base, sessionId: 'trim', isActive: true };
      const row = (n: number) => ({ id: `row-${n}`, row: n, spans: [{ text: `${n}` }], timestamp: 0 });
      const view = render(<RawTerminalView {...props} lines={[row(0), row(1), row(2)]} />);
      const scroller = screen.getByTestId('raw-terminal').firstElementChild as HTMLDivElement;
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 100 },
      });
      fireEvent.wheel(scroller, { deltaY: -100 });
      scroller.scrollTop = 300;
      fireEvent.scroll(scroller);
      expect(stateOf('trim').detached).toBe(true);

      // Two rows fall off the top: the window now starts at buffer row 2.
      view.rerender(<RawTerminalView {...props} lines={[row(2), row(3), row(4)]} />);
      expect(scroller.scrollTop).toBe(300 - 2 * 17);
      resetScrollback('trim');
    } finally {
      if (rowHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', rowHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    }
  });

  it('does not steal the keyboard when it is not the active pane', () => {
    render(<RawTerminalView {...base} isActive={false} />);
    expect(document.activeElement).not.toBe(screen.getByTestId('raw-terminal'));
  });

  it('writes typed characters straight through to the PTY', () => {
    const onWrite = vi.fn();
    render(<RawTerminalView {...base} onWrite={onWrite} isActive />);
    const term = screen.getByTestId('raw-terminal');
    fireEvent.keyDown(term, { key: 'h' });
    fireEvent.keyDown(term, { key: 'i' });
    fireEvent.keyDown(term, { key: 'Enter' });
    expect(onWrite.mock.calls.map((c) => c[0])).toEqual(['h', 'i', '\r']);
  });

  it('returns keyboard focus to the terminal after quick-select insertion', () => {
    const onWrite = vi.fn();
    render(<RawTerminalView {...base} onWrite={onWrite} lines={[
      { id: 'url', spans: [{ text: 'https://example.test/probe' }], timestamp: 0 },
    ]} />);
    const terminal = screen.getByTestId('raw-terminal');
    fireEvent.keyDown(terminal, { key: 'E', ctrlKey: true, shiftKey: true });
    const target = screen.getByRole('button', { name: /https:\/\/example.test\/probe/ });
    act(() => target.focus());
    fireEvent.keyDown(target, { key: 'Enter', shiftKey: true });
    expect(onWrite).toHaveBeenCalledWith('https://example.test/probe');
    expect(document.activeElement).toBe(terminal);
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onWrite).toHaveBeenLastCalledWith('\r');
  });

  it('routes control chords through the terminal signal-input API', () => {
    const onWrite = vi.fn();
    const onSendSignal = vi.fn();
    render(<RawTerminalView {...base} onWrite={onWrite} onSendSignal={onSendSignal} isActive />);
    fireEvent.keyDown(screen.getByTestId('raw-terminal'), { key: 'c', ctrlKey: true });
    expect(onSendSignal).toHaveBeenCalledWith('ctrl+c');
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('leaves Ctrl+Shift chords for the app', () => {
    const onWrite = vi.fn();
    render(<RawTerminalView {...base} onWrite={onWrite} isActive />);
    fireEvent.keyDown(screen.getByTestId('raw-terminal'), {
      key: 'P', ctrlKey: true, shiftKey: true,
    });
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('refuses multi-line paste before bracketed-paste mode is known', () => {
    const onWrite = vi.fn();
    render(<RawTerminalView {...base} onWrite={onWrite} isActive />);
    fireEvent.paste(screen.getByTestId('raw-terminal'), {
      clipboardData: { getData: () => 'one\ntwo' },
    });
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('reads the system clipboard on Ctrl+Shift+V', async () => {
    const onWrite = vi.fn();
    const onPasteText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue('clipboard text');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
    render(<RawTerminalView {...base} onWrite={onWrite} onPasteText={onPasteText} isActive />);
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('raw-terminal'), {
        key: 'V', ctrlKey: true, shiftKey: true,
      });
    });
    await vi.waitFor(() => expect(onPasteText).toHaveBeenCalledWith('clipboard text'));
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('executes a requested scrollback search in the active pane', () => {
    const onWrite = vi.fn();
    render(
      <RawTerminalView
        {...base}
        onWrite={onWrite}
        sessionId="session-1"
        isActive
        viewActionRequest={{ id: 1, sessionId: 'session-1', action: 'searchScrollback' }}
      />,
    );

    fireEvent.keyDown(screen.getByTestId('raw-terminal'), { key: 'n' });

    expect(onWrite).not.toHaveBeenCalled();
  });

  it('executes each requested view action exactly once', async () => {
    const onWrite = vi.fn();
    const onPasteText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue('clipboard text');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
    const request = { id: 7, sessionId: 'session-1', action: 'pasteClipboard' as const };
    const { rerender } = render(
      <RawTerminalView {...base} onWrite={onWrite} onPasteText={onPasteText} sessionId="session-1" isActive viewActionRequest={request} />,
    );
    await act(async () => {});
    await vi.waitFor(() => expect(onPasteText).toHaveBeenCalledOnce());

    rerender(<RawTerminalView {...base} onWrite={onWrite} onPasteText={onPasteText} sessionId="session-1" isActive viewActionRequest={request} />);

    await vi.waitFor(() => expect(readText).toHaveBeenCalledOnce());
    expect(onPasteText).toHaveBeenCalledOnce();
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('acknowledges a request so remounting the pane cannot replay it', async () => {
    const onWrite = vi.fn();
    const onPasteText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue('clipboard text');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
    const initialRequest = { id: 9, sessionId: 'session-1', action: 'pasteClipboard' as const };

    function Harness({ mounted }: { mounted: boolean }) {
      const [request, setRequest] = useState<typeof initialRequest | null>(initialRequest);
      if (!mounted) return null;
      return (
        <RawTerminalView
          {...base}
          onWrite={onWrite}
          onPasteText={onPasteText}
          sessionId="session-1"
          isActive
          viewActionRequest={request}
          onViewActionHandled={(id) => setRequest((current) => current?.id === id ? null : current)}
        />
      );
    }

    const { rerender } = render(<Harness mounted />);
    await act(async () => {});
    await vi.waitFor(() => expect(onPasteText).toHaveBeenCalledOnce());

    rerender(<Harness mounted={false} />);
    rerender(<Harness mounted />);

    await Promise.resolve();
    expect(readText).toHaveBeenCalledOnce();
    expect(onPasteText).toHaveBeenCalledOnce();
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('ignores requested view actions in inactive panes', async () => {
    const onWrite = vi.fn();
    const readText = vi.fn().mockResolvedValue('hidden');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
    render(
      <RawTerminalView
        {...base}
        onWrite={onWrite}
        isActive={false}
        sessionId="session-1"
        viewActionRequest={{ id: 8, sessionId: 'session-1', action: 'pasteClipboard' }}
      />,
    );

    await Promise.resolve();
    expect(readText).not.toHaveBeenCalled();
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('draws no chrome of its own — the plate is the only chrome', () => {
    // This replaces two tests that asserted on a header bar carrying the agent
    // name and a KEYBOARD LIVE badge. Both facts are the plate's job now: it
    // already draws the agent in its own well, and duplicating them here was
    // one of the three places path, branch and agent were each shown.
    const { container } = render(<RawTerminalView {...base} isActive />);
    expect(container.textContent).not.toMatch(/HOLDS THE KEYBOARD/);
    expect(container.textContent).not.toMatch(/KEYBOARD LIVE|CLICK TO TYPE/);
    expect(container.textContent).not.toMatch(/Line Discipline/);
    // Nothing raised inside the pane at all: no plate surface, only the recess.
    expect(container.querySelector('.plate')).toBeNull();
  });

  it('reports its grid size for the session it belongs to', () => {
    // Before this, every session ran at a hardcoded 120x30 for its whole life:
    // nothing ever called resizeSession, so SIGWINCH never fired.
    //
    // jsdom gives every element a zero layout box, and the hook deliberately
    // ignores those, so give the prototype a real one for this test.
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700);
    const h = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450);
    const spy = vi.spyOn(ptyClient, 'resizeSession').mockImplementation(() => {});

    render(<RawTerminalView {...base} sessionId="session-1" isActive />);

    expect(spy).toHaveBeenCalledWith('session-1', expect.any(Number), expect.any(Number));
    spy.mockRestore();
    w.mockRestore();
    h.mockRestore();
  });

  it('never renders a cursor in an inactive pane', () => {
    render(
      <RawTerminalView
        {...base}
        isActive={false}
        cursor={{ row: 0, col: 5 }}
        lines={[{ id: 'line-0', row: 0, spans: [{ text: 'hello' }], timestamp: 0 }]}
      />,
    );
    expect(screen.queryByTestId('terminal-cursor')).toBeNull();
  });

  it('renders a cursor when active and focused on the matching buffer row', () => {
    render(
      <RawTerminalView
        {...base}
        isActive
        cursor={{ row: 1, col: 3 }}
        lines={[
          { id: 'line-0', row: 0, spans: [{ text: 'first' }], timestamp: 0 },
          { id: 'line-1', row: 1, spans: [{ text: 'second' }], timestamp: 0 },
        ]}
      />,
    );
    const terminal = screen.getByTestId('raw-terminal');
    fireEvent.focus(terminal);

    const cursorEl = screen.getByTestId('terminal-cursor');
    expect(cursorEl).toBeDefined();
    expect(cursorEl.style.left).toBe('calc(var(--terminal-cell-width, 1ch) * 3)');
    // Ensure cursor is placed inside line-1
    const line1 = screen.getByTestId('raw-terminal').querySelector('[data-terminal-line="1"]');
    expect(line1?.contains(cursorEl)).toBe(true);
  });

  it('renders a hollow cursor when active but unfocused', () => {
    render(
      <RawTerminalView
        {...base}
        isActive
        cursor={{ row: 0, col: 2 }}
        lines={[{ id: 'line-0', row: 0, spans: [{ text: 'hello' }], timestamp: 0 }]}
      />,
    );
    const terminal = screen.getByTestId('raw-terminal');
    fireEvent.blur(terminal);

    const cursorEl = screen.getByTestId('terminal-cursor');
    expect(cursorEl).toBeDefined();
    expect(cursorEl.style.background).toBe('transparent');
    expect(cursorEl.style.boxShadow).toBe('inset 0 0 0 1px var(--st-live)');
  });

  it('renders all scrollback lines maintaining complete DOM visibility', () => {
    const manyLines = Array.from({ length: 300 }, (_, idx) => ({
      id: `row-${idx}`,
      row: idx,
      spans: [{ text: `output line ${idx}` }],
      timestamp: idx,
    }));

    render(
      <RawTerminalView
        {...base}
        isActive
        sessionId="scrollback-test"
        lines={manyLines}
      />,
    );

    const terminal = screen.getByTestId('raw-terminal');
    const renderedRows = terminal.querySelectorAll('[data-terminal-line]');
    expect(renderedRows.length).toBe(300);
  });
});

describe('the caret is reverse video, not a colour blend', () => {
  const base = {
    lines: [],
    onWrite: vi.fn(),
    onPasteText: vi.fn().mockResolvedValue(undefined),
    onSendSignal: vi.fn(),
  };

  const withCaret = (cursor: { row: number; col: number; glyph?: string; cells?: number }) => {
    render(
      <RawTerminalView
        {...base}
        isActive
        cursor={cursor}
        lines={[{ id: 'line-0', row: 0, spans: [{ text: 'echo', cols: 4 }], timestamp: 0 }]}
      />,
    );
    fireEvent.focus(screen.getByTestId('raw-terminal'));
    return screen.getByTestId('terminal-cursor');
  };

  /*
   * The bug this replaces: the caret was an amber block with
   * `mix-blend-mode: difference`, so the character under it came out at
   * whatever difference(caret, textColour) happens to be. Bone text #e8dcbc
   * under the caret #e0a92c is #083390 — navy on amber, a colour that is in
   * none of the five canonical state colours and is contrast-guarded against
   * nothing. On screen it reads as a yellow rectangle over the character.
   */
  it('repaints the character on the block instead of blending with it', () => {
    const caret = withCaret({ row: 0, col: 0, glyph: 'e' });
    expect(caret.textContent).toBe('e');
    expect(caret.style.color).toBe('var(--ground)');
    expect(caret.style.backgroundColor || caret.style.background).toContain('var(--st-live)');
  });

  it('uses no blend mode at all', () => {
    expect(withCaret({ row: 0, col: 0, glyph: 'e' }).style.mixBlendMode).toBe('');
  });

  it('covers both cells of a double-width character', () => {
    const caret = withCaret({ row: 0, col: 0, glyph: '漢', cells: 2 });
    expect(caret.style.width).toBe('calc(var(--terminal-cell-width, 1ch) * 2)');
  });

  it('is one cell wide over anything else', () => {
    expect(withCaret({ row: 0, col: 2, glyph: 'h' }).style.width)
      .toBe('calc(var(--terminal-cell-width, 1ch) * 1)');
  });

  it('draws the glyph on the same grid as the text it covers', () => {
    expect(withCaret({ row: 0, col: 0, glyph: 'e' }).style.letterSpacing)
      .toBe('var(--terminal-tracking, 0px)');
  });

  it('draws no glyph while the pane is unfocused — the real text shows through', () => {
    render(
      <RawTerminalView
        {...base}
        isActive
        cursor={{ row: 0, col: 0, glyph: 'e' }}
        lines={[{ id: 'line-0', row: 0, spans: [{ text: 'echo', cols: 4 }], timestamp: 0 }]}
      />,
    );
    // An active pane takes the keyboard on mount, so losing focus is what
    // produces the hollow caret — the window went elsewhere, not the pane.
    fireEvent.blur(screen.getByTestId('raw-terminal'));
    const caret = screen.getByTestId('terminal-cursor');
    expect(caret.textContent).toBe('');
    expect(caret.style.boxShadow).toBe('inset 0 0 0 1px var(--st-live)');
  });
});
