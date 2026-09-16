import { describe, it, expect } from 'vitest';
import { quantizeCell, gridSize, tracking } from './cellMetrics';

describe('quantizeCell', () => {
  it('floors a fractional advance so it cannot drift across a row', () => {
    // At 7.2px per cell an 80-column row is 16px wider than 80 whole cells,
    // which is a full column of drift by the right margin.
    expect(quantizeCell(7.2, 15.6)).toEqual({ width: 7, height: 15 });
  });

  it('never returns a zero dimension, which would divide by zero downstream', () => {
    expect(quantizeCell(0, 0)).toEqual({ width: 1, height: 1 });
    expect(quantizeCell(0.4, 0.9)).toEqual({ width: 1, height: 1 });
  });
});

describe('gridSize', () => {
  const cell = { width: 7, height: 15 };

  it('floors, because a partly visible column is one the shell wraps into', () => {
    expect(gridSize(703, 452, cell)).toEqual({ cols: 100, rows: 30 });
  });

  it('clamps to a floor an agent CLI can do arithmetic on', () => {
    expect(gridSize(10, 10, cell)).toEqual({ cols: 20, rows: 4 });
  });

  it('reports a real grid for an ordinary pane', () => {
    expect(gridSize(1400, 900, cell)).toEqual({ cols: 200, rows: 60 });
  });
});

describe('tracking', () => {
  // Measured in Chromium on 2026-09-16: the font-mono stack at 13px advances
  // 7.80127px per column, which quantizeCell floors to 7. Text laid out at the
  // real advance and a caret placed at `col * 7` disagree by 0.8px per column —
  // a whole cell by column 9, which is the "caret one place to the left" bug.
  it('closes the gap between the real advance and the integer cell', () => {
    const advance = 7.80126953125;
    const cell = quantizeCell(advance, 17);
    expect(tracking(cell, advance)).toBeCloseTo(-0.80126953125, 8);
    // Forty columns of text must then occupy forty whole cells, exactly.
    expect(40 * (advance + tracking(cell, advance))).toBeCloseTo(40 * cell.width, 8);
  });

  it('is zero when the font already advances a whole pixel', () => {
    expect(tracking({ width: 8, height: 16 }, 8)).toBe(0);
  });

  // quantizeCell clamps a sub-pixel advance up to 1, so the difference would be
  // POSITIVE and would push text off the grid it is meant to sit on. A
  // measurement that small is not a font, it is a missing one.
  it('never widens a cell to cover a nonsense measurement', () => {
    expect(tracking({ width: 1, height: 1 }, 0.4)).toBe(0);
    expect(tracking({ width: 8, height: 16 }, Number.NaN)).toBe(0);
    expect(tracking({ width: 8, height: 16 }, 0)).toBe(0);
  });
});
