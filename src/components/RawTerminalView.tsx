import React, { useEffect, useRef, useState } from 'react';
import { AnsiLine, ScreenCursor } from '../types/terminal';
import { audioEngine } from '../core/audioEngine';
import { spanStyle } from '../core/spanStyle';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { markingAgent, stepTurn, turnStarts, turnText } from '../core/turnMarks';
import { noteTotal, detach, reattach, runSearch, stepHit, stateOf } from '../core/scrollback';
import {
  TAIL, anchorAt, indexOfAnchor, easeScroll, type ViewportAnchor,
} from '../core/viewportAnchor';
import { rowWindow } from '../core/rowWindow';
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

/**
 * The anchor each session was last left on.
 *
 * Panes unmount on a workspace switch, and a reader who had scrolled back
 * should find their place again. This replaces a map of raw scrollTop pixels,
 * which could not survive the buffer trimming underneath it.
 */
const sessionAnchors = new Map<string, ViewportAnchor>();

export function resetSessionAnchors(): void {
  sessionAnchors.clear();
}

/** Drop one session's remembered anchor when its session is gone for good. */
export function forgetSessionAnchor(sessionId: string): void {
  sessionAnchors.delete(sessionId);
}

/**
 * How long a scroll gesture counts as the reader's intent.
 *
 * Much smaller a job than it used to be. This no longer keeps the follow effect
 * out of its own way — anchoring on a line did that — it only answers "was this
 * scroll event the user's?". A resize or a reconstruction can clamp scrollTop
 * and emit a scroll event that nobody asked for, and treating that as a
 * decision to stop following would strand the reader mid-buffer.
 */
const SCROLL_INTENT_MS = 400;

/**
 * Rows kept in the DOM beyond the viewport, each side.
 *
 * Enough that a fast scroll does not outrun the render, small enough that a
 * full buffer is not in the document. The whole 5000-line buffer used to be.
 */
