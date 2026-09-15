import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ptyClient, type DirectoryListing } from '../core/ptyClient';
import { WorkspaceModal } from './WorkspaceModal';

const listing: DirectoryListing = {
  request_id: 'browse-1',
  current_path: '/workspace',
  parent_path: '/',
  entries: [
    { name: 'doom-term', path: '/workspace/doom-term', is_dir: true, is_git_repo: true },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('WorkspaceModal', () => {
  it('connects its focused combobox to a busy listbox and selected option', async () => {
    let resolveListing: (value: DirectoryListing) => void = () => undefined;
    vi.spyOn(ptyClient, 'browseDirectory').mockReturnValue(new Promise((resolve) => {
      resolveListing = resolve;
    }));
    const onClose = vi.fn();
    const onSelectWorkspace = vi.fn();
    render(<WorkspaceModal isOpen onClose={onClose} onSelectWorkspace={onSelectWorkspace} />);

    const dialog = screen.getByRole('dialog', { name: /open workspace/i });
    const search = screen.getByRole('combobox', { name: /workspace path or folder filter/i });
    const results = screen.getByRole('listbox', { name: /workspace locations/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(search);
    expect(results.getAttribute('aria-busy')).toBe('true');
    expect(search.getAttribute('aria-controls')).toBe(results.id);
    const close = screen.getByRole('button', { name: /close workspace picker/i });
    fireEvent.keyDown(close, { key: 'Enter' });
    expect(onSelectWorkspace).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();

    await act(async () => resolveListing(listing));

    await waitFor(() => expect(results.getAttribute('aria-busy')).toBe('false'));
    const selected = screen.getAllByRole('option')[0];
    expect(search.getAttribute('aria-activedescendant')).toBe(selected.id);
    expect(selected.getAttribute('aria-selected')).toBe('true');
  });

  it('announces a browse failure instead of presenting stale content', async () => {
    vi.spyOn(ptyClient, 'browseDirectory').mockRejectedValue(new Error('permission denied'));
    render(<WorkspaceModal isOpen onClose={vi.fn()} onSelectWorkspace={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toContain('permission denied');
  });
  it('shows a partial-listing notice while keeping returned folders usable', async () => {
    vi.spyOn(ptyClient, 'browseDirectory').mockResolvedValue({ ...listing, truncated: true });
    render(<WorkspaceModal isOpen onClose={vi.fn()} onSelectWorkspace={vi.fn()} />);
    expect((await screen.findByRole('status')).textContent).toMatch(/partial listing/i);
    expect(screen.getByRole('option', { name: /doom-term/i })).toBeTruthy();
  });
});
