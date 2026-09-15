import { describe, it, expect, vi } from 'vitest';
import {
  createDefaultWorkspace, createWorkspaceForFolder, SessionStore, backfillPaneTrees,
  backfillSessionNumbers, readStoredWorkspaceSet,
} from './sessionStore';
import type { SessionNode } from '../types/sessionTree';

/**
 * This suite runs under jsdom, but Node's own experimental `localStorage` global
 * shadows jsdom's and is unavailable without `--localstorage-file`, so
 * `window.localStorage` is undefined by default here. That is genuinely one of
 * the two branches `loadRecentWorkspaces` has, so we exercise it as-is and
 * install a minimal in-memory store to reach the other.
 */
function withLocalStorage<T>(seed: Record<string, string>, fn: () => T): T {
  const map = new Map(Object.entries(seed));
  const fake = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };

  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(window, 'localStorage', original);
    else delete (window as unknown as Record<string, unknown>).localStorage;
  }
}

/**
 * The other branch: a window with no storage at all.
 *
 * That used to be the default here and was asserted as one, which made this
 * file pass locally and fail in CI. Whether `window.localStorage` exists at all
 * depends on the Node version running the suite — Node 26's own experimental
 * global shadows jsdom's and is unavailable without `--localstorage-file`,
 * while under Node 22 jsdom's is simply there. A test may not assume either;
 * it has to say which one it means.
 */
function withoutLocalStorage<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    value: undefined, configurable: true, writable: true,
  });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(window, 'localStorage', original);
    else delete (window as unknown as Record<string, unknown>).localStorage;
  }
}

describe('workspace seeding', () => {
  it('seeds no fabricated product copy', () => {
    const serialised = JSON.stringify(createDefaultWorkspace());
    expect(serialised).not.toMatch(/Architectural|VelaTerm|nodeterm|Worktree|Messaging Bus|Multi-Lens/i);
  });

  it('opens a new session with no output at all', () => {
    const ws = createDefaultWorkspace();
    const node = Object.values(ws.nodes)[0];
    expect(node.tuiLines).toEqual([]);
    expect(node.commandHistory).toEqual([]);
  });

  it('does not open at a path from the author\'s own machine', () => {
    const ws = createDefaultWorkspace();
    expect(ws.rootPath).toBe('~');
    expect(JSON.stringify(ws)).not.toMatch(/Projects\/Doom Term/);
  });

  it('claims no branch until the daemon reports one', () => {
    // A folder that is not a repository has no branch; hardcoding 'main' is
    // how a non-repo still rendered BRANCH: MAIN on the plate.
    expect(Object.values(createDefaultWorkspace().nodes)[0].gitBranch).toBe('');
    const opened = createWorkspaceForFolder('/tmp/not-a-repo');
    expect(Object.values(opened.nodes)[0].gitBranch).toBe('');
  });

  it('gives every workspace a distinct id', () => {
    // Ids were built from Date.now(), so two folders opened in the same
    // millisecond collided and the second could never be focused.
    const ids = new Set(
      Array.from({ length: 50 }, (_, i) => createWorkspaceForFolder(`/tmp/w${i}`).id)
    );
    expect(ids.size).toBe(50);
  });

  it('names a folder workspace after the folder', () => {
    const ws = createWorkspaceForFolder('/home/u/Projects/thing');
    expect(ws.name).toBe('THING');
    expect(ws.rootPath).toBe('/home/u/Projects/thing');
  });
});

describe('recent workspaces', () => {
  it('invents nothing when storage is unavailable', () => {
    withoutLocalStorage(() => {
      expect(window.localStorage).toBeUndefined();
      expect(SessionStore.loadRecentWorkspaces()).toEqual([]);
    });
  });

  it('invents nothing on a clean machine with empty storage', () => {
    withLocalStorage({}, () => {
      expect(SessionStore.loadRecentWorkspaces()).toEqual([]);
    });
  });

  it('returns what was actually stored', () => {
    const stored = [{ name: 'THING', path: '/home/u/Projects/thing' }];
    withLocalStorage({ DOOM_TERM_RECENT_WORKSPACES_V1: JSON.stringify(stored) }, () => {
      expect(SessionStore.loadRecentWorkspaces()).toEqual(stored);
    });
  });
});

