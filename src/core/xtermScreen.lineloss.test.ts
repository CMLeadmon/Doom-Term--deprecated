import { describe, expect, it } from 'vitest';
import { getEmulator, resetAllEmulators } from './emulatorRegistry';

/**
 * Rapid line output must survive the emulator, not just the daemon.
 *
 * The browser recovery fixture writes 510 numbered lines and two or three of
 * them, always around CELL_458, never reach the rendered rows - in the
 * uninterrupted control run, with no disconnect involved. The child writes them
 * and the Rust journal delivers all 510, so the loss is on this side.
 */
describe('rapid line output', () => {
  it('keeps every line of a long fast burst in getLines()', async () => {
    resetAllEmulators();
    const screen = getEmulator('burst');
    const total = 510;
    // Many small writes, as the demuxer delivers them, rather than one blob.
    for (let i = 0; i < total; i++) screen.write(`CELL_${String(i).padStart(3, '0')}\r\n`);
    await screen.drain();
    const rendered = screen.getLines().map(line =>
      line.spans.map(span => span.text).join('').trimEnd());
    const missing: string[] = [];
    for (let i = 0; i < total; i++) {
      const cell = `CELL_${String(i).padStart(3, '0')}`;
      if (!rendered.includes(cell)) missing.push(cell);
    }
    expect({ missing, rendered: rendered.length }).toEqual({ missing: [], rendered: rendered.length });
  }, 30000);
});
