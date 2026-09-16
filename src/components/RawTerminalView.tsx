import React, { useEffect, useRef, useState } from 'react';
import { AnsiLine, ScreenCursor } from '../types/terminal';
import { audioEngine } from '../core/audioEngine';
import { spanStyle } from '../core/spanStyle';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { markingAgent, stepTurn, turnStarts, turnText } from '../core/turnMarks';
import { noteTotal, detach, reattach, runSearch, stepHit, stateOf } from '../core/scrollback';
import {
  BINDINGS,
  VIEW_BINDINGS,
  isAppChord,
  matchViewAction,
  type ViewAction,
  type ViewActionRequest,
} from '../core/keymap';
import { prepareClipboardText, commandRegion } from '../core/terminalSelection';
import { getEmulator } from '../core/emulatorRegistry';
import { findQuickTargets, labelTargets } from '../core/quickSelect';
import { isModalKeyboardOwned } from '../core/modalKeyboard';
import { QuickSelectOverlay } from './QuickSelectOverlay';
import type { MutationIdentity } from '../core/sessionAttachment';
import type { RecoveredHistoryPresentation } from '../types/sessionTree';
import { RecoveredHistory } from './RecoveredHistory';

interface RawTerminalViewProps {
  lines: AnsiLine[];
  onWrite: (data: string) => void;
  onPasteText: (text: string, expected?: Readonly<MutationIdentity> | null) => Promise<void>;
  captureInputIdentity?: () => Readonly<MutationIdentity> | null;
  onSendSignal: (sig: 'ctrl+c' | 'ctrl+d' | 'ctrl+z') => void;
  /** Only the focused pane grabs the keyboard; the others must not steal it. */
  isActive?: boolean;
  /** The session whose grid this pane sizes. Null for a view with no PTY. */
  sessionId?: string | null;
  /**
   * The agent key, for turn marks only — NOT a display name. The plate draws
   * who holds the keyboard; this decides where the gutter puts a mark.
   */
  agentKey?: string | null;
  /** Where the caret is, indexing `lines`. Absent before the first frame. */
  cursor?: ScreenCursor | null;
  /** A palette command addressed to this pane, delivered at most once. */
  viewActionRequest?: ViewActionRequest | null;
  /** Clear a request after this pane accepts it, before a later remount. */
  onViewActionHandled?: (requestId: number) => void;
  recoveredHistory?: RecoveredHistoryPresentation;
  recoveryCacheLines?: readonly AnsiLine[];
  recoveryCacheTruncated?: boolean;
}

/** Gutter width. Reserved from the grid so the shell never wraps early. */
export const GUTTER_PX = 16;

/** Set by the first keystroke, ever. The keymap is a first-run thing. */
export const KEYMAP_SEEN_KEY = 'DOOM_TERM_KEYMAP_SEEN_V1';

const sessionScrollPositions = new Map<string, number>();

/**
 * How long a scroll gesture keeps the follow-write out of its own way.
 *
 * A `scroll` event is dispatched asynchronously, but a running agent re-renders
 * this view every frame, so the follow effect routinely landed in the gap
 * between the gesture and the event it produces. Touch and scrollbar drags
 * cannot say which way they are going the way a wheel can, so they get a window
 * instead — bounded, because a gesture that never moves anything must not stop
 * the terminal following its own output forever.
 */
const SCROLL_INTENT_MS = 400;

export function resetSessionScrollPositions(): void {
  sessionScrollPositions.clear();
}

interface TerminalLineRowProps {
  line: AnsiLine;
  index: number;
  isMarked: boolean;
  isCursorHere: boolean;
  cursorCol?: number;
  /** The character the caret sits on, repainted in the ground colour on it. */
  cursorGlyph?: string;
  /** Cells the caret covers: 2 over a double-width character, otherwise 1. */
  cursorCells?: number;
  hasFocus?: boolean;
}