describe('stored workspaces', () => {
  const V2 = 'DOOM_TERM_WORKSPACES_V2';
  const V1 = 'DOOM_TERM_WORKSPACE_V1';
  const storedSet = (path: string) => {
    const ws = createWorkspaceForFolder(path);
    return JSON.stringify({ workspaces: [ws], activeWorkspaceId: ws.id });
  };

  it('persists presentation and incarnation but no live lease, parser cursor, or replayable state', () => {
    const workspace = createDefaultWorkspace();
    Object.assign(workspace.nodes['node-1'], { incarnation: 'a'.repeat(32), attachment_id: 'secret-lease',
      stream_epoch: 'b'.repeat(32), appliedSequence: '123', pendingWrites: ['NEVER REPLAY'], atPrompt: true,
      executionSerial: 12, lastLiveExecutionEventId: 'old', lastHookEventId: 'old-ask', blockedOnUser: true,
      agentState: 'running', tuiLines: [{ id: 'line', timestamp: 1, spans: [{ text: 'CACHED OUTPUT' }] }],
      snapshotOf: { sessionId: 'source', incarnation: 'c'.repeat(32) },
    });
    withLocalStorage({}, () => {
      vi.useFakeTimers();
      try {
        SessionStore.saveWorkspaceSet({ workspaces: [workspace], activeWorkspaceId: workspace.id });
        vi.advanceTimersByTime(400);
        const saved = window.localStorage.getItem(V2)!;
        expect(saved).not.toMatch(/attachment_id|secret-lease|stream_epoch|appliedSequence|pendingWrites|NEVER REPLAY|executionSerial|lastLiveExecutionEventId|lastHookEventId|blockedOnUser|atPrompt/);
        const restored = readStoredWorkspaceSet()!.workspaces[0].nodes['node-1'];
        expect(restored).toMatchObject({ incarnation: 'a'.repeat(32), agentState: 'unknown',
          tuiLines: workspace.nodes['node-1'].tuiLines, snapshotOf: { sessionId: 'source', incarnation: 'c'.repeat(32) } });
        expect(workspace.nodes['node-1'].agentState).toBe('running');
      } finally { vi.useRealTimers(); }
    });
  });

  it('sanitizes legacy caches on read and bounds retained lines without silently treating them as complete', () => {
    const workspace = createDefaultWorkspace();
    Object.assign(workspace.nodes['node-1'], { attachment_id: 'old-lease', appliedSequence: '100',
      tuiLines: Array.from({ length: 5001 }, (_, i) => ({ id: String(i), timestamp: i, spans: [{ text: String(i) }] })),
    });
    withLocalStorage({ [V1]: JSON.stringify(workspace) }, () => {
      const restored = readStoredWorkspaceSet()!.workspaces[0].nodes['node-1'];
      expect(JSON.stringify(restored)).not.toMatch(/old-lease|appliedSequence/);
      expect(restored.tuiLines).toHaveLength(5000);
      expect(restored.tuiLines[0].id).toBe('1');
      expect(restored.cacheTruncated).toBe(true);
    });
  });

  it('reports nothing stored when storage is unavailable', () => {
    // Same branch loadRecentWorkspaces has: no storage is not a restore.
    withoutLocalStorage(() => {
      expect(window.localStorage).toBeUndefined();
      expect(SessionStore.hasStoredWorkspaceSet()).toBe(false);
    });
  });

  it('reports nothing stored on a clean machine', () => {
    withLocalStorage({}, () => {
      expect(readStoredWorkspaceSet()).toBeNull();
      expect(SessionStore.hasStoredWorkspaceSet()).toBe(false);
    });
  });

  it('still hands back a workspace to show when nothing was stored', () => {
    withLocalStorage({}, () => {
      expect(SessionStore.loadWorkspaceSet().workspaces[0].rootPath).toBe('~');
    });
  });

  it('reports a stored set, and returns it', () => {
    withLocalStorage({ [V2]: storedSet('/home/u/proj') }, () => {
      expect(SessionStore.hasStoredWorkspaceSet()).toBe(true);
      expect(readStoredWorkspaceSet()?.workspaces[0].rootPath).toBe('/home/u/proj');
    });
  });

  it('reports a legacy single workspace as stored', () => {
    // A V1 user has chosen a folder before; a first-run prompt would be a lie.
    withLocalStorage({ [V1]: JSON.stringify(createWorkspaceForFolder('/legacy')) }, () => {
      expect(SessionStore.hasStoredWorkspaceSet()).toBe(true);
      expect(readStoredWorkspaceSet()?.workspaces[0].rootPath).toBe('/legacy');
    });
  });

  it('treats corrupt storage as nothing stored', () => {
    withLocalStorage({ [V2]: '{{{not json' }, () => {
      expect(readStoredWorkspaceSet()).toBeNull();
      expect(SessionStore.loadWorkspaceSet().workspaces[0].rootPath).toBe('~');
    });
  });

  it('treats an empty workspace list as nothing stored', () => {
    withLocalStorage({ [V2]: JSON.stringify({ workspaces: [], activeWorkspaceId: '' }) }, () => {
      expect(readStoredWorkspaceSet()).toBeNull();
    });
  });
});

