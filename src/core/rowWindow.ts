export interface RowWindowInput {
  /** Index of the first row inside the viewport. */
  firstVisible: number;
  viewportRows: number;
  overscan: number;
  total: number;
  /** Measured line-box height. 0 means "not laid out yet". */
  rowHeight: number;
}

export interface RowWindow {
  /** Inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
  padTopPx: number;
  padBottomPx: number;
}

/**
 * Which rows belong in the DOM.
 *
 * The whole buffer used to be rendered — up to five thousand elements
 * reconciled on every frame of a streaming agent, and on every keystroke,
 * before an echo could paint. Two spacer divs stand in for what is not
 * rendered, so the scroll height is unchanged and every pixel offset the
 * anchor resolves against still means what it meant.
 */
export function rowWindow(
  { firstVisible, viewportRows, overscan, total, rowHeight }: RowWindowInput,
): RowWindow {
  if (total <= 0) return { start: 0, end: 0, padTopPx: 0, padBottomPx: 0 };
  // An unmeasured row height cannot place anything. Render the lot rather than
  // stack the buffer at offset zero and call it a window.
  if (rowHeight <= 0) return { start: 0, end: total, padTopPx: 0, padBottomPx: 0 };

  let start = Math.max(0, Math.min(total, firstVisible - overscan));
  let end = Math.max(start, Math.min(total, firstVisible + viewportRows + overscan));

  // The window must COVER THE VIEWPORT, whatever firstVisible says.
  //
  // firstVisible is React state and can lag the rows it is meant to describe —
  // a pane that was hidden when it was last set, a buffer that changed size
  // under it, a screen swap. When it does, a window anchored on it can be
  // narrower than the viewport, and the shortfall renders as blank spacer:
  // the reader sees empty space where output is, and no scroll recovers it
  // because the rows were never in the document.
  const need = Math.min(total, viewportRows + overscan * 2);
  if (end - start < need) {
    if (end >= total) start = Math.max(0, total - need);
    else end = Math.min(total, start + need);
  }

  return {
    start,
    end,
    padTopPx: start * rowHeight,
    padBottomPx: (total - end) * rowHeight,
  };
}
