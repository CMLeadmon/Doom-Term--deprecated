import { describe, it, expect } from 'vitest';
import { rowWindow } from './rowWindow';

describe('rowWindow', () => {
  it('covers the viewport plus overscan on both sides', () => {
    const w = rowWindow({ firstVisible: 100, viewportRows: 30, overscan: 10, total: 500, rowHeight: 17 });
    expect(w.start).toBe(90);
    expect(w.end).toBe(140);
  });

  it('clamps at the top without negative padding', () => {
    const w = rowWindow({ firstVisible: 2, viewportRows: 30, overscan: 10, total: 500, rowHeight: 17 });
    expect(w.start).toBe(0);
    expect(w.padTopPx).toBe(0);
  });

  it('clamps at the end of the buffer', () => {
    const w = rowWindow({ firstVisible: 480, viewportRows: 30, overscan: 10, total: 500, rowHeight: 17 });
    expect(w.end).toBe(500);
    expect(w.padBottomPx).toBe(0);
  });

  it('padding plus rendered rows always equals the whole buffer height', () => {
    // This is what keeps scrollHeight — and therefore every offset the anchor
    // resolves against — identical to rendering the lot.
    for (const firstVisible of [0, 7, 100, 480, 499]) {
      const w = rowWindow({ firstVisible, viewportRows: 30, overscan: 10, total: 500, rowHeight: 17 });
      expect(w.padTopPx + (w.end - w.start) * 17 + w.padBottomPx).toBe(500 * 17);
    }
  });

  it('renders everything when the buffer is smaller than the viewport', () => {
    const w = rowWindow({ firstVisible: 0, viewportRows: 30, overscan: 10, total: 4, rowHeight: 17 });
    expect(w).toMatchObject({ start: 0, end: 4, padTopPx: 0, padBottomPx: 0 });
  });

  it('renders nothing for an empty buffer rather than dividing by zero', () => {
    const w = rowWindow({ firstVisible: 0, viewportRows: 30, overscan: 10, total: 0, rowHeight: 17 });
    expect(w).toMatchObject({ start: 0, end: 0, padTopPx: 0, padBottomPx: 0 });
  });

  it('renders everything when the row height is not yet measured', () => {
    // Before first layout offsetHeight is 0. Windowing on a zero height would
    // put every row at the same place; render the lot until a real measurement.
    const w = rowWindow({ firstVisible: 0, viewportRows: 30, overscan: 10, total: 500, rowHeight: 0 });
    expect(w).toMatchObject({ start: 0, end: 500, padTopPx: 0, padBottomPx: 0 });
  });

  it('never returns an end before its start', () => {
    const w = rowWindow({ firstVisible: 900, viewportRows: 30, overscan: 10, total: 100, rowHeight: 17 });
    expect(w.end).toBeGreaterThanOrEqual(w.start);
  });

  it('covers the whole viewport when the reader is at the tail', () => {
    // firstVisible is the index of the first row IN the viewport. Handing it
    // the LAST row leaves the window covering only the overscan below it, and
    // the top of the viewport renders as blank spacer — which in a full-screen
    // TUI means the first lines of the file simply are not there.
    const total = 500;
    const viewportRows = 44;
    const firstVisible = total - viewportRows;
    const w = rowWindow({ firstVisible, viewportRows, overscan: 20, total, rowHeight: 17 });
    expect(w.start).toBeLessThanOrEqual(total - viewportRows);
    expect(w.end).toBe(total);
    expect(w.end - w.start).toBeGreaterThanOrEqual(viewportRows);
  });

  it('renders a whole alternate screen, which has no scrollback to window', () => {
    // vim, htop, less. The grid IS the buffer, and every row of it is on
    // screen at once.
    const total = 45;
    const w = rowWindow({ firstVisible: 1, viewportRows: 44, overscan: 20, total, rowHeight: 17 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(total);
  });

  it('covers the viewport even when firstVisible is stale', () => {
    // firstVisible is React state and can lag the rows it describes — a pane
    // hidden when it was last set, a buffer that changed size under it, a
    // screen swap. The shortfall renders as blank spacer over live output, and
    // no amount of scrolling recovers rows that were never in the document.
    const w = rowWindow({ firstVisible: 1032, viewportRows: 44, overscan: 20, total: 1033, rowHeight: 17 });
    expect(w.end - w.start).toBeGreaterThanOrEqual(44);
    expect(w.end).toBe(1033);
    expect(w.padTopPx + (w.end - w.start) * 17 + w.padBottomPx).toBe(1033 * 17);
  });

  it('still renders everything when the buffer is smaller than the viewport', () => {
    const w = rowWindow({ firstVisible: 40, viewportRows: 44, overscan: 20, total: 12, rowHeight: 17 });
    expect(w).toMatchObject({ start: 0, end: 12, padTopPx: 0, padBottomPx: 0 });
  });
});
