import { useEffect, useRef } from 'react';
import { gridSize, measureCell, tracking, type GridSize } from '../core/cellMetrics';
import { ptyClient } from '../core/ptyClient';

/**
 * Keep one session's grid matched to the pane that shows it.
 *
 * Until 2026-08-29 nothing called this: sessions were spawned at a hardcoded
 * 120x30 and never resized, so SIGWINCH never fired and every agent CLI wrapped
 * its output and sized its frames for 120 columns whatever the window was
 * actually doing. `resizeEmulators` and `ptyClient.resize` both existed with
 * zero callers.
 *
 * Pass `sessionId: null` for a pane that owns no PTY, such as a scratchpad.
 *
 * `reservedPx` is horizontal space inside the measured element that the shell
 * does NOT get to draw in — currently the turn-mark gutter. Without it the
 * shell is told it has columns it cannot reach and wraps early, which looks
 * exactly like an emulator bug and is not one.
 */
const sessionGeometryCache = new Map<string, GridSize>();

export function resetSessionSizes(): void {
  sessionGeometryCache.clear();
}

export function forgetSessionSize(sessionId: string): void {
  sessionGeometryCache.delete(sessionId);
}

export function useTerminalSize(
  ref: React.RefObject<HTMLElement | null>,
  sessionId: string | null,
  reservedPx: number = 0,
): void {
  const last = useRef<GridSize | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !sessionId) return;

    last.current = sessionGeometryCache.get(sessionId) ?? null;
    let frame = 0;
    let scheduled = false;

    const apply = () => {
      scheduled = false;
      frame = 0;
      // A pane with no layout box is hidden, or has not been laid out yet.
      // gridSize would clamp 0x0 up to its 20x4 floor and hand this session a
      // 20-column terminal — which is what every backgrounded pane would get
      // the moment panes stopped being unmounted on a tab switch.
      if (el.clientWidth === 0 || el.clientHeight === 0) return;

      const cs = typeof window !== 'undefined' ? window.getComputedStyle(el) : null;
      const padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
      const padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;

      const usable = Math.max(0, el.clientWidth - padX - reservedPx);
      const usableHeight = Math.max(0, el.clientHeight - padY);
      const cell = measureCell(el);
      // The caret is positioned in the DOM using this exact integer metric.
      // CSS `ch` measures the first fallback font's zero glyph, which can differ
      // from the fallback that actually renders the terminal text.
      el.style.setProperty('--terminal-cell-width', `${cell.width}px`);
      // ...and the TEXT is pulled onto that same integer metric, because the
      // browser would otherwise advance every glyph by the font's fractional
      // advance and walk out from under the caret. See `tracking`.
      el.style.setProperty('--terminal-tracking', `${tracking(cell, cell.advance)}px`);
      const next = gridSize(usable, usableHeight, cell);
      // A no-op resize is not free: each one is a SIGWINCH, and a running agent
      // answers it by redrawing its whole frame. Only report real changes.
      if (last.current && last.current.cols === next.cols && last.current.rows === next.rows) {
        return;
      }
      last.current = next;
      sessionGeometryCache.set(sessionId, next);
      // Desired geometry is coalesced while offline/catching up. Only an
      // ordered Resize record may reflow the live parser.
      ptyClient.resizeSession(sessionId, next.cols, next.rows);
    };

    // A drag emits a resize per frame; coalesce so one gesture is one SIGWINCH.
    // Guard on a flag set BEFORE scheduling, not on the frame handle: a callback
    // that runs synchronously fires before the handle is assigned, leaving it
    // non-zero forever and swallowing every later resize.
    const observer = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      frame = requestAnimationFrame(apply);
    });
    observer.observe(el);
    apply();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      scheduled = false;
      observer.disconnect();
    };
  }, [ref, sessionId, reservedPx]);
}
