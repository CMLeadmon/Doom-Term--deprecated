import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The plate is a canvas the reference renderer draws into, and the terminal
// view measures a real font grid; neither exists under jsdom and neither is
// what this file is about. Everything else — the hook, the bind effect, the
// picker — is the real thing.
vi.mock('./components/StatusPlate', () => ({ StatusPlate: () => null }));
const renderedTerminal = vi.hoisted(() => ({ request: undefined as unknown }));
vi.mock('./components/RawTerminalView', () => ({
  RawTerminalView: (props: { viewActionRequest?: unknown }) => {
    renderedTerminal.request = props.viewActionRequest;
    return <button type="button" data-testid="raw-terminal">TERMINAL</button>;
  },
}));

import { App } from './App';
import { ptyClient } from './core/ptyClient';

/** See core/sessionStore.test.ts: window.localStorage is undefined by default here. */
let store: Map<string, string>;
let original: PropertyDescriptor | undefined;

beforeEach(() => {
  renderedTerminal.request = undefined;
  store = new Map();
  original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

afterEach(() => {
  if (original) Object.defineProperty(window, 'localStorage', original);
  else delete (window as unknown as Record<string, unknown>).localStorage;
  vi.restoreAllMocks();
});

const storedSet = () => JSON.stringify({
  workspaces: [{
    id: 'w', name: 'PROJ', rootPath: '/home/u/proj', activeGroupId: 'g',
    groups: [{
      id: 'g', projectId: 'w', name: 'Main Workstream', layout: 'single',
      activeNodeId: 'n1', nodeIds: ['n1'], paneTree: { type: 'leaf', sessionId: 'n1' },
      createdAt: 1,
    }],
    nodes: {
      n1: {
        id: 'n1', groupId: 'g', title: 'Terminal 1', number: 1, kind: 'terminal',
        cwd: '/home/u/proj', gitBranch: '', activeBlockId: null, isTuiActive: false,
        agentState: 'idle', tuiLines: [], commandHistory: [], createdAt: 1,
      },
    },
  }],
  activeWorkspaceId: 'w',
});

describe('startup', () => {
  it('asks where to open, and starts nothing, when there is nothing to restore', async () => {
    const ensure = vi.spyOn(ptyClient, 'ensureSession').mockImplementation(() => {});
    await act(async () => { render(<App />); });

    expect(screen.getByText(/OPEN WORKSPACE/i)).toBeDefined();
    // The whole point of the gate: a shell in HOME, which nobody chose, must
    // not already be running behind the picker.
    expect(ensure).not.toHaveBeenCalled();
  });

  it('does not ask when a workspace was restored', () => {
    vi.spyOn(ptyClient, 'ensureSession').mockImplementation(() => {});
    store.set('DOOM_TERM_WORKSPACES_V2', storedSet());
    render(<App />);

    expect(screen.queryByText(/OPEN WORKSPACE/i)).toBeNull();
  });

  it('keeps focus in the required workspace picker', async () => {
    vi.spyOn(ptyClient, 'ensureSession').mockImplementation(() => {});
    render(<App />);

    const picker = screen.getByRole('combobox', { name: /workspace path or folder filter/i });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 40)); });
    expect(document.activeElement).toBe(picker);
  });

  it('does not replay a palette view action after a snapshot is revived', async () => {
    vi.spyOn(ptyClient, 'getIsConnected').mockReturnValue(true);
    vi.spyOn(ptyClient, 'listSessions').mockResolvedValue({ request_id: 'test', sessions: [] });
    vi.spyOn(ptyClient, 'ensureSession').mockImplementation(() => {});
    vi.spyOn(ptyClient, 'createSession').mockResolvedValue('a'.repeat(32));
    store.set('DOOM_TERM_WORKSPACES_V2', storedSet());
    render(<App />);

    const revive = await screen.findByRole('button', { name: /start a new shell here/i });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.click(await screen.findByRole('option', { name: /quick select developer reference/i }));
    fireEvent.click(revive);

    await waitFor(() => expect(screen.getByTestId('raw-terminal')).toBeDefined());
    expect(renderedTerminal.request).toBeNull();
  });
});
