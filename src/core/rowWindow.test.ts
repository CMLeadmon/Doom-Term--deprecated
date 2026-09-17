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
});