const OVERSCAN_ROWS = 20;

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
  /**
   * Where the reader is, as a LINE.
   *
   * A ref rather than state: the layout effect below must see the current value
   * without re-running on every scroll event.
   */
  const anchorRef = useRef<ViewportAnchor>(
    (sessionId && sessionAnchors.get(sessionId)) || TAIL,
  );
  const scrollIntentAtRef = useRef(Number.NEGATIVE_INFINITY);
  /** Target of an in-flight eased scroll, and its frame handle. */
  const scrollTarget = useRef<number | null>(null);
  const scrollFrame = useRef(0);
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
  /** Index of the row at the top of the viewport, and the measured line box. */
  const [firstVisible, setFirstVisible] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);
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

  // Only what the reader can see, plus overscan. See `rowWindow`.
  const viewportRows = rowHeight > 0
    ? Math.ceil((scrollRef.current?.clientHeight ?? 0) / rowHeight)
    : 0;
  const win = rowWindow({
    firstVisible,
    viewportRows,
    overscan: OVERSCAN_ROWS,
    total: lines.length,
    rowHeight,
  });

  /**
   * A pane can swap which session it shows WITHOUT remounting.
   *
   * Split layouts replace the leaf that is losing focus rather than adding one
   * (`paneTree.ts`), and `SplitPaneGrid` keys that leaf by `tree.id` — the pane
   * slot — not by `node.id`. React therefore reuses this instance with a new
   * `sessionId`, and a ref initialised at mount would go on describing the
   * session that left: `L500` plausibly exists in both buffers, so the reader
   * would land somewhere real-looking and wrong.
   */
  const shownSession = useRef(sessionId);
  if (shownSession.current !== sessionId) {
    shownSession.current = sessionId;
    anchorRef.current = (sessionId && sessionAnchors.get(sessionId)) || TAIL;
    scrollTarget.current = null;
  }
  useEffect(() => {
    setFirstVisible(0);
    setRowHeight(0);
  }, [sessionId]);

  /** Is a scroll gesture still in flight? See SCROLL_INTENT_MS. */
  const gesturing = () => performance.now() - scrollIntentAtRef.current < SCROLL_INTENT_MS;
  const noteGesture = () => { scrollIntentAtRef.current = performance.now(); };

  /** Remember where this session was left, so a remount finds it again. */
  const setAnchor = (next: ViewportAnchor) => {
    anchorRef.current = next;
    if (!sessionId) return;
    if (next.mode === 'tail') sessionAnchors.delete(sessionId);
    else sessionAnchors.set(sessionId, next);
  };

  /** The row currently at the top of the viewport, and its offset into it. */
  const topRow = (el: HTMLElement): { index: number; offsetPx: number } | null => {
    const rows = el.querySelectorAll<HTMLElement>('[data-terminal-line]');
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].offsetTop + rows[i].offsetHeight > el.scrollTop) {
        return { index: Number(rows[i].dataset.terminalLine), offsetPx: rows[i].offsetTop - el.scrollTop };
      }
    }
    return null;
  };

  /**
   * Leave the tail NOW, rather than when the scroll event eventually lands.
   *
   * Anchoring on a line did not make this unnecessary, and believing it did was
   * a mistake worth recording. In tail mode the layout effect still pins
   * scrollTop to scrollHeight on every `lines` change, so output arriving in
   * the gap between the wheel and its asynchronous scroll event runs the follow
   * effect while the view still believes it is following — and the reader is
   * yanked back to the bottom. The wheel is the one gesture that states its
   * direction up front, so up acts immediately.
   */
  const leaveTail = () => {
    const el = scrollRef.current;
    if (!el || !sessionId || anchorRef.current.mode === 'row') return;
    const top = topRow(el);
    const line = top ? lines[top.index] : undefined;
    if (!line) return;
    setAnchor(anchorAt(line.id, top!.offsetPx));
    setFirstVisible(top!.index);
    detach(sessionId, top!.index);
  };

  /**
   * Follow the tail, or hold the anchored line, as output arrives.
   *
   * useLayoutEffect, not useEffect: after paint the browser has already shown
   * the new lines at the old offset, which is a visible flash of stale
   * scrollback.
   *
   * The trim compensation that used to live here is gone, and it is worth
   * recording why rather than leaving a gap. It never ran. `getLines()` always
   * calls `linesFrom(buffer, 0, ...)`, so `lines[0].row` was always 0 and the
   * trimmed delta was always `0 - 0`; its unit test passed only by hand-feeding
   * a first row `getLines()` cannot produce. A reader was therefore never
   * compensated at all, and once the buffer filled the text crawled away under
   * them — the exact failure those sixty lines were written to prevent.
   *
   * Anchoring on a line needs no compensation, because a line does not move.
   */
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (sessionId) noteTotal(sessionId, lines.length);

    // One real measurement is enough; the line box is fixed at 17px by the
    // grid's own class and only a font load can change it.
    if (!rowHeight) {
      const measured = el.querySelector<HTMLElement>('[data-terminal-line]')?.offsetHeight ?? 0;
      if (measured > 0) setRowHeight(measured);
    }

    const anchor = anchorRef.current;
    if (anchor.mode === 'tail') {
      // The window has to follow the tail too, or the rows the reader is
      // about to see are not in the DOM to scroll to.
      if (lines.length && win.end < lines.length) setFirstVisible(lines.length - 1);
      el.scrollTop = el.scrollHeight;
      return;
    }
    const index = indexOfAnchor(anchor, lines);
    if (index === null) {
      // The anchored line was trimmed out from under the reader. Returning to
      // the tail is the honest answer: the text they were reading is gone, and
      // landing them somewhere else would be a guess dressed up as a position.
      setAnchor(TAIL);
      if (sessionId) reattach(sessionId);
      el.scrollTop = el.scrollHeight;
      return;
    }
    const row = el.querySelector<HTMLElement>(`[data-terminal-line="${index}"]`);
    if (row) el.scrollTop = Math.max(0, row.offsetTop - anchor.offsetPx);
  }, [lines, sessionId, rowHeight, win.end]);

  /**
   * Adopt whatever line is at the top of the viewport as the anchor.
   *
   * Leaving the tail is also what puts the plate into transport mode.
   */
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !sessionId) return;
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 24;
    if (atBottom) {
      setAnchor(TAIL);
      setFirstVisible(Math.max(0, lines.length - 1));
      reattach(sessionId);
      return;
    }
    // A scroll nobody asked for is not a decision to stop following. Resize and
    // reconstruction both clamp scrollTop and emit one, and honouring those
    // stranded the reader mid-buffer with nothing on screen to explain it.
    if (anchorRef.current.mode === 'tail' && !gesturing()) {
      el.scrollTop = el.scrollHeight;
      reattach(sessionId);
      return;
    }
    scrollIntentAtRef.current = Number.NEGATIVE_INFINITY;
    const top = topRow(el);
    if (!top) {
      // The reader jumped outside the rendered window — a scrollbar drag or a
      // click on the track. There is no row here to anchor to, and returning
      // would leave them looking at a spacer div: a blank pane that nothing
      // recovers until more output arrives. Estimate the row and let the next
      // frame anchor properly.
      if (rowHeight > 0) setFirstVisible(Math.min(lines.length - 1, Math.floor(el.scrollTop / rowHeight)));
      return;
    }
    const line = lines[top.index];
    if (!line) return;
    setFirstVisible(top.index);
    setAnchor(anchorAt(line.id, top.offsetPx));
    detach(sessionId, top.index);
  };

  /** One frame of eased scrolling toward whatever the wheel asked for. */
  const lastFrameAt = useRef(0);
  /**
   * Stable identity, latest body. rAF holds the callback across frames while the
   * body must see the current `lines`; a useCallback with real dependencies
   * would hand a new function to a loop already scheduled with the old one.
   */
  const stepImpl = useRef<() => void>(() => {});
  stepImpl.current = () => {
    const el = scrollRef.current;
    const target = scrollTarget.current;
    if (!el || target === null) { scrollFrame.current = 0; return; }
    const reduced = typeof window !== 'undefined'
      && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Measured, not assumed: easeScroll is frame-rate independent by design,
    // and a hardcoded 16 makes a dropped frame a slower scroll rather than a
    // longer step — the exact thing its contract promises not to do.
    const now = performance.now();
    const dt = lastFrameAt.current ? Math.min(64, now - lastFrameAt.current) : 16;
    lastFrameAt.current = now;
    const next = easeScroll(el.scrollTop, target, dt, reduced);
    el.scrollTop = next;
    // Move the anchor WITH the animation.
    //
    // Otherwise the anchor stays where the gesture began until the browser
    // delivers a scroll event, and any output arriving in that gap makes the
    // layout effect re-pin to the old position while this loop eases away from
    // it — a rubber-band exactly when the reader is scrolling back through a
    // live stream. Kept level, the layout effect's write is a no-op.
    const at = topRow(el);
    const line = at ? lines[at.index] : undefined;
    if (at && line) setAnchor(anchorAt(line.id, at.offsetPx));
    if (next === target) { scrollTarget.current = null; scrollFrame.current = 0; lastFrameAt.current = 0; return; }
    scrollFrame.current = requestAnimationFrame(stepScroll);
  };
  const stepScroll = React.useCallback(() => stepImpl.current(), []);

  useEffect(() => () => {
    if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = 0;
  }, []);

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
      const line = lines[target];
      // A quarter down, expressed as the ANCHOR's offset rather than a scrollTop
      // write. setFirstVisible is async, so for a mark outside the window the
      // querySelector below finds nothing and the placement silently never
      // applied — a jump landed flush at the top or a quarter down depending
      // only on how far it was.
      const quarter = (scrollRef.current?.clientHeight ?? 0) / 4;
      if (line) setAnchor(anchorAt(line.id, -quarter));
      setFirstVisible(target);
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
    const hit = lines[st.line];
    if (!hit) return;
    const row = el.querySelector<HTMLElement>(`[data-terminal-line="${st.line}"]`);
    if (!row) {
      // Only the viewport plus overscan is rendered, so a hit further away has
      // no element to scroll to. Without this the search silently did nothing:
      // "a hit you cannot see was found for nobody" described the bug rather
      // than preventing it.
      setAnchor(anchorAt(hit.id, -(el.clientHeight / 2)));
      setFirstVisible(st.line);
      return;
    }
    if (row) {
      setAnchor(anchorAt(hit.id, 0));
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
    if (e.key === 'End' && anchorRef.current.mode === 'row' && sessionId) {
      e.preventDefault();
      setAnchor(TAIL);
      setFirstVisible(Math.max(0, lines.length - 1));
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
    // A region is computed on the lines ARRAY and may span rows the window does
    // not currently hold. Bring them in and let the next click land, rather
    // than silently selecting nothing.
    if (region.start < win.start || region.end >= win.end) {
      setFirstVisible(Math.max(0, region.start));
      return;
    }
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
        /*
           The wheel drives an eased target rather than the browser's own jump.
           There is no gesture window any more and no wheel pre-empt: both
           existed only to beat the follow effect to the viewport, and a tail
           anchor no longer moves a reader who has left it.
        */
        onWheel={(event) => {
          const el = scrollRef.current;
          if (!el) return;
          noteGesture();
          if (event.deltaY < 0) leaveTail();
          event.preventDefault();
          const from = scrollTarget.current ?? el.scrollTop;
          const limit = Math.max(0, el.scrollHeight - el.clientHeight);
          scrollTarget.current = Math.max(0, Math.min(limit, from + event.deltaY));
          if (!scrollFrame.current) scrollFrame.current = requestAnimationFrame(stepScroll);
        }}
        // The PTY uses whole-pixel rows. A fractional 17.875px line box
        // accumulated 37px of overflow and scrolled an editor's first row away.
        onTouchStart={noteGesture}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) noteGesture();
        }}
        className="flex-1 p-3 overflow-y-auto font-mono text-[13px] leading-[17px] select-text"
        style={{
          // Columns are whole pixels for the same reason rows are. Without
          // this the glyphs advance by the font's fractional 7.8px while the
          // caret is placed on the 7px grid, and the two drift apart by a
          // whole cell every nine columns. useTerminalSize sets the value from
          // the advance it measured; see `tracking` in core/cellMetrics.
          letterSpacing: 'var(--terminal-tracking, 0px)',
          // A gesture at the tail must not bounce the window behind it.
          overscrollBehavior: 'contain',
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
        <div aria-hidden="true" style={{ height: `${win.padTopPx}px` }} />
        {lines.slice(win.start, win.end).map((line, offset) => {
          const i = win.start + offset;
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
        <div aria-hidden="true" style={{ height: `${win.padBottomPx}px` }} />
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
