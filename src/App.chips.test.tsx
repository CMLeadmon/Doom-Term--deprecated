import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The three status chips, driven through the same handler a canvas click uses.
 *
 * `chipAtPoint()` returns 0 | 1 | 2 and the plate's hover text promises a
 * distinct action for each. That promise had never been tested: the red chip
 * had no branch at all, and the gold chip ran the red one's body as well —
 * toggling notifications AND stealing pane focus, with the second toast
 * overwriting the confirmation of the thing the user actually clicked.
 *
 * These render the real App and stand in for the canvas with three buttons, so
 * what is exercised is App's own dispatch rather than a copy of it.
 */
vi.mock('./components/StatusPlate', () => ({
  StatusPlate: (props: { onSelectChip?: (i: number) => void; onOpenPermissionsModal?: () => void; telemetry: { chips: boolean[]; permissionMode: string } }) => (
    <div>
      <button onClick={props.onOpenPermissionsModal}>OPEN SETTINGS</button>
      <output data-testid="settings-state">{JSON.stringify(props.telemetry)}</output>
      {[0, 1, 2].map((i) => (
        <button key={i} type="button" data-testid={`chip-${i}`} onClick={() => props.onSelectChip?.(i)}>
          CHIP {i}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('./components/RawTerminalView', () => ({
  RawTerminalView: () => <button type="button" data-testid="raw-terminal">TERMINAL</button>,
}));

import { App } from './App';
import { ptyClient, type DemuxEventHandler } from './core/ptyClient';
import { audioEngine } from './core/audioEngine';

/** See core/sessionStore.test.ts: window.localStorage is undefined by default here. */
let store: Map<string, string>;
let original: PropertyDescriptor | undefined;

beforeEach(() => {
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
  vi.spyOn(ptyClient, 'ensureSession').mockImplementation(() => {});
  vi.spyOn(audioEngine, 'playSound').mockImplementation(() => {});
  audioEngine.setMuted(false);
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn().mockResolvedValue('granted') });
});

afterEach(() => {
  ptyClient.forgetSession('n1');
  ptyClient.forgetSession('n2');
  if (original) Object.defineProperty(window, 'localStorage', original);
  else delete (window as unknown as Record<string, unknown>).localStorage;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const workspaceWith = (node: Record<string, unknown>) => JSON.stringify({
  workspaces: [{
    id: 'w', name: 'PROJ', rootPath: '/home/u/proj', activeGroupId: 'g',
    groups: [{
      id: 'g', projectId: 'w', name: 'Main Workstream', layout: 'single',
      activeNodeId: 'n1', nodeIds: ['n1', 'n2'],
      paneTree: { type: 'leaf', sessionId: 'n1' },
      createdAt: 1,
    }],
    nodes: {
      n1: {
        id: 'n1', groupId: 'g', title: 'Terminal 1', number: 1, kind: 'terminal',
        cwd: '/home/u/proj', gitBranch: '', activeBlockId: null, isTuiActive: false,
        agentState: 'idle', tuiLines: [], commandHistory: [], createdAt: 1,
      },
      n2: node,
    },
  }],
  activeWorkspaceId: 'w',
});

const healthyNode = {
  id: 'n2', groupId: 'g', title: 'Terminal 2', number: 2, kind: 'terminal',
  cwd: '/home/u/proj', gitBranch: '', activeBlockId: null, isTuiActive: false,
  agentState: 'idle', tuiLines: [], commandHistory: [], createdAt: 2,
};

const failedNode = { ...healthyNode, agentState: 'errored', lastExitCode: 127 };

// StrictMode, because main.tsx mounts under it: it is what double-invokes a
// state updater, and so what makes an impure one observable here.
/**
 * Which pane carries the focus border. Siblings stay mounted, so presence in
 * the DOM says nothing — the live-coloured 1px border is what the user reads
 * as "this one has the keyboard", and it is what a focus steal moves.
 */
const focusedPane = () =>
  screen.getAllByTestId('pane-leaf')
    .find((pane) => pane.style.border.includes('var(--st-live)'))
    ?.getAttribute('data-pane');

const renderApp = (node: Record<string, unknown> = healthyNode) => {
  store.set('DOOM_TERM_WORKSPACES_V2', workspaceWith(node));
  render(<StrictMode><App /></StrictMode>);
};

describe('status chips', () => {
  it('does not show the previous pane\'s telemetry while waiting for the selected pane', () => {
    ptyClient.bindExisting('n1', '1'.repeat(32));
    ptyClient.bindExisting('n2', '2'.repeat(32));
    renderApp();
    ptyClient.setActiveSession('n1');
    const receive = (message: { event: string; data: unknown }) => (ptyClient as unknown as {
      handleServerMessage: (event: string, data: unknown) => void;
    }).handleServerMessage(message.event, message.data);
    act(() => receive({ event: 'Telemetry', data: {
      session_id: 'n1', incarnation: '1'.repeat(32), current_dir: '/home/u/proj', git_branch: 'main', isolation: 'host',
      agent_key: 'claude', agent_name: 'CLAUDE CODE', agent_model: 'fixture-model', context_used: 0.42, rate_used: 0.3,
    } }));
    expect(JSON.parse(screen.getByTestId('settings-state').textContent!).contextUsed).toBe(0.42);
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    expect(focusedPane()).toBe('n2');
    const selected = JSON.parse(screen.getByTestId('settings-state').textContent!);
    expect(selected.contextUsed).toBeUndefined();
    expect(selected.rateUsed).toBeUndefined();
    expect(selected.model).toBeUndefined();
    expect(selected.isolation).toBeUndefined();
    act(() => receive({ event: 'Telemetry', data: {
      session_id: 'n2', incarnation: '2'.repeat(32), current_dir: '/home/u/proj', isolation: 'host', agent_key: 'codex', context_used: 0.05,
    } }));
    expect(JSON.parse(screen.getByTestId('settings-state').textContent!).contextUsed).toBe(0.05);
  });
  it('shows a background workspace ask in the palette and activates its own pane', async () => {
    const stored = JSON.parse(workspaceWith(healthyNode));
    const other = structuredClone(stored.workspaces[0]);
    other.id = 'other-workspace';
    other.name = 'OTHER PROJECT';
    other.rootPath = '/other';
    other.nodes = { remote: { ...healthyNode, id: 'remote', groupId: 'remote-group', title: 'BACKGROUND ASK', blockedOnUser: true } };
    other.activeGroupId = 'remote-group';
    other.groups = [{ ...other.groups[0], id: 'remote-group', projectId: other.id, activeNodeId: 'remote', nodeIds: ['remote'], paneTree: { type: 'leaf', sessionId: 'remote' } }];
    stored.workspaces.push(other);
    store.set('DOOM_TERM_WORKSPACES_V2', JSON.stringify(stored));
    render(<StrictMode><App /></StrictMode>);
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'BACKGROUND ASK' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /BACKGROUND ASK/ })).toBeDefined());
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(focusedPane()).toBe('remote');
  });
  it('offers transient authentication without persisting the token', () => {
    const authenticate = vi.spyOn(ptyClient, 'authenticate').mockImplementation(() => {});
    let authChanged: (message: string | null) => void = () => undefined;
    vi.spyOn(ptyClient, 'onAuthChange').mockImplementation(handler => { authChanged = handler; return () => undefined; });
    renderApp();
    act(() => authChanged('Authentication required'));
    const token = screen.getByLabelText('Daemon access token');
    expect(token.getAttribute('type')).toBe('password');
    fireEvent.change(token, { target: { value: 'fixture-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'CONNECT' }));
    expect(authenticate).toHaveBeenCalledWith('fixture-token');
    expect([...store.values()].some((value) => value.includes('fixture-token'))).toBe(false);
    act(() => authChanged(null));
    expect(screen.queryByLabelText('Daemon access token')).toBeNull();
  });
  it('updates the chip and settings when sound is toggled from the palette', () => {
    renderApp();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.click(screen.getByText('Toggle Sound Effects'));
    expect(JSON.parse(screen.getByTestId('settings-state').textContent!).chips[0]).toBe(false);
    fireEvent.click(screen.getByText('OPEN SETTINGS'));
    fireEvent.click(screen.getByText(/SYSTEM QUICK-TOGGLES/));
    expect(screen.getByText('MUTED')).toBeDefined();
  });

  it('does not claim notifications enabled when browser permission is denied', async () => {
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn().mockResolvedValue('denied') });
    renderApp();
    expect(JSON.parse(screen.getByTestId('settings-state').textContent!).chips[1]).toBe(false);
    fireEvent.click(screen.getByTestId('chip-1'));
    await waitFor(() => expect(screen.getByText(/NOTIFICATIONS:.*DENIED/)).toBeDefined());
    expect(JSON.parse(screen.getByTestId('settings-state').textContent!).chips[1]).toBe(false);
  });

  it('never restores automatic Enter injection from a saved YOLO preference', async () => {
    store.set('doom-term-permission-mode', 'yolo');
    const write = vi.spyOn(ptyClient, 'writeToSession').mockReturnValue(false);
    renderApp({ ...healthyNode, blockedOnUser: true, attentionSerial: 1 });
    expect(JSON.parse(screen.getByTestId('settings-state').textContent!).permissionMode).toBe('manual');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)); });
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('OPEN SETTINGS'));
    expect(screen.getByRole('radio', { name: /Automatic approval unavailable/i }).hasAttribute('disabled')).toBe(true);
  });

  it('toggles only sound on the blue chip', () => {
    const toggleMute = vi.spyOn(audioEngine, 'toggleMute').mockReturnValue(true);
    renderApp();

    fireEvent.click(screen.getByTestId('chip-0'));

    expect(toggleMute).toHaveBeenCalledOnce();
    expect(screen.getByText(/SOUND FX: MUTED/)).toBeDefined();
  });

  it('toggles only notifications on the gold chip, without stealing pane focus', async () => {
    // The failing version toggled notifications and then also ran the red
    // chip's body, so asking for desktop alerts yanked the user onto an
    // unrelated errored session.
    renderApp(failedNode);
    expect(focusedPane()).toBe('n1');

    fireEvent.click(screen.getByTestId('chip-1'));

    expect(screen.getByText(/NOTIFICATIONS: DISABLED/)).toBeDefined();
    expect(focusedPane()).toBe('n1');
    await waitFor(() =>
      expect(store.get('doom-term-notifications-enabled')).toBe('false'));
  });

  it('does not open the execution mode modal from the notifications chip', () => {
    // Reachable from inside that modal, too: its own notifications toggle
    // used to route through this handler and re-open the modal it sat in.
    vi.spyOn(ptyClient, 'getIsConnected').mockReturnValue(true);
    renderApp();

    fireEvent.click(screen.getByTestId('chip-1'));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('persists exactly one notification flip per click', () => {
    // setToastMessage and the localStorage write used to live inside the
    // setState updater, which React runs twice under StrictMode.
    renderApp();
    const setItem = vi.spyOn(window.localStorage, 'setItem');

    fireEvent.click(screen.getByTestId('chip-1'));

    const flips = setItem.mock.calls
      .filter(([key]) => key === 'doom-term-notifications-enabled');
    expect(flips).toEqual([['doom-term-notifications-enabled', 'false']]);
  });

  it('jumps to a failed session on the red chip', () => {
    let handler: DemuxEventHandler | undefined;
    const register = ptyClient.registerHandler.bind(ptyClient);
    vi.spyOn(ptyClient, 'registerHandler').mockImplementation(value => {
      if (value.onStreamRecord) handler = value;
      return register(value);
    });
    renderApp(failedNode);
    // Saved state is presentation-only. Supply a verified catch-up observation
    // to restore this failure without treating it as a new notification.
    act(() => handler!.onStreamRecord?.({ session_id: 'n2', incarnation: '2'.repeat(32),
      stream_epoch: '3'.repeat(32), sequence: '1', observed_micros: 1,
      payload: { type: 'Event', payload: { type: 'ExecutionEnd', payload: { exit_code: 127 } } } }, {
      phase: 'catch-up', eventId: 'observed-failure', clockEpoch: '4'.repeat(32), observedMicros: 1,
      state: { completedCommands: 1, lastExitCode: 127, lastExecutionDurationMs: null, closed: false,
        atPrompt: null, cwd: null, agentState: 'errored', isTuiActive: false },
    }));

    fireEvent.click(screen.getByTestId('chip-2'));

    expect(screen.getByText(/JUMPED TO FAILED SESSION \#2/)).toBeDefined();
    expect(focusedPane()).toBe('n2');
  });

  it('reconnects the daemon on the red chip when nothing has failed', () => {
    vi.spyOn(ptyClient, 'getIsConnected').mockReturnValue(false);
    const connect = vi.spyOn(ptyClient, 'connect').mockImplementation(() => {});
    renderApp();

    fireEvent.click(screen.getByTestId('chip-2'));

    expect(connect).toHaveBeenCalledOnce();
    expect(screen.getByText(/RECONNECTING TO PTY DAEMON\.\.\./)).toBeDefined();
  });

  it('reports health on the red chip without opening an unrelated modal', () => {
    vi.spyOn(ptyClient, 'getIsConnected').mockReturnValue(true);
    renderApp();

    fireEvent.click(screen.getByTestId('chip-2'));

    expect(screen.getByText(/SYSTEM HEALTH: ALL SERVICES OPERATIONAL/)).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