const TerminalLineRow = React.memo(function TerminalLineRow({
  line,
  index,
  isMarked,
  isCursorHere,
  cursorCol = 0,
  cursorGlyph = '',
  cursorCells = 1,
  hasFocus = false,
}: TerminalLineRowProps) {
  return (
    <div
      data-terminal-line={index}
      className="grid"
      style={{ gridTemplateColumns: `${GUTTER_PX}px 1fr` }}
    >
      <i
        aria-hidden="true"
        className="block w-1 h-[13px] mt-[3px]"
        style={{ background: isMarked && !line.isWrapped ? 'var(--st-live)' : 'transparent' }}
      />
      <span className="whitespace-pre relative block">
        {line.spans.map((span, spanIdx) => (
          <span key={spanIdx} style={spanStyle(span, line.isError)}>
            {span.text}
          </span>
        ))}
        {isCursorHere && (
          /*
              REVERSE VIDEO, not a blend.

              This used to be a bare amber block with `mix-blend-mode:
              difference`, on the theory that the difference of the block and
              the glyph reads as an inversion. It does not. Difference against
              a fixed amber is a function of whatever colour the program chose,
              and it lands wherever it lands: bone text `#e8dcbc` under the
              caret `#e0a92c` came out `#083390`, navy on amber, which is the
              "yellow rectangle over the character" this fixes. It also
              synthesises colours that are in none of the five canonical state
              colours and are contrast-guarded against nothing.

              A block caret has exactly one correct form: paint the cell in the
              live colour and repaint the character on it in the ground colour.
              The character comes from the emulator — the only place that has a
              width table — so the view never has to work out which character a
              column holds.

              Unfocused stays a hollow 1px ring and draws no glyph: the real
              text underneath is already the right colour.
          */
          <i
            aria-hidden="true"
            data-testid="terminal-cursor"
            data-cursor-glyph={hasFocus && cursorGlyph ? cursorGlyph : undefined}
            className="absolute top-0 pointer-events-none overflow-hidden"
            style={{
              // <i> defaults to italic, whose zero advance can differ from the
              // text face. Use the integer cell metric measured by useTerminalSize
              // instead of CSS `ch`, whose fallback-font metric can drift.
              fontStyle: 'normal',
              left: `calc(var(--terminal-cell-width, 1ch) * ${cursorCol})`,
              width: `calc(var(--terminal-cell-width, 1ch) * ${cursorCells})`,
              height: '100%',
              background: hasFocus ? 'var(--st-live)' : 'transparent',
              boxShadow: hasFocus ? 'none' : 'inset 0 0 0 1px var(--st-live)',
              color: 'var(--ground)',
              // The glyph is drawn on the same grid as the text it covers.
              letterSpacing: 'var(--terminal-tracking, 0px)',
            }}
          >
            {hasFocus ? cursorGlyph : ''}
          </i>
        )}
      </span>
    </div>
  );
});

/**
 * Map a keydown to the bytes a PTY expects.
 *
 * Split out of the component so every branch is testable without a DOM, and so
 * the list is readable as a table rather than twenty early returns.
 * Returns null when the key is not ours to send.
 */
