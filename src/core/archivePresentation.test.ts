import { describe, expect, it } from 'vitest';
import { archivePresentationText } from './archivePresentation';

describe('recovered archive presentation', () => {
  it('preserves rows and Unicode while rendering terminal controls inert', () => {
    expect(archivePresentationText('\x1b[31mRED\x1b[0m\r\n三\x1b]0;secret\x07\nNEXT\x00'))
      .toBe('RED\n三\nNEXT');
  });
  it('removes bounded control strings and incomplete escape tails', () => {
    expect(archivePresentationText('A\x1bPpayload\x1b\\B\x1b[?25hC\x1b[')).toBe('ABC');
  });
});
