import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ptyClient, DirectoryListing, looksLikeAbsolutePath } from '../core/ptyClient';
import { SessionStore } from '../core/sessionStore';
import { audioEngine } from '../core/audioEngine';
import { useDialogFocus } from '../hooks/useDialogFocus';

const RESULTS_ID = 'workspace-results';

function optionId(id: string): string {
  return `workspace-option-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

interface WorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectWorkspace: (path: string, name?: string) => void;
}

export const WorkspaceModal: React.FC<WorkspaceModalProps> = ({
  isOpen,
  onClose,
  onSelectWorkspace,
}) => {
  const [currentPath, setCurrentPath] = useState<string>('~');
  const [inputQuery, setInputQuery] = useState<string>('');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<{ name: string; path: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen, inputRef);

  const loadDirectory = useCallback(async (path: string) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await ptyClient.browseDirectory(path);
      setListing(res);
      setCurrentPath(res.current_path);
      setSelectedIndex(0);
    } catch (e) {
      // A failed browse used to be swallowed, leaving the previous listing on
      // screen as if nothing had happened.
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setRecentWorkspaces(SessionStore.loadRecentWorkspaces());
    loadDirectory('~');
    // Deliberately keyed on isOpen only: loadDirectory sets currentPath, so
    // depending on currentPath here re-fired this on every navigation and
    // issued overlapping requests.
  }, [isOpen, loadDirectory]);

  // Combine items: Action buttons, Parent directory (if any), Entries, Recent workspaces
  interface ModalItem {
    id: string;
    kind: 'ACTION' | 'PARENT' | 'RECENT' | 'FOLDER';
    label: string;
    detail: string;
    action: () => void;
  }

  const items: ModalItem[] = [];

  // The input is both a filter and a path field, so decide which was meant.
  const typedPath = looksLikeAbsolutePath(inputQuery) ? inputQuery.trim() : null;

  items.push({
    id: 'open-target',
    kind: 'ACTION',
    label: typedPath ? `OPEN: ${typedPath}` : `OPEN: ${currentPath}`,
    detail: typedPath ? 'TYPED PATH' : 'SELECT CURRENT',
    action: () => {
      audioEngine.playSound('pickup', 2);
      onSelectWorkspace(typedPath ?? currentPath);
      onClose();
    },
  });

  // A typed path can also be browsed into before committing to it.
  if (typedPath) {
    items.push({
      id: 'browse-target',
      kind: 'ACTION',
      label: `BROWSE: ${typedPath}`,
      detail: 'LIST FOLDER',
      action: () => {
        audioEngine.playSound('click', 3);
        loadDirectory(typedPath);
      },
    });
  }

  // Parent directory navigation
  if (listing?.parent_path) {
    items.push({
      id: 'nav-parent',
      kind: 'PARENT',
      label: '.. (Parent Directory)',
      detail: listing.parent_path,
      action: () => {
        audioEngine.playSound('click', 3);
        loadDirectory(listing.parent_path!);
      },
    });
  }

  // Directory entries matching filter
  if (listing) {
    // While a path is being typed the query is not a filter, so leave the
    // listing intact rather than showing "no matches" for every keystroke.
    const filtered = listing.entries.filter(
      (e) =>
        e.is_dir &&
        (typedPath || !inputQuery || e.name.toLowerCase().includes(inputQuery.toLowerCase()))
    );

    for (const entry of filtered) {
      items.push({
        id: entry.path,
        kind: 'FOLDER',
        label: entry.name,
        detail: entry.is_git_repo ? 'GIT REPOSITORY' : 'DIRECTORY',
        action: () => {
          audioEngine.playSound('click', 3);
          loadDirectory(entry.path);
        },
      });
    }
  }

  // Recent Workspaces (when search is empty)
  if (!inputQuery && recentWorkspaces.length > 0) {
    for (const rec of recentWorkspaces) {
      items.push({
        id: `recent-${rec.path}`,
        kind: 'RECENT',
        label: rec.name,
        detail: rec.path,
        action: () => {
          audioEngine.playSound('pickup', 2);
          onSelectWorkspace(rec.path, rec.name);
          onClose();
        },
      });
    }
  }

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target;
    if (target instanceof HTMLButtonElement && e.key !== 'Escape') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, items.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[selectedIndex]) {
        items[selectedIndex].action();
      }
    }
  };

  if (!isOpen) return null;

  const selectedItem = items[selectedIndex];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-title"
        tabIndex={-1}
        className="panel plate w-full max-w-xl"
        style={{ boxShadow: 'var(--bevel-up)' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Panel Header */}
        <div className="ph flex justify-between items-center text-[11.5px] font-bold tracking-widest px-1 py-1 text-[#22201b]">
          <span id="workspace-title">OPEN WORKSPACE · MACHINE FILESYSTEM</span>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="opacity-75">↑↓ NAV · ENTER SELECT</span>
            <button
              type="button"
              aria-label="Close workspace picker"
              onClick={onClose}
              className="dt-focus-ring font-bold"
            >
              × ESC CLOSE
            </button>
          </div>
        </div>

        {/* Panel Body (Recessed) */}
        <div className="pb recess p-2 bg-[#14120f]">
          {/* Path / Search Input */}
          <div className="field recess flex items-center gap-2 px-2 py-1.5 mb-2 bg-[#1b1814] border border-[#2f2f2e]">
            <span style={{ color: 'var(--st-live)' }} className="font-bold">▸</span>
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label="Workspace path or folder filter"
              aria-controls={RESULTS_ID}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={selectedItem ? optionId(selectedItem.id) : undefined}
              autoComplete="off"
              value={inputQuery}
              onChange={(e) => {
                setInputQuery(e.target.value);
                setSelectedIndex(0);
              }}
              placeholder={`Current: ${currentPath} (type to filter or type full path)...`}
              className="dt-focus-ring bg-transparent text-[#d8cbb0] placeholder-[#8f8672] font-mono text-[12px] w-full"
            />
            {isLoading && <span className="text-[10px] text-[#e0a92c] animate-pulse">READING…</span>}
          </div>

          {loadError && (
            <div
              role="alert"
              className="px-2 py-1 mb-2 text-[11px] font-mono"
              style={{ color: 'var(--st-fail)' }}
            >
              {loadError}
            </div>
          )}

          {/* Directory & Workspace List */}
          <div
            id={RESULTS_ID}
            role="listbox"
            aria-label="Workspace locations"
            aria-busy={isLoading}
            className="max-h-72 overflow-y-auto flex flex-col gap-1 pr-1"
          >
            {items.length === 0 ? (
              <div className="p-4 text-center text-xs font-mono text-[#8f8672]">
                No matching folders found in this directory.
              </div>
            ) : (
              items.map((item, idx) => {
                const isSelected = idx === selectedIndex;

                return (
                  <div
                    id={optionId(item.id)}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                    key={item.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setSelectedIndex(idx);
                      item.action();
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`dt-focus-ring row flex items-center gap-3 px-2 py-1 cursor-pointer font-mono text-[12px] transition-none ${
                      isSelected
                        ? 'row sel plate text-[#3a2a04] font-bold'
                        : 'text-[#d8cbb0] hover:bg-[#1b1814]'
                    }`}
                  >
                    <span
                      className="k w-16 shrink-0 text-[10px] tracking-wider uppercase font-bold"
                      style={{
                        color: isSelected
                          ? '#3d3830'
                          : item.kind === 'ACTION'
                          ? 'var(--st-live)'
                          : item.kind === 'RECENT'
                          ? 'var(--st-pass)'
                          : 'var(--ink-dim)',
                      }}
                    >
                      {item.kind}
                    </span>
                    <span className="v flex-1 truncate text-left">{item.label}</span>
                    <span
                      className="r shrink-0 text-[10.5px] tabular-nums"
                      style={{ color: isSelected ? '#3d3830' : 'var(--ink-dim)' }}
                    >
                      {item.detail}
                    </span>
                  </div>
                );
              })
            )}
          </div>
          <div role="status" aria-live="polite"
            className={listing?.truncated ? 'px-2 py-1 text-[11px] font-mono' : 'sr-only'}
            style={listing?.truncated ? { color: 'var(--st-wait)' } : undefined}>
            {listing?.truncated && 'Partial listing — enter a full path to reach folders not shown. '}
            {items.length} {items.length === 1 ? 'workspace location' : 'workspace locations'}
          </div>
        </div>
      </div>
    </div>
  );
};
