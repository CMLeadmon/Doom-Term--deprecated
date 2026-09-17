import { describe, it, expect } from 'vitest';
import {
  shouldEngage, predict, reconcile, noteSample, rttOf,
  EXCLUDED_PROGRAMS, LATENCY_THRESHOLD_MS,
} from './localEcho';

describe('localEcho', () => {
  it('stays disengaged until latency has actually been measured', () => {
    // No measurement is not a fast link and not a slow one.
    expect(shouldEngage({ rttMs: null, altScreen: false, foreground: null })).toBe(false);
  });

  it('stays disengaged on a fast link', () => {
    expect(shouldEngage({ rttMs: 8, altScreen: false, foreground: null })).toBe(false);
    expect(shouldEngage({ rttMs: LATENCY_THRESHOLD_MS, altScreen: false, foreground: null })).toBe(false);
  });

  it('engages above the threshold', () => {
    expect(shouldEngage({ rttMs: 120, altScreen: false, foreground: null })).toBe(true);
  });

  it('never engages on the alternate screen', () => {
    expect(shouldEngage({ rttMs: 400, altScreen: true, foreground: null })).toBe(false);
  });

  it('never engages for a full-screen editor, whatever its case', () => {
    for (const program of EXCLUDED_PROGRAMS) {
      expect(shouldEngage({ rttMs: 400, altScreen: false, foreground: program })).toBe(false);
      expect(shouldEngage({ rttMs: 400, altScreen: false, foreground: program.toUpperCase() })).toBe(false);
    }
  });

  it('predicts printable ASCII only', () => {
    expect(predict([], 'a')).toEqual(['a']);
    expect(predict([], ' ')).toEqual([' ']);
    expect(predict([], '~')).toEqual(['~']);
    expect(predict([], '\x1b[A')).toBeNull();
    expect(predict([], '\r')).toBeNull();
    expect(predict([], '\x03')).toBeNull();
    expect(predict([], '\t')).toBeNull();
  });

  it('lets backspace erase a prediction it made', () => {
    expect(predict(['a', 'b'], '\x7f')).toEqual(['a']);
  });

  it('refuses backspace with nothing of its own to erase', () => {
    // Erasing past our own predictions edits a buffer we cannot see, which is
    // how a character becomes unkillable.
    expect(predict([], '\x7f')).toBeNull();
  });

  it('keeps predictions the child confirms, in order', () => {
    expect(reconcile(['a', 'b'], 'ab')).toEqual([]);
    expect(reconcile(['a', 'b'], 'a')).toEqual(['b']);
    expect(reconcile(['a'], '')).toEqual(['a']);
  });

  it('drops every prediction on the first disagreement', () => {
    expect(reconcile(['a', 'b'], 'x')).toBeNull();
    expect(reconcile(['a'], '\x1b[2J')).toBeNull();
    expect(reconcile(['a', 'b'], 'ax')).toBeNull();
  });

  it('takes the median round trip, so one stall does not decide the policy', () => {
    let s: number[] = [];
    for (const ms of [20, 22, 21, 800, 19, 23]) s = noteSample(s, ms);
    expect(rttOf(s)).toBeLessThan(LATENCY_THRESHOLD_MS);
  });

  it('reports no round trip until something is measured', () => {
    expect(rttOf([])).toBeNull();
  });

  it('keeps the window bounded and ignores nonsense samples', () => {
    let s: number[] = [];
    for (let i = 0; i < 50; i++) s = noteSample(s, i);
    expect(s.length).toBeLessThanOrEqual(8);
    expect(noteSample([5], NaN)).toEqual([5]);
    expect(noteSample([5], -1)).toEqual([5]);
  });
});
