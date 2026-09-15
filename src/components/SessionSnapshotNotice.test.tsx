import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionSnapshotNotice } from './SessionSnapshotNotice';

describe('cached-only terminal presentation', () => {
  it('shows selectable cached lines and provenance without claiming that the process is absent', () => {
    const start = vi.fn();
    render(<SessionSnapshotNotice title="Saved work" cwd="/repo" pending={false} onStart={start}
      lines={[{ id: 'cached', timestamp: 0, spans: [{ text: 'SAVED OUTPUT', bold: true }] }]}
      snapshotOf={{ sessionId: 'previous', incarnation: 'a'.repeat(32) }} />);
    expect(screen.queryByText(/NO PROCESS IS RUNNING/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Cached terminal lines' }).textContent).toContain('SAVED OUTPUT');
    expect(screen.getByText(/previous/).textContent).toContain('aaaaaaaa');
    expect(screen.queryByTestId('raw-terminal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'START A NEW SHELL HERE' }));
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('keeps cached output readable during failed or pending discovery', () => {
    render(<SessionSnapshotNotice title="Saved work" cwd="/repo" pending onStart={() => {}}
      lines={[{ id: 'cached', timestamp: 0, spans: [{ text: 'READ WHILE OFFLINE' }] }]} />);
    expect(screen.getByRole('region', { name: 'Cached terminal lines' }).textContent).toContain('READ WHILE OFFLINE');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
