import type { TerminalScreen } from './terminalScreen';
import { XtermScreen } from './xtermScreen';
import { parseGrid } from './terminalGeometry';

/**
 * One long-lived screen per PTY session.
 *
 * These are mutable and non-serialisable, so they deliberately live outside
 * React state — the workspace is persisted to storage, and a screen buffer has
 * no business in there. Keying by session id is what keeps a chunk of output
 * from one tab out of another's grid.
 */
const emulators = new Map<string, TerminalScreen>();

/**
 * The grid a session starts on, for the frame between mount and the pane
 * reporting its real size. `resizeEmulator` corrects it immediately; nothing
 * should ever render at these numbers.
 *
 * Exported because the PTY must be spawned at the same numbers the emulator
 * assumes — the two disagreeing is a shell wrapping at one width against a grid
 * of another.
 */
export const BOOTSTRAP_COLS = 120;
export const BOOTSTRAP_ROWS = 30;

const parsedListeners = new Set<(sessionId: string) => void>();

/**
 * Fires when any session has parsed a batch, already coalesced per frame by the
 * screen. One subscription for the whole app, matching how PTY events arrive:
 * handlers reach the right session through the id, not through a closure.
 */
export function onScreenParsed(cb: (sessionId: string) => void): () => void {
  parsedListeners.add(cb);
  return () => parsedListeners.delete(cb);
}

export function getEmulator(sessionId: string): TerminalScreen {
  let emu = emulators.get(sessionId);
  if (!emu) {
    emu = replaceEmulator(sessionId, BOOTSTRAP_COLS, BOOTSTRAP_ROWS);
  }
  return emu;
}

/** Explicit cold reconstruction only. Warm attachment retains getEmulator(). */
export function replaceEmulator(sessionId: string, cols: number, rows: number): TerminalScreen {
  parseGrid(cols, rows);
  const emu = new XtermScreen(cols, rows);
  emu.onParsed(() => {
    if (emulators.get(sessionId) !== emu) return;
    for (const cb of [...parsedListeners]) cb(sessionId);
  });
  emulators.get(sessionId)?.dispose();
  emulators.set(sessionId, emu);
  return emu;
}

export function disposeEmulator(sessionId: string): void {
  // A screen holds a scheduled frame and its own listeners; dropping the map
  // entry alone would leak both.
  emulators.get(sessionId)?.dispose();
  emulators.delete(sessionId);
}

/** Reset a session's emulator buffer (e.g. before processing replayed events). */
export function resetEmulator(sessionId: string): void {
  emulators.get(sessionId)?.reset();
}

/**
 * Resize one session's grid.
 *
 * Per session, not global: two panes in a split are different sizes, and the
 * previous global form resized every emulator to whichever pane reported last.
 */
export function resizeEmulator(sessionId: string, cols: number, rows: number): void {
  getEmulator(sessionId).resize(cols, rows);
}

/** Test hook — drops every session's buffer. */
export function resetAllEmulators(): void {
  for (const emu of emulators.values()) emu.dispose();
  emulators.clear();
}
