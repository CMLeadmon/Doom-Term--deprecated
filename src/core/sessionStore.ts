import { ProjectWorkspace, SessionGroup, SessionNode, WorkspaceSet } from '../types/sessionTree';
import { uniqueId } from './ids';
import { nextSessionNumber } from './sessionNumbers';
import { paneLeaf, treeFromLayout } from './paneTree';
import { workspacePresentation } from './workspacePresentation';

const STORAGE_KEY = 'DOOM_TERM_WORKSPACE_V1';

/**
 * Give every session a number, for workspaces stored before numbers existed.
 *
 * Ctrl+N is the entire addressing scheme now that the tab strip is gone, so a
 * restored session with no number is a session you cannot reach by keyboard at
 * all — and the plate's waiting rows draw it as "-". Lowest-free in creation
 * order, so the numbering a user already learned is the one they keep.
 */
export function backfillSessionNumbers(set: WorkspaceSet): WorkspaceSet {
  const ordered = set.workspaces.flatMap(ws => Object.values(ws.nodes))
    .sort((a, b) => a.createdAt - b.createdAt);
  const taken: number[] = [];
  const keep = new Set<string>();
  // Reserve all valid, unique slots before assigning any duplicates. A
  // duplicate 1 must not steal a later session's already-established 2.
  for (const node of ordered) {
    if (typeof node.number === 'number' && Number.isInteger(node.number)
      && node.number >= 1 && node.number <= 9 && !taken.includes(node.number)) {
      taken.push(node.number);
      keep.add(node.id);
    }
  }
  const assigned = new Map<string, number | null>();
  for (const node of ordered) {
    if (keep.has(node.id)) continue;
    const next = nextSessionNumber(taken);
    if (next !== null) taken.push(next);
    assigned.set(node.id, next);
  }
  return {
    ...set,
    workspaces: set.workspaces.map((ws) => {
      const nodes = { ...ws.nodes };
      for (const node of Object.values(nodes)) {
        if (assigned.has(node.id)) nodes[node.id] = { ...node, number: assigned.get(node.id)! };
      }
      return { ...ws, nodes };
    }),
  };
}

/** Upgrade the four legacy layout names into editable persistent geometry. */
export function backfillPaneTrees(set: WorkspaceSet): WorkspaceSet {
  return {
    ...set,
    workspaces: set.workspaces.map((workspace) => ({
      ...workspace,
      groups: workspace.groups.map((group) => {
        if (group.paneTree) return group;
        const ordered = [group.activeNodeId, ...group.nodeIds.filter((id) => id !== group.activeNodeId)];
        return { ...group, paneTree: treeFromLayout(group.layout, ordered) ?? undefined };
      }),
    })),
  };
}

const migrateWorkspaceSet = (set: WorkspaceSet): WorkspaceSet =>
  backfillPaneTrees(backfillSessionNumbers(workspacePresentation(set)));

export function createDefaultWorkspace(): ProjectWorkspace {
  const initialNode: SessionNode = {
    id: 'node-1',
    groupId: 'group-main',
    title: 'Terminal 1',
    // The first session in a fresh workspace always takes slot 1.
    number: 1,
    kind: 'terminal',
    cwd: '~',
    // Unknown until the daemon reports it — same rule as createWorkspaceForFolder.
    gitBranch: '',
    activeBlockId: null,
    isTuiActive: false,
    agentState: 'idle',
    tuiLines: [],
    commandHistory: [],
    createdAt: Date.now(),
  };

  const initialGroup: SessionGroup = {
    id: 'group-main',
    projectId: 'project-root',
    name: 'Main Workstream',
    layout: 'single',
    activeNodeId: 'node-1',
    nodeIds: ['node-1'],
    paneTree: paneLeaf('node-1'),
    createdAt: Date.now(),
  };

  return {
    id: 'project-root',
    // The home directory, not a path from the author's own machine. Anyone
    // else's first launch pointed at a folder that did not exist.
    name: 'HOME',
    rootPath: '~',
    groups: [initialGroup],
    nodes: {
      'node-1': initialNode,
    },
    activeGroupId: 'group-main',
  };
}

const RECENT_KEY = 'DOOM_TERM_RECENT_WORKSPACES_V1';

