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
    expect(cursorEl.style.left).toBe('3ch');
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
