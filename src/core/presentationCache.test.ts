import { describe, expect, it } from 'vitest';
import { boundCachedLines } from './presentationCache';

describe('bounded presentation cache', () => {
  it('keeps the newest whole lines within 5,000 lines and 8 MiB, disclosing truncation', () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ id: String(i), timestamp: i, spans: [{ text: String(i) }] }));
    const cache = boundCachedLines(rows);
    expect(cache.lines).toHaveLength(5000); expect(cache.lines[0].id).toBe('1');
    expect(cache.truncated).toBe(true);
    const large = boundCachedLines([{ id: 'big', timestamp: 0, spans: [{ text: '三'.repeat(3 * 1024 * 1024) }] }, rows.at(-1)!]);
    expect(large.lines).toHaveLength(1); expect(large.truncated).toBe(true);
    expect(large.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
  it('whitelists presentation fields and never retains cursors, tokens, or arbitrary CSS', () => {
    const cache = boundCachedLines([{ id: 'saved', timestamp: 1, attachment_id: 'secret', isWrapped: true,
      spans: [{ text: 'SAFE', bold: true, fg: '#ff0000', bg: 'url(https://example.test)', command: 'not presentation' }] }]);
    expect(cache.lines).toEqual([{ id: 'saved', timestamp: 1, isWrapped: true, spans: [{ text: 'SAFE', fg: '#ff0000', bold: true }] }]);
    expect(cache.bytes).toBe(new TextEncoder().encode(JSON.stringify(cache.lines)).length);
  });
});