export function createWorkspaceForFolder(folderPath: string, customName?: string): ProjectWorkspace {
  const folderName = folderPath.replace(/\/+$/, '').split('/').pop() || 'Workspace';
  const name = customName || folderName.toUpperCase();
  const nodeId = uniqueId('node');
  const groupId = uniqueId('group');
  const projectId = uniqueId('project');

  const initialNode: SessionNode = {
    id: nodeId,
    groupId: groupId,
    title: 'Terminal 1',
    // The first session in a fresh workspace always takes slot 1.
    number: 1,
    kind: 'terminal',
    cwd: folderPath,
    // Unknown until the daemon reports it. A folder that is not a repository
    // has no branch, and claiming 'main' was how one still showed BRANCH: MAIN.
    gitBranch: '',
    activeBlockId: null,
    isTuiActive: false,
    agentState: 'idle',
    tuiLines: [],
    commandHistory: [],
    createdAt: Date.now(),
  };

  const initialGroup: SessionGroup = {
    id: groupId,
    projectId,
    name: 'Main Workstream',
    layout: 'single',
    activeNodeId: nodeId,
    nodeIds: [nodeId],
    paneTree: paneLeaf(nodeId),
    createdAt: Date.now(),
  };

  return {
    id: projectId,
    name,
    rootPath: folderPath,
    groups: [initialGroup],
    nodes: {
      [nodeId]: initialNode,
    },
    activeGroupId: groupId,
  };
}

const SET_STORAGE_KEY = 'DOOM_TERM_WORKSPACES_V2';

function singleton(ws: ProjectWorkspace): WorkspaceSet {
  return { workspaces: [ws], activeWorkspaceId: ws.id };
}

/**
 * The workspaces actually on disk, or null when there are none.
 *
 * Extracted from `loadWorkspaceSet` so the first-run gate can ask whether
 * anything was restored without a second parser to keep in step with this one.
 * A workspace this module synthesized is not a restore, and the difference is
 * the whole question the startup picker exists to ask.
 */
export function readStoredWorkspaceSet(): WorkspaceSet | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;

  try {
    const saved = window.localStorage.getItem(SET_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as WorkspaceSet;
      if (parsed.workspaces?.length) return migrateWorkspaceSet(parsed);
    }

    // Migrate a V1 single workspace rather than dropping the user's sessions.
    const legacy = window.localStorage.getItem(STORAGE_KEY);
    if (legacy) {
      const ws = JSON.parse(legacy) as ProjectWorkspace;
      if (ws.groups && ws.nodes && Object.keys(ws.nodes).length > 0) {
        return migrateWorkspaceSet(singleton(ws));
      }
    }
  } catch (e) {
    console.warn('⚡ Failed to restore Doom Term workspaces from storage, starting fresh:', e);
  }

  return null;
}

/** What a run with nothing on disk starts from: one synthesized workspace at HOME. */
export function defaultWorkspaceSet(): WorkspaceSet {
  return singleton(createDefaultWorkspace());
}

export class SessionStore {
  private static saveTimeout: number | null = null;

  public static loadWorkspaceSet(): WorkspaceSet {
    return readStoredWorkspaceSet() ?? defaultWorkspaceSet();
  }

  /**
   * Whether anything was actually restored from disk.
   *
   * False on a first run, and on one whose storage was cleared or corrupted:
   * exactly the cases where the workspace handed back above was synthesized
   * here rather than chosen by anyone. The startup picker asks this, and
   * nothing spawns until it is answered.
   */
  public static hasStoredWorkspaceSet(): boolean {
    return readStoredWorkspaceSet() !== null;
  }

  public static saveWorkspaceSet(set: WorkspaceSet) {
    if (typeof window === 'undefined' || !window.localStorage) return;

    if (this.saveTimeout) {
      window.clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(SET_STORAGE_KEY, JSON.stringify(workspacePresentation(set)));
        const active = set.workspaces.find((w) => w.id === set.activeWorkspaceId);
        if (active) this.addRecentWorkspace(active.rootPath, active.name);
      } catch (e) {
        console.warn('⚡ Error saving workspaces to storage:', e);
      }
    }, 400);
  }

  /** Only paths the user has actually opened. A clean machine has no recents. */
  public static loadRecentWorkspaces(): { name: string; path: string }[] {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    try {
      const saved = window.localStorage.getItem(RECENT_KEY);
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return [];
  }

  public static addRecentWorkspace(path: string, name?: string) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const current = this.loadRecentWorkspaces().filter((r) => r.path !== path);
      const folderName = path.replace(/\/+$/, '').split('/').pop() || 'Workspace';
      current.unshift({
        name: name || folderName.toUpperCase(),
        path,
      });
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(current.slice(0, 10)));
    } catch {
      // ignore
    }
  }
}
