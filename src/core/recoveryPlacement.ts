import type { SessionNode, WorkspaceSet } from '../types/sessionTree';
import type { RecoverableSession } from './sessionRecovery';
import { nextSessionNumber } from './sessionNumbers';
import { derivedSessionTitle } from './sessionNaming';
import { paneLeaf, replaceLeaf, splitLeaf } from './paneTree';
import { boundCachedLines } from './presentationCache';

/** Pure presentation transaction. A replacement never inherits an old cache
 * as its live screen; the old node keeps its name, slot and geometry under a
 * local-only id with its original process identity disclosed. */
export function placeRecoveredSession(
  set: WorkspaceSet, workspaceId: string, groupId: string, session: RecoverableSession,
  incarnation: string, snapshotId: string, now: number,
): WorkspaceSet {
  if (!set.workspaces.some(w => w.id === workspaceId && w.groups.some(g => g.id === groupId))
      || set.workspaces.some(w => w.nodes[snapshotId])) return set;
  const matches = set.workspaces.filter(w => w.nodes[session.id]);
  if (matches.length > 1 || matches.some(w => w.nodes[session.id].incarnation === incarnation)) return set;
  const number = nextSessionNumber(set.workspaces.flatMap(w => Object.values(w.nodes))
    .map(node => node.number).filter((slot): slot is number => slot !== null));
  const recovered: SessionNode = {
    id: session.id, incarnation, groupId, number, kind: 'terminal',
    title: derivedSessionTitle(session.cwd || '~', ''), cwd: session.cwd || '~', gitBranch: '',
    activeBlockId: null, isTuiActive: false, agentState: 'unknown', tuiLines: [], commandHistory: [],
    createdAt: now, lastUsedAt: now,
  };
  return { ...set, workspaces: set.workspaces.map(workspace => {
    const old = workspace.nodes[session.id];
    if (!old && workspace.id !== workspaceId) return workspace;
    const nodes = { ...workspace.nodes };
    if (old) {
      const cache = boundCachedLines(old.tuiLines);
      delete nodes[session.id];
      nodes[snapshotId] = { ...old, id: snapshotId, snapshotOf: { sessionId: old.id, incarnation: old.incarnation },
        tuiLines: cache.lines, cacheTruncated: old.cacheTruncated === true || cache.truncated,
        agentState: 'unknown', foregroundAgent: null, isTuiActive: false, atPrompt: false, blockedOnUser: false,
        lastExitCode: undefined, executionSerial: undefined, attentionSerial: undefined,
        lastExecutionStartedAt: undefined, lastExecutionDurationMs: undefined,
        lastLiveExecutionEventId: undefined, lastHookEventId: undefined, lastLiveAskEventId: undefined,
      };
    }
    if (workspace.id === workspaceId) nodes[session.id] = recovered;
    const groups = workspace.groups.map(original => {
      const group = old ? { ...original,
        nodeIds: original.nodeIds.map(id => id === old.id ? snapshotId : id),
        activeNodeId: original.activeNodeId === old.id ? snapshotId : original.activeNodeId,
        paneTree: original.paneTree ? replaceLeaf(original.paneTree, old.id, snapshotId) : undefined,
        zoomedSessionId: original.zoomedSessionId === old.id ? snapshotId : original.zoomedSessionId,
      } : original;
      if (workspace.id !== workspaceId || group.id !== groupId) return group;
      const base = group.paneTree ?? paneLeaf(group.activeNodeId);
      return { ...group, activeNodeId: session.id, nodeIds: [...group.nodeIds, session.id], zoomedSessionId: undefined,
        paneTree: splitLeaf(base, group.activeNodeId, session.id, 'row') };
    });
    return { ...workspace, nodes, groups,
      activeGroupId: workspace.id === workspaceId ? groupId : workspace.activeGroupId };
  }) };
}
