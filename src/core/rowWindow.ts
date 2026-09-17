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

  const start = Math.max(0, Math.min(total, firstVisible - overscan));
  const end = Math.max(start, Math.min(total, firstVisible + viewportRows + overscan));
  return {
    start,
    end,
    padTopPx: start * rowHeight,
    padBottomPx: (total - end) * rowHeight,
  };
}
