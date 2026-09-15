import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RawTerminalView } from './RawTerminalView';
import { getEmulator, resetAllEmulators } from '../core/emulatorRegistry';

const sessionId = 'clipboard-fixture';
const props = { lines: [], sessionId, onWrite: vi.fn(), onPasteText: vi.fn().mockResolvedValue(undefined), onSendSignal: vi.fn() };
const paste = () => fireEvent.paste(screen.getByTestId('raw-terminal'), {
  clipboardData: { getData: () => 'one\rtwo' },
});
const pasteChord = () => fireEvent.keyDown(screen.getByTestId('raw-terminal'), {
  key: 'V', ctrlKey: true, shiftKey: true,
});
const feed = (data: string) => new Promise<void>(resolve => {
  const emu = getEmulator(sessionId);
  const off = emu.onParsed(() => { off(); resolve(); });
  emu.write(data);
});
function delayedClipboard() {
  let resolve!: (text: string) => void;
  const pending = new Promise<string>(done => { resolve = done; });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => pending } });
  return resolve;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  resetAllEmulators();
});
afterEach(() => {
  expect(props.onWrite).not.toHaveBeenCalled();
  resetAllEmulators(); vi.unstubAllGlobals();
});

describe('terminal clipboard safety', () => {
  it('cancels an asynchronous clipboard read when ownership changes without any screen output', async () => {
    const resolve = delayedClipboard();
    let permit = { id: sessionId, incarnation: '1'.repeat(32), attachment_id: '2'.repeat(32) };
    render(<RawTerminalView {...props} captureInputIdentity={() => permit} />);
    pasteChord();
    permit = { ...permit, attachment_id: '3'.repeat(32) };
    await act(async () => { resolve('old controller input'); });
    expect(props.onPasteText).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/ownership changed/i);
  });

  it('carries the captured ownership fence through a successful asynchronous clipboard read', async () => {
    const resolve = delayedClipboard();
    const permit = { id: sessionId, incarnation: '1'.repeat(32), attachment_id: '2'.repeat(32) };
    render(<RawTerminalView {...props} captureInputIdentity={() => permit} />);
    pasteChord(); await act(async () => { resolve('exact controller input'); });
    expect(props.onPasteText).toHaveBeenCalledWith('exact controller input', permit);
  });
  it('refuses multiline paste when the child has not enabled bracketed paste', () => {
    render(<RawTerminalView {...props} />);
    paste();
    expect(props.onPasteText).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/bracketed.paste/i);
  });

  it('uses this pane’s current parsed bracketed-paste mode, including disabling it', async () => {
    render(<RawTerminalView {...props} />);
    await act(() => feed('\x1b[?2004h'));
    paste();
    expect(props.onPasteText).toHaveBeenCalledWith('one\ntwo');
    props.onPasteText.mockClear();
    await act(() => feed('\x1b[?2004l'));
    paste();
    expect(props.onPasteText).not.toHaveBeenCalled();
  });

  it('does not trust an enabled mode while new terminal output is still being parsed', async () => {
    render(<RawTerminalView {...props} />);
    await act(() => feed('\x1b[?2004h'));
    await act(async () => {
      const parsed = feed('\x1b[?2004l');
      paste();
      expect(props.onPasteText).not.toHaveBeenCalled();
      await parsed;
    });
  });

  it('does not paste through another transient keyboard owner', async () => {
    const { pushModalKeyboardOwner } = await import('../core/modalKeyboard');
    render(<RawTerminalView {...props} />);
    await act(() => feed('\x1b[?2004h'));
    const release = pushModalKeyboardOwner(() => {});
    try { paste(); } finally { release(); }
    expect(props.onPasteText).not.toHaveBeenCalled();
  });

  it('reports failed selection copies without an unhandled rejection', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: () => Promise.reject(new Error('permission denied')),
    } });
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'selected text' } as Selection);
    try {
      render(<RawTerminalView {...props} />);
      fireEvent.keyDown(screen.getByTestId('raw-terminal'), { key: 'C', ctrlKey: true, shiftKey: true });
      expect((await screen.findByRole('status')).textContent).toMatch(/clipboard copy.*(unavailable|denied)/i);
    } finally { selection.mockRestore(); }
  });

  it('shows clipboard read failures instead of silently failing or rejecting unhandled', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: () => Promise.reject(new Error('permission denied')),
    } });
    render(<RawTerminalView {...props} />);
    pasteChord();
    expect((await screen.findByRole('status')).textContent).toMatch(/clipboard.*(unavailable|read|denied)/i);
    expect(props.onPasteText).not.toHaveBeenCalled();
  });

  it('does not deliver delayed clipboard input after switching away and back', async () => {
    const resolve = delayedClipboard();
    const { rerender } = render(<RawTerminalView {...props} />);
    pasteChord();
    rerender(<RawTerminalView {...props} isActive={false} />);
    rerender(<RawTerminalView {...props} isActive />);
    await act(async () => { resolve('stale command'); });
    expect(props.onPasteText).not.toHaveBeenCalled();
  });

  it('does not deliver delayed clipboard input after the terminal output changes', async () => {
    const resolve = delayedClipboard();
    render(<RawTerminalView {...props} />);
    pasteChord();
    await act(() => feed('a replacement process is ready'));
    await act(async () => { resolve('stale command'); });
    expect(props.onPasteText).not.toHaveBeenCalled();
  });

  it('does not deliver delayed clipboard input after the pane unmounts', async () => {
    const resolve = delayedClipboard();
    const { unmount } = render(<RawTerminalView {...props} />);
    pasteChord();
    unmount();
    await act(async () => { resolve('stale command'); });
    expect(props.onPasteText).not.toHaveBeenCalled();
  });
  it('shows daemon refusal even when the outer tmux mode is enabled', async () => {
    props.onPasteText.mockRejectedValueOnce(new Error('Multiline paste blocked: child mode disabled'));
    render(<RawTerminalView {...props} />);
    await act(() => feed('\x1b[?2004h'));
    paste();
    expect((await screen.findByRole('status')).textContent).toMatch(/child mode disabled/);
  });
  it('still reports a sent request’s refusal if the user types while it is in flight', async () => {
    let reject!: (error: Error) => void;
    props.onPasteText.mockReturnValueOnce(new Promise<void>((_resolve, fail) => { reject = fail; }));
    render(<RawTerminalView {...props} />);
    await act(() => feed('\x1b[?2004h'));
    paste();
    fireEvent.keyDown(screen.getByTestId('raw-terminal'), { key: 'Shift', shiftKey: true });
    await act(async () => { reject(new Error('Multiline paste blocked: child mode disabled')); });
    expect(screen.getByRole('status').textContent).toMatch(/child mode disabled/);
  });
});
