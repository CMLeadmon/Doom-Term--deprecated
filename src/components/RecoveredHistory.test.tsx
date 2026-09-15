import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecoveredHistory } from './RecoveredHistory';

describe('recovered history surface', () => {
  it('shows cache and capture separately with an explicit discontinuity', () => {
    render(<RecoveredHistory cache={[{ id: 'cached', timestamp: 0, spans: [{ text: 'LOCAL CACHE' }] }]}
      cacheTruncated history={{ status: 'complete', data: '\x1b[31mTMUX CAPTURE\x1b[0m', reason: null,
        captureId: 'a'.repeat(32), historyAtLimit: true, potentiallyOverlapping: true, potentiallyIncomplete: true }} />);
    expect(screen.getByRole('region', { name: 'Recovered history' }).textContent).toMatch(/DISCONTINUOUS.*LOCAL CACHE.*TMUX CAPTURE.*LIVE VIEW STARTS BELOW/s);
    expect(screen.getByText('TMUX CAPTURE').textContent).not.toContain('\x1b');
    expect(screen.getByText(/CACHED PREFIX TRUNCATED/)).toBeDefined();
  });
  it('discloses an incomplete transfer without fabricating empty history', () => {
    render(<RecoveredHistory cache={[]} history={{ status: 'incomplete', data: null,
      reason: 'History transfer incomplete', potentiallyOverlapping: true, potentiallyIncomplete: true }} />);
    expect(screen.getByRole('status').textContent).toMatch(/incomplete/i);
    expect(screen.queryByRole('region', { name: 'Captured tmux history' })).toBeNull();
  });
});