export function keyToBytes(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string | null {
  const NAMED: Record<string, string> = {
    Enter: '\r',
    Backspace: '\x7f',
    Tab: '\t',
    Escape: '\x1b',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    Delete: '\x1b[3~',
    Insert: '\x1b[2~',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
  };

  // Ctrl+letter is the control character, which is how an agent CLI receives
  // Ctrl+A/E/K/U/W and every other readline binding. Without this the only
  // chords that reached the process were the three signals.
  if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
    const c = e.key.toLowerCase();
    if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
    if (c === ' ') return '\x00';
    if (c === '[') return '\x1b';
    if (c === '\\') return '\x1c';
    if (c === ']') return '\x1d';
  }

  // Shift+Enter is "newline, do not submit" — the key every agent composer
  // wants and the reason Claude Code otherwise makes you type a backslash
  // before Enter. ESC CR is not a guess: it is the sequence Claude Code's own
  // `/terminal-setup` writes into iTerm2, VS Code, Alacritty and Zed for this
  // key, so an agent that understands Shift+Enter at all understands this.
  // Alt+Enter is the same bytes because that is literally what Alt means here,
  // and Enter was the one named key whose ESC prefix was being dropped.
  if (e.key === 'Enter' && (e.shiftKey || e.altKey) && !e.ctrlKey && !e.metaKey) {
    return '\x1b\r';
  }

  if (NAMED[e.key] !== undefined) {
    // Shift+Tab is the back-tab an agent's field navigation listens for.
    if (e.key === 'Tab' && e.shiftKey) return '\x1b[Z';
    return NAMED[e.key];
  }

  // Alt+key is ESC-prefixed, the standard meta encoding.
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) return `\x1b${e.key}`;

  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) return e.key;

  return null;
}

/**
 * Pass-through mode: the process owns the keyboard, byte for byte.
 *
 * This view is what an inline agent (Antigravity, Claude Code, Codex) needs and
 * never used to get. Two things were wrong. It only ever mounted on alt-screen,
 * which those agents do not use; and even when it did mount it never took
 * focus, so the div sat there with a keydown handler that nothing could reach
 * and every keystroke fell through to the window shortcuts.
 */
