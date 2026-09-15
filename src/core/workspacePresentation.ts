import type { PaneTree, SessionNode, WorkspaceSet } from '../types/sessionTree';
import { boundCachedLines } from './presentationCache';
import { knownIncarnation } from './sessionRecovery';

function presentationTree(tree: PaneTree | undefined, depth = 0): PaneTree | undefined {
  if (!tree || depth > 64) return undefined;
  if (tree.type === 'leaf') return { type: 'leaf', id: tree.id, sessionId: tree.sessionId };
  if (tree.type !== 'split') return undefined;
  const first = presentationTree(tree.first, depth + 1);
  const second = presentationTree(tree.second, depth + 1);
  if (!first || !second) return undefined;
  return { type: 'split', id: tree.id, direction: tree.direction, ratio: tree.ratio, first, second };
}

function presentationNode(node: SessionNode): SessionNode {
  const cache = boundCachedLines(node.tuiLines);
  const snapshot = node.snapshotOf;
  return {
    id: node.id, groupId: node.groupId, title: node.title, titleLocked: node.titleLocked,
    number: node.number, kind: node.kind, cwd: node.cwd, gitBranch: node.gitBranch,
    ...(knownIncarnation(node.incarnation) ? { incarnation: node.incarnation } : {}),
    ...(snapshot && typeof snapshot.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(snapshot.sessionId)
      ? { snapshotOf: { sessionId: snapshot.sessionId,
        ...(knownIncarnation(snapshot.incarnation) ? { incarnation: snapshot.incarnation } : {}) } } : {}),
    activeBlockId: null, isTuiActive: false, agentState: 'unknown',
    tuiLines: cache.lines, cacheTruncated: node.cacheTruncated === true || cache.truncated,
    commandHistory: Array.isArray(node.commandHistory) ? node.commandHistory.filter(command => typeof command === 'string') : [],
    scratchpadContent: typeof node.scratchpadContent === 'string' ? node.scratchpadContent : undefined,
    parked: node.parked, lastUsedAt: node.lastUsedAt, createdAt: node.createdAt,
  };
}

/** Both write and migration cross the same whitelist. The V2 workspace key
 * remains compatible; no stored object is an emulator checkpoint, a live
 * telemetry observation, a mutation queue, or an attachment capability. */
export function workspacePresentation(set: WorkspaceSet): WorkspaceSet {
  return { activeWorkspaceId: set.activeWorkspaceId, workspaces: set.workspaces.map(workspace => ({
    id: workspace.id, name: workspace.name, rootPath: workspace.rootPath,
    gitRemote: workspace.gitRemote, activeGroupId: workspace.activeGroupId,
    groups: workspace.groups.map(group => ({
      id: group.id, projectId: group.projectId, name: group.name, layout: group.layout,
      activeNodeId: group.activeNodeId, nodeIds: [...group.nodeIds], createdAt: group.createdAt,
      paneTree: presentationTree(group.paneTree), zoomedSessionId: group.zoomedSessionId,
    })),
    nodes: Object.fromEntries(Object.entries(workspace.nodes).map(([id, node]) => [id, presentationNode(node)])),
  })) };
}