describe('backfillSessionNumbers', () => {
  const ws = (nodes: Record<string, Partial<SessionNode>>) => ({
    workspaces: [{
      id: 'w', name: 'W', rootPath: '/', activeGroupId: 'g',
      groups: [{ id: 'g', projectId: 'p', name: 'M', layout: 'single' as const,
                 activeNodeId: Object.keys(nodes)[0], nodeIds: Object.keys(nodes), createdAt: 0 }],
      nodes: Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, {
        id, groupId: 'g', title: id, kind: 'terminal' as const, cwd: '/', gitBranch: '',
        activeBlockId: null, isTuiActive: false, agentState: 'idle' as const,
        tuiLines: [], commandHistory: [], createdAt: 0, ...n,
      }])) as Record<string, SessionNode>,
    }],
    activeWorkspaceId: 'w',
  });

  it('numbers a session stored before numbers existed', () => {
    // Ctrl+N is the whole addressing scheme now, so an unnumbered restored
    // session is one the keyboard cannot reach at all.
    const out = backfillSessionNumbers(ws({ a: { number: undefined as never } }));
    expect(out.workspaces[0].nodes.a.number).toBe(1);
  });

  it('leaves numbers that already exist alone', () => {
    const out = backfillSessionNumbers(ws({ a: { number: 5 } }));
    expect(out.workspaces[0].nodes.a.number).toBe(5);
  });

  it('fills around the numbers already taken', () => {
    const out = backfillSessionNumbers(ws({
      a: { number: 1, createdAt: 0 },
      b: { number: undefined as never, createdAt: 1 },
      c: { number: 2, createdAt: 2 },
    }));
    expect(out.workspaces[0].nodes.b.number).toBe(3);
  });

  it('numbers in creation order, so learned numbering survives', () => {
    const out = backfillSessionNumbers(ws({
      late: { number: undefined as never, createdAt: 900 },
      early: { number: undefined as never, createdAt: 100 },
    }));
    expect(out.workspaces[0].nodes.early.number).toBe(1);
    expect(out.workspaces[0].nodes.late.number).toBe(2);
  });

  it('gives null past nine rather than an unreachable number', () => {
    const nodes: Record<string, Partial<SessionNode>> = {};
    for (let i = 1; i <= 9; i++) nodes[`n${i}`] = { number: i, createdAt: i };
    nodes.overflow = { number: undefined as never, createdAt: 10 };
    const out = backfillSessionNumbers(ws(nodes));
    expect(out.workspaces[0].nodes.overflow.number).toBeNull();
  });
});

describe('backfillPaneTrees', () => {
  it('migrates a legacy single layout around its active session', () => {
    const set = {
      workspaces: [{
        id: 'w', name: 'W', rootPath: '/', activeGroupId: 'g',
        groups: [{ id: 'g', projectId: 'w', name: 'G', layout: 'single' as const,
          activeNodeId: 'b', nodeIds: ['a', 'b'], createdAt: 0 }],
        nodes: {} as Record<string, SessionNode>,
      }],
      activeWorkspaceId: 'w',
    };
    expect(backfillPaneTrees(set).workspaces[0].groups[0].paneTree)
      .toMatchObject({ type: 'leaf', sessionId: 'b' });
  });
});