export const RawTerminalView: React.FC<RawTerminalViewProps> = ({
  lines,
  onWrite,
  onPasteText,
  captureInputIdentity,
  onSendSignal,
  isActive = true,
  sessionId = null,
  agentKey = null,
  cursor = null,
  viewActionRequest = null,
  onViewActionHandled,
  recoveredHistory,
  recoveryCacheLines = [],
  recoveryCacheTruncated,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const detachedRef = useRef(sessionId ? stateOf(sessionId).detached : false);
  const scrollIntentAtRef = useRef(Number.NEGATIVE_INFINITY);
  /**
   * The absolute buffer row this pane's window started at last frame, and whose
   * session it belongs to. See the trim compensation in the follow effect; row
   * numbers from another session's buffer would describe nothing.
   */
  const firstRowRef = useRef<{ session: string | null; row: number | null }>({
    session: sessionId,
    row: null,
  });
  /**
   * Search entry is a keyboard MODE, not a text box.
   *
   * The plate is the only chrome, so the query has nowhere else to live — and
   * it is already drawn there, in the transport's FIND row. Putting an input
   * over the terminal would be the one piece of floating chrome this whole
   * direction exists to remove.
   */
  /**
   * Has this user ever typed into a terminal here?
   *
   * The keymap below was first gated on an empty session, which sounded right
   * and was useless in practice: the shell prints a prompt within milliseconds,
   * so the empty state never lasts long enough to read. First run is the moment
   * that actually matters, and one keystroke retires it forever.
   */
  const [keymapSeen, setKeymapSeen] = useState(
    () => typeof localStorage !== 'undefined' && !!localStorage.getItem(KEYMAP_SEEN_KEY),
  );
  const [searching, setSearching] = useState(false);
  const [quickSelecting, setQuickSelecting] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const clipboardEpoch = useRef(0);
  const pasteResultEpoch = useRef(0);
  const queryRef = useRef('');
  const lastHandledViewActionRef = useRef<number | null>(null);

  useEffect(() => () => {
    clipboardEpoch.current++;
    pasteResultEpoch.current++;
  }, [isActive, sessionId]);
  useEffect(() => {
    if (!clipboardNotice) return;
    const timer = window.setTimeout(() => setClipboardNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [clipboardNotice]);
  // Not `agentKey` directly: when the agent exits and the shell returns to the
  // foreground that goes null, and every mark on lines that have not changed
  // would disappear with it. See markingAgent.
  const activeMarkingAgent = markingAgent(sessionId, agentKey);
  const marks = React.useMemo(
    () => turnStarts(lines, activeMarkingAgent),
    [lines, activeMarkingAgent],
  );
  const quickTargets = React.useMemo(
    () => labelTargets(findQuickTargets(lines.slice(-200))),
    [lines],
  );

  // Take the keyboard as soon as this pane is the active one. A pass-through
  // terminal that is not focused is a terminal you cannot type into, and there
  // is nothing on screen to tell you why — which is exactly how it failed.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (isActive) {
      if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
      return;
    }
    // Give the keyboard back on deactivate. Now that every pane stays mounted, a
    // hidden one still holding focus would swallow every keystroke silently.
    if (el.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [isActive, quickSelecting]);

  /** Is a scroll gesture still in flight? See SCROLL_INTENT_MS. */
  const gesturing = () => performance.now() - scrollIntentAtRef.current < SCROLL_INTENT_MS;
  const noteGesture = () => {
    scrollIntentAtRef.current = performance.now();
  };

  /**
   * Leave follow mode NOW, rather than when the scroll event eventually lands.
   *
   * The wheel is the one gesture that states its direction up front, and up is
   * unambiguously "stop following". Doing it here rather than in the scroll
   * handler is the whole fix for scrolling back through a running agent: the
   * follow effect below can otherwise run first and put the reader straight
   * back at the bottom.
   */
  const leaveTail = () => {
    noteGesture();
    if (detachedRef.current || !sessionId) return;
    detachedRef.current = true;
    // The line is approximate — the wheel fires before the browser has moved
    // anything — and the scroll event corrects it a moment later. No offset is
    // remembered here for the same reason: it would still read as the tail, and
    // the follow effect would restore the reader to the bottom they just left.
    const el = scrollRef.current;
    const offset = el ? el.scrollTop / Math.max(1, el.scrollHeight) : 0;
    detach(sessionId, Math.round(offset * lines.length));
  };

  // Follow the tail as output arrives. useLayoutEffect, not useEffect: after
  // paint the browser has already shown the new lines at the old offset, which
  // is a visible jump / flash of stale scrollback.
  //
  // Deliberately NOT keyed on `isActive`. Panes stay mounted, so the browser
  // has kept the offset of the one you are switching to; re-running this on
  // activation threw that away and reached for the newest output, which is the
  // jump that made every switch look like a glitch.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (sessionId) noteTotal(sessionId, lines.length);

    // Scrollback trimming deletes rows from the TOP of the buffer, so every row
    // below slides up by exactly that many line boxes. A detached reader is
    // pinned to a pixel offset, so without this the text they are reading
    // crawls away for as long as the agent keeps writing. The absolute buffer
    // row rides on every line, so the count is measured, never guessed.
    const firstRow = lines.length ? lines[0].row : undefined;
    const previous = firstRowRef.current;
    const previousFirstRow = previous.session === sessionId ? previous.row : null;
    firstRowRef.current = { session: sessionId, row: firstRow ?? null };
    if (detachedRef.current && sessionId && firstRow !== undefined && previousFirstRow !== null) {
      const trimmed = firstRow - previousFirstRow;
      const rowHeight = el.querySelector<HTMLElement>('[data-terminal-line]')?.offsetHeight ?? 0;
      const saved = sessionScrollPositions.get(sessionId);
      if (trimmed > 0 && rowHeight > 0 && saved !== undefined) {
        sessionScrollPositions.set(sessionId, Math.max(0, saved - trimmed * rowHeight));
      }
    }

    if (!detachedRef.current) {
      // A gesture in flight owns the viewport until its scroll event arrives.
      if (!gesturing()) el.scrollTop = el.scrollHeight;
    } else if (sessionId && sessionScrollPositions.has(sessionId)) {
      el.scrollTop = sessionScrollPositions.get(sessionId)!;
    }
  }, [lines, sessionId]);

  /**
   * Leaving the tail is what puts the plate into transport mode. Read from a
   * ref rather than state so the layout effect above sees the current value
   * without re-running on every scroll event.
   */
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !sessionId) return;
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 24;
    // Resize/reconstruction can clamp scrollTop and emit a native scroll event
    // even though the reader never left follow mode. Treat detachment as user
    // intent, not as an incidental layout coordinate.
    if (!atBottom && !detachedRef.current && !gesturing()) {
      el.scrollTop = el.scrollHeight;
      reattach(sessionId);
      return;
    }
    scrollIntentAtRef.current = Number.NEGATIVE_INFINITY;
    detachedRef.current = !atBottom;
    if (atBottom) {
      reattach(sessionId);
      sessionScrollPositions.delete(sessionId);
    } else {
      detach(sessionId, Math.round((el.scrollTop / Math.max(1, el.scrollHeight)) * lines.length));
      sessionScrollPositions.set(sessionId, el.scrollTop);
    }
  };

  const copyText = React.useCallback(async (text: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(text);
    } catch {
      setClipboardNotice('Clipboard copy unavailable or denied.');
    }
  }, []);

  const pasteText = React.useCallback(async (text: string, expected?: Readonly<MutationIdentity> | null) => {
    if (!isActive || isModalKeyboardOwned() || searching || quickSelecting) return;
    const epoch = ++pasteResultEpoch.current;
    try {
      if (expected === null) throw new Error('Session not ready; paste was not sent.');
      const mode = sessionId ? getEmulator(sessionId).getPasteState().bracketed : false;
      const clean = prepareClipboardText(text, mode);
      if (clean === null) {
        setClipboardNotice('Multiline paste blocked: bracketed-paste mode is not currently observed.');
      } else if (clean) {
        setClipboardNotice(null);
        if (expected === undefined) await onPasteText(clean);
        else await onPasteText(clean, expected);
      }
    } catch (error) {
      if (epoch === pasteResultEpoch.current) {
        setClipboardNotice(error instanceof Error ? error.message : 'Paste failed; check the terminal before retrying.');
      }
    }
  }, [isActive, onPasteText, quickSelecting, searching, sessionId]);

  const readClipboard = React.useCallback(async () => {
    const epoch = ++clipboardEpoch.current;
    const emu = sessionId ? getEmulator(sessionId) : null;
    const revision = emu?.getPasteState().revision;
    const captured = captureInputIdentity?.();
    const permit = captured ? { ...captured } : captured;
    if (permit === null) {
      setClipboardNotice('Session not ready; clipboard was not read.');
      return;
    }
    try {
      if (!navigator.clipboard?.readText) throw new Error('unavailable');
      const text = await navigator.clipboard.readText();
      if (epoch !== clipboardEpoch.current) return;
      const current = captureInputIdentity?.();
      if (permit && (!current || permit.id !== current.id || permit.incarnation !== current.incarnation
          || permit.attachment_id !== current.attachment_id)) {
        setClipboardNotice('Terminal ownership changed while reading the clipboard. Paste canceled.');
        return;
      }
      if (emu && (getEmulator(sessionId!) !== emu || emu.getPasteState().revision !== revision)) {
        setClipboardNotice('Terminal changed while reading the clipboard. Paste canceled; try again.');
        return;
      }
      void pasteText(text, permit);
    } catch {
      if (epoch === clipboardEpoch.current) setClipboardNotice('Clipboard read unavailable or denied.');
    }
  }, [pasteText, sessionId, captureInputIdentity]);

  const runViewAction = React.useCallback((viewAction: ViewAction) => {
    if (viewAction === 'copySelection') {
      const selected = window.getSelection()?.toString();
      if (selected) void copyText(selected);
      return;
    }

    if (viewAction === 'pasteClipboard') {
      void readClipboard();
      return;
    }

    if (viewAction === 'quickSelect') {
      setQuickSelecting((open) => !open);
      return;
    }

    if (viewAction === 'searchScrollback') {
      if (!sessionId) return;
      setSearching(true);
      queryRef.current = '';
      runSearch(sessionId, '', lines);
      return;
    }

    if (viewAction === 'copyTurn') {
      const current = sessionId && stateOf(sessionId).detached
        ? stateOf(sessionId).line
        : Math.max(0, lines.length - 1);
      const text = turnText(lines, marks, current);
      if (text) void copyText(text);
      return;
    }

    if (!sessionId) return;
    const current = stateOf(sessionId).detached
      ? stateOf(sessionId).line
      : Math.max(0, lines.length - 1);
    const target = stepTurn(marks, current, viewAction === 'previousTurn' ? -1 : 1);
    if (target !== null && scrollRef.current) {
      detachedRef.current = true;
      detach(sessionId, target);
      const row = scrollRef.current.querySelector<HTMLElement>(`[data-terminal-line="${target}"]`);
      if (row) {
        scrollRef.current.scrollTop = Math.max(0, row.offsetTop - scrollRef.current.clientHeight / 4);
      }
    }
  }, [copyText, lines, marks, readClipboard, sessionId]);

  useEffect(() => {
    if (!isActive || !viewActionRequest) return;
    if (viewActionRequest.sessionId !== sessionId) return;
    if (lastHandledViewActionRef.current === viewActionRequest.id) return;
    lastHandledViewActionRef.current = viewActionRequest.id;
    onViewActionHandled?.(viewActionRequest.id);
    runViewAction(viewActionRequest.action);
  }, [isActive, onViewActionHandled, runViewAction, sessionId, viewActionRequest?.action, viewActionRequest?.id, viewActionRequest?.sessionId]);

  // Follow the search cursor. A hit you cannot see was found for nobody.
  React.useLayoutEffect(() => {
    if (!searching || !sessionId || !scrollRef.current) return;
    const st = stateOf(sessionId);
    if (!st.hits) return;
    const el = scrollRef.current;
    const row = el.querySelector<HTMLElement>(`[data-terminal-line="${st.line}"]`);
    if (row) {
      detachedRef.current = true;
      el.scrollTop = Math.max(0, row.offsetTop - el.clientHeight / 2);
    }
  });

  // Size from the grid container rather than the outer box. They are nearly the
  // same now the header is gone, but the grid is the surface the shell actually
  // draws into and the padding is not the shell's to use.
  useTerminalSize(scrollRef, sessionId, GUTTER_PX);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    clipboardEpoch.current++;
    // A transient surface is up and the key belongs to it, not to the process.
    // The capture-phase listener in core/modalKeyboard.ts should already have
    // stopped this event before React dispatched it; this is the same contract
    // stated where it is easy to test, and the difference between a missed
    // keystroke and Enter reaching a live shell through a destructive prompt.
    if (isModalKeyboardOwned()) return;

    if (!keymapSeen) {
      try { localStorage.setItem(KEYMAP_SEEN_KEY, '1'); } catch { /* private mode */ }
      setKeymapSeen(true);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    const viewAction = matchViewAction(e);
    if (viewAction) {
      e.preventDefault();
      e.stopPropagation();
      runViewAction(viewAction);
      return;
    }

    // Quick-select owns the following key at window level. Let it bubble, but
    // never also encode the label into the shell running underneath it.
    if (quickSelecting) return;

    // App chords stay with the app; everything else is the process's, byte for
    // byte. The list lives in one place — see `core/keymap.ts` — because this
    // view and the window handler holding their own copies is what silently
    // broke Ctrl+K, Ctrl+P and Ctrl+1..9 while the on-screen keymap went on
    // advertising them.
    //
    // Returning here rather than stopping is the entire mechanism: React
    // dispatches from the root container, so `stopPropagation` at this level
    // stops the event before `window` — and therefore `useGlobalKeys` — can
    // ever see it. The terminal takes focus whenever its pane is active, so in
    // practice nothing else was ever focused to receive them.
    if (isAppChord(e)) return;

    e.stopPropagation();

    if (searching && sessionId) {
      e.preventDefault();
      if (e.key === 'Escape') {
        setSearching(false);
        queryRef.current = '';
        runSearch(sessionId, '', lines);
        return;
      }
      if (e.key === 'Enter') {
        stepHit(sessionId, e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'Backspace') {
        queryRef.current = queryRef.current.slice(0, -1);
        runSearch(sessionId, queryRef.current, lines);
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        queryRef.current += e.key;
        runSearch(sessionId, queryRef.current, lines);
        return;
      }
      return;   // swallow everything else so a stray key cannot reach the PTY
    }

    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      const c = e.key.toLowerCase();
      if (c === 'c') {
        e.preventDefault();
        audioEngine.playSound('oof', 1);
        onSendSignal('ctrl+c');
        return;
      }
      if (c === 'd') {
        e.preventDefault();
        onSendSignal('ctrl+d');
        return;
      }
      if (c === 'z') {
        e.preventDefault();
        onSendSignal('ctrl+z');
        return;
      }
    }

    // End returns you to the tail. The old design put this on a pulsing plate
    // button floating in the middle of the pane; it is a key and a readout now.
    if (e.key === 'End' && detachedRef.current && sessionId) {
      e.preventDefault();
      detachedRef.current = false;
      reattach(sessionId);
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      return;
    }

    const bytes = keyToBytes(e);
    if (bytes !== null) {
      e.preventDefault();
      onWrite(bytes);
    }
  };

  // The daemon, not the outer emulator, admits and frames clipboard requests.
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    clipboardEpoch.current++;
    void pasteText(text, captureInputIdentity?.());
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    containerRef.current?.focus({ preventScroll: true });
    if (e.detail !== 3 || (!e.ctrlKey && !e.metaKey)) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-terminal-line]');
    const index = Number(row?.dataset.terminalLine);
    if (!row || !Number.isInteger(index)) return;

    const region = commandRegion(lines, index, marks);
    const start = scrollRef.current?.querySelector<HTMLElement>(`[data-terminal-line="${region.start}"]`);
    const end = scrollRef.current?.querySelector<HTMLElement>(`[data-terminal-line="${region.end}"]`);
    const selection = window.getSelection();
    if (!start || !end || !selection) return;
    e.preventDefault();
    const range = document.createRange();
    range.setStartBefore(start);
    range.setEndAfter(end);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onFocus={() => setHasFocus(true)}
      onBlur={(event) => {
        setHasFocus(false);
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clipboardEpoch.current++;
      }}
      // Clicking anywhere in the terminal gives it the keyboard back, the way
      // every other terminal behaves.
      onMouseDown={handleMouseDown}
      ref={containerRef}
      data-testid="raw-terminal"
      data-focused={hasFocus ? 'true' : 'false'}
      // One pixel of recess, and nothing else. "Edge to edge" meant no chrome,
      // not no boundary: the plate is raised, so the content it frames has to
      // be cut into it. The header that used to sit here narrated the line
      // discipline and duplicated the agent name the plate already draws.
      className="flex-1 flex flex-col recess overflow-hidden focus:outline-none relative"
    >
      {/* CONTINUOUS VT LINE GRID */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        // Up is unambiguous, so it detaches on the spot. Down only marks a
        // gesture: at the tail it means nothing, and away from it the scroll
        // event decides whether the reader has caught up.
        onWheel={(event) => { if (event.deltaY < 0) leaveTail(); else noteGesture(); }}
        onTouchStart={noteGesture}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) noteGesture();
        }}
        // The PTY uses whole-pixel rows. A fractional 17.875px line box
        // accumulated 37px of overflow and scrolled an editor's first row away.
        className="flex-1 p-3 overflow-y-auto font-mono text-[13px] leading-[17px] select-text"
        style={{
          // Columns are whole pixels for the same reason rows are. Without
          // this the glyphs advance by the font's fractional 7.8px while the
          // caret is placed on the 7px grid, and the two drift apart by a
          // whole cell every nine columns. useTerminalSize sets the value from
          // the advance it measured; see `tracking` in core/cellMetrics.
          letterSpacing: 'var(--terminal-tracking, 0px)',
          // Scroll anchoring is a heuristic for documents whose content shifts
          // unpredictably. A terminal knows exactly how many rows scrollback
          // just trimmed and the follow effect compensates for them itself;
          // leaving the browser to guess as well put two corrections on the
          // same pixels while an agent streamed.
          overflowAnchor: 'none',
        }}
      >
        {recoveredHistory && <RecoveredHistory cache={recoveryCacheLines}
          cacheTruncated={recoveryCacheTruncated} history={recoveredHistory} />}
        {lines.map((line, i) => {
          const isCursorHere = isActive && cursor && cursor.visible !== false
            ? (line.row !== undefined ? cursor.row === line.row : cursor.row === i)
            : false;
          return (
            <TerminalLineRow
              key={line.id}
              line={line}
              index={i}
              isMarked={marks.has(i)}
              isCursorHere={isCursorHere}
              cursorCol={isCursorHere ? cursor?.col : undefined}
              cursorGlyph={isCursorHere ? cursor?.glyph : undefined}
              cursorCells={isCursorHere ? cursor?.cells : undefined}
              hasFocus={isCursorHere ? hasFocus : false}
            />
          );
        })}
      </div>

      {/*
          The only place the keys are written down.

          Pinned to the pane rather than laid out at the top of the scrollback,
          which is where it used to be and where it was never once read: the
          view follows the tail, so any session with more than a screenful of
          history scrolled the keymap out of sight in the same frame it
          rendered. First run is still what retires it, and one keystroke does
          that forever — but while it is up it is up where it can be seen.

          The rows come from the keymap table itself, so a chord that stops
          working stops being advertised.
      */}
      {!keymapSeen && (
        <div
          data-testid="keymap"
          className="absolute left-0 right-0 top-0 p-3 select-none text-[13px] leading-snug"
          // Opaque, not a fade: a gradient let the scrollback show through the
          // last rows and the two texts interleaved into an unreadable mess.
          // The rule underneath is the same one the plate uses to cut content
          // into chrome, so it reads as a layer rather than as garbled output.
          style={{
            color: 'var(--ink-dim)',
            background: 'var(--ground)',
            boxShadow: 'inset 0 -1px 0 #2a2723',
          }}
        >
          {[...BINDINGS.map((b) => [b.label, b.description]), ...VIEW_BINDINGS.map((b) => [b.label, b.description])].map(
            ([k, what]) => (
              <div key={k} className="grid items-baseline gap-x-4" style={{ gridTemplateColumns: '20ch 1fr' }}>
                <span className="whitespace-nowrap" style={{ color: 'var(--st-live)' }}>{k}</span>
                <span>{what}</span>
              </div>
            ),
          )}
          <div className="pt-1" style={{ color: 'var(--ink-dim)', opacity: 0.7 }}>
            any key to dismiss
          </div>
        </div>
      )}
      {quickSelecting && (
        <QuickSelectOverlay
          targets={quickTargets}
          onClose={() => setQuickSelecting(false)}
          onSelect={(target, insert) => {
            if (insert) onWrite(target.value);
            else void copyText(target.value);
            setQuickSelecting(false);
          }}
        />
      )}
      {clipboardNotice && (
        <div role="status" className="absolute bottom-3 left-3 right-3 z-20 plate p-2 text-[12px]" style={{ color: 'var(--ink-plate)' }}>
          {clipboardNotice}
        </div>
      )}
    </div>
  );
};
