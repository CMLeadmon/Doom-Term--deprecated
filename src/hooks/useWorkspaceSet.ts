import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PaneDirection, PaneTree, ProjectWorkspace, SessionNode, SplitLayoutMode, WorkspaceSet,
} from '../types/sessionTree';
import {
  SessionStore, createWorkspaceForFolder, defaultWorkspaceSet, readStoredWorkspaceSet,
} from '../core/sessionStore';
import {
  activeWorkspace, adoptWorkspace, closeWorkspace, openWorkspace, replaceWorkspace,
} from '../core/workspaceSet';
import { nextSessionTitle, derivedSessionTitle } from '../core/sessionNaming';
import { nextSessionNumber } from '../core/sessionNumbers';
import { uniqueId } from '../core/ids';
import { disposeEmulator, BOOTSTRAP_COLS, BOOTSTRAP_ROWS } from '../core/emulatorRegistry';
import { disposeActivity } from '../core/activityMonitor';
import { attentionQueue } from '../core/attentionQueue';
import { ptyClient, type ArtifactRecord } from '../core/ptyClient';
import { audioEngine } from '../core/audioEngine';
import { equalizeTree, paneLeaf, removeLeaf, splitLeaf, treeForSelection, treeFromLayout } from '../core/paneTree';

/**
 * All open project folders, the one in focus, and everything that mutates
 * them.
 *
 * `setWorkspace` edits whichever workspace has focus and leaves the rest of
 * the set alone, so callers written against a single workspace keep working.
 */
export function useWorkspaceSet() {
  /**
   * One read of storage at mount, so what is shown and whether any of it was
   * restored cannot disagree.
   */
  const [boot] = useState(() => {
    const stored = readStoredWorkspaceSet();
    return { set: stored ?? defaultWorkspaceSet(), restored: stored !== null };
  });
  const [workspaceSet, setWorkspaceSet] = useState<WorkspaceSet>(boot.set);
  /**
   * Whether the user still has to say where the first terminal opens.
   *
   * Only a run with nothing on disk asks: a restored workspace was chosen once
   * already. While this is true nothing is spawned and nothing is written to
   * storage, so quitting at the picker leaves the next launch just as fresh.
   */
  const [needsWorkspaceChoice, setNeedsWorkspaceChoice] = useState(!boot.restored);
  const workspace = useMemo(() => activeWorkspace(workspaceSet), [workspaceSet]);
  const workspaceSetRef = useRef(workspaceSet);
  workspaceSetRef.current = workspaceSet;
  const pendingClosures = useRef(new Set<string>());

  const setWorkspace = useCallback(
    (updater: (prev: ProjectWorkspace) => ProjectWorkspace) => {
      setWorkspaceSet((prevSet) => replaceWorkspace(prevSet, updater(activeWorkspace(prevSet))));
    },
    []
  );

  // Event routing needs the complete node set: a directory fallback must
  // remain ambiguous even if matching sessions live in different workspaces.
  const setEventWorkspace = useCallback((updater: (prev: ProjectWorkspace) => ProjectWorkspace) => {
    setWorkspaceSet((previous) => {
      const nodes = Object.assign({}, ...previous.workspaces.map((w) => w.nodes)) as Record<string, SessionNode>;
      const combined = { ...activeWorkspace(previous), nodes };
      const updated = updater(combined);
      if (updated === combined) return previous;
      let changed = false;
      const workspaces = previous.workspaces.map((w) => {
        const ids = Object.keys(w.nodes);
        if (ids.every((id) => updated.nodes[id] === w.nodes[id])) return w;
        changed = true;
        return { ...w, nodes: Object.fromEntries(ids.map((id) => [id, updated.nodes[id]])) };
      });
      return changed ? { ...previous, workspaces } : previous;
    });
  }, []);

  const activeGroup = useMemo(
    () => workspace.groups.find((g) => g.id === workspace.activeGroupId) || workspace.groups[0],
    [workspace]
  );

  const activeNode = useMemo(
    () => workspace.nodes[activeGroup.activeNodeId] || Object.values(workspace.nodes)[0],
    [workspace, activeGroup]
  );

  useEffect(() => {
    // Nothing has been chosen yet, so there is nothing to remember. Writing the
    // placeholder would make the next launch look like a restore.
    if (needsWorkspaceChoice) return;
    SessionStore.saveWorkspaceSet(workspaceSet);
  }, [workspaceSet, needsWorkspaceChoice]);

  useEffect(() => ptyClient.onIncarnation((id, incarnation) => {
    setEventWorkspace(previous => {
      const node = previous.nodes[id];
      if (!node || node.incarnation === incarnation) return previous;
      return { ...previous, nodes: { ...previous.nodes, [id]: { ...node, incarnation } } };
    });
  }), [setEventWorkspace]);

  useEffect(() => {
    if (needsWorkspaceChoice) return;
    for (const candidate of workspaceSet.workspaces) {
      for (const node of Object.values(candidate.nodes)) {
        if (node.kind !== 'scratchpad' && node.kind !== 'artifact') {
          ptyClient.ensureSession(node.id, node.cwd, node.incarnation);
        }
      }
    }
  }, [workspaceSet, needsWorkspaceChoice]);

  const handleCreateNode = (
    groupId: string,
    kind: SessionNode['kind'] = 'terminal',
    splitDirection?: PaneDirection,
  ) => {
    const newNodeId = uniqueId('node');
    const group = workspace.groups.find((g) => g.id === groupId) || activeGroup;
    const source = workspace.nodes[group.activeNodeId];
    // The target group's own directory remains authoritative while telemetry
    // is delayed or belongs to a pane we just left.
    const cwd = source?.cwd || workspace.rootPath || '~';
    const branch = source?.gitBranch ?? '';
    // A terminal is identified by where it is; a scratchpad has no location to
    // be identified by, so it keeps the counted title.
    const title =
      kind === 'scratchpad' || kind === 'artifact'
        ? nextSessionTitle(kind, Object.values(workspace.nodes).map((n) => n.title))
        : derivedSessionTitle(cwd, branch);

    const newNode: SessionNode = {
      id: newNodeId,
      groupId: group.id,
      title,
      // Lowest free slot across all workspaces, so closing 2 and opening
      // another gives you 2 again rather than drifting out of Ctrl+N's reach.
      number: nextSessionNumber(
        workspaceSet.workspaces.flatMap(w => Object.values(w.nodes))
          .map((n) => n.number)
          .filter((n): n is number => n !== null),
      ),
      kind,
      cwd,
      // No branch until the daemon reports one for this directory.
      gitBranch: branch,
      activeBlockId: null,
      isTuiActive: false,
      agentState: 'idle',
      tuiLines: [],
      commandHistory: [],
      scratchpadContent: kind === 'scratchpad' ? '' : undefined,
      artifactId: kind === 'artifact' ? newNodeId : undefined,
      artifactTitle: kind === 'artifact' ? title : undefined,
      artifactType: kind === 'artifact' ? 'markdown' : undefined,
      artifactContent: kind === 'artifact' ? '# New Artifact\n\n' : undefined,
      artifactVersion: kind === 'artifact' ? 1 : undefined,
      artifactUpdatedAt: kind === 'artifact' ? Date.now() : undefined,
      createdAt: Date.now(),
    };

    setWorkspace((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => {
        if (g.id !== group.id) return g;
        const baseTree = g.paneTree
          ?? treeFromLayout(g.layout, [g.activeNodeId, ...g.nodeIds.filter((id) => id !== g.activeNodeId)]);
        const paneTree = splitDirection && baseTree
          ? splitLeaf(baseTree, g.activeNodeId, newNodeId, splitDirection)
          : g.paneTree
            ? treeForSelection(g.layout, g.paneTree, g.activeNodeId, newNodeId)
            : undefined;
        return {
          ...g,
          activeNodeId: newNodeId,
          nodeIds: [...g.nodeIds, newNodeId],
          paneTree,
        };
      }),
      nodes: {
        ...prev.nodes,
        [newNodeId]: newNode,
      },
    }));

    if (kind === 'terminal' || kind === 'agent') {
      ptyClient.setActiveSession(newNodeId);
      ptyClient.spawnSession(newNodeId, BOOTSTRAP_COLS, BOOTSTRAP_ROWS, newNode.cwd);
    }
    return newNodeId;
  };

  const handleRenameNode = (nodeId: string, newTitle: string) => {
    setWorkspace((prev) => {
      const node = prev.nodes[nodeId];
      if (!node) return prev;
      return {
        ...prev,
        nodes: {
          ...prev.nodes,
          [nodeId]: {
            ...node,
            title: newTitle,
            // Yours now. Derivation must never take it back.
            titleLocked: true,
          },
        },
      };
    });
    audioEngine.playSound('click', 3);
  };

  // Opening a folder adds a workspace. It used to replace the whole state,
  // which discarded the previous folder's sessions and scrollback outright.
  const handleOpenWorkspaceFolder = (folderPath: string, name?: string) => {
    const opened = createWorkspaceForFolder(folderPath, name);
    // App's binding effect owns I/O after selection commits. React may run a
    // state updater twice; spawning inside one leaks invisible sessions.
    setWorkspaceSet((prev) => openWorkspace(prev, opened));
    audioEngine.playSound('door', 2);
  };

  /**
   * The folder picked at startup becomes the workspace.
   *
   * It replaces the placeholder rather than opening beside it. Binding is left
   * to the effect in App that binds whatever is on screen: one path to the
   * daemon, so there is one place where a session can be started.
   */
  const chooseStartupWorkspace = (folderPath: string, name?: string) => {
    setWorkspaceSet(adoptWorkspace(createWorkspaceForFolder(folderPath, name)));
    setNeedsWorkspaceChoice(false);
    audioEngine.playSound('door', 2);
  };

  /** Esc at the picker: keep the HOME placeholder and open it, as before. */
  const dismissStartupChoice = () => setNeedsWorkspaceChoice(false);

  const handleSelectWorkspace = (id: string) => {
    setWorkspaceSet((prev) => prev.workspaces.some(w => w.id === id)
      ? { ...prev, activeWorkspaceId: id }
      : prev);
  };

  const cachedOnly = (node: SessionNode): boolean => {
    const status = ptyClient.getAttachmentState(node.id)?.status;
    return node.kind === 'scratchpad' || node.kind === 'artifact' || status === 'closed' || status === 'missing' || status === 'replaced';
  };

  const handleCloseWorkspace = async (id: string) => {
    const current = workspaceSetRef.current;
    if (current.workspaces.length <= 1) return;
    const closing = current.workspaces.find(candidate => candidate.id === id);
    if (!closing) return;
    const nodes = Object.values(closing.nodes);
    if (nodes.some(node => pendingClosures.current.has(node.id))) return;
    nodes.forEach(node => pendingClosures.current.add(node.id));
    try {
      const results = await Promise.all(nodes.map(node => cachedOnly(node) ? true : ptyClient.killSession(node.id)));
      if (results.some(result => !result)) return; // Preserve every uncertain cache.
      const latest = workspaceSetRef.current;
      const target = latest.workspaces.find(candidate => candidate.id === id);
      if (!target || latest.workspaces.length <= 1 || Object.keys(target.nodes).length !== nodes.length
          || nodes.some(node => !target.nodes[node.id] || target.nodes[node.id].incarnation !== node.incarnation)) return;
      nodes.forEach(node => {
        ptyClient.forgetSession(node.id); disposeEmulator(node.id);
        disposeActivity(node.id); attentionQueue.dispose(node.id);
      });
      setWorkspaceSet(previous => closeWorkspace(previous, id));
    } finally { nodes.forEach(node => pendingClosures.current.delete(node.id)); }
  };

  const handleSelectNode = (nodeId: string, groupId?: string) => {
    const owner = workspaceSetRef.current.workspaces.find(w => w.nodes[nodeId]);
    if (!owner) return;
    const targetGroupId = owner.nodes[nodeId].groupId;
    if (groupId && groupId !== targetGroupId) return;
    const lastUsedAt = Date.now();
    setWorkspaceSet((previous) => {
      const prev = previous.workspaces.find(w => w.id === owner.id);
      if (!prev?.nodes[nodeId]) return previous;
      const updated = {
        ...prev,
        activeGroupId: targetGroupId,
        groups: prev.groups.map((g) => {
          if (g.id !== targetGroupId) return g;
          return {
            ...g,
            activeNodeId: nodeId,
            nodeIds: g.nodeIds.includes(nodeId) ? g.nodeIds : [...g.nodeIds, nodeId],
            // A group's owned sessions are not necessarily on screen.
            paneTree: treeForSelection(g.layout, g.paneTree, g.activeNodeId, nodeId),
            zoomedSessionId: g.zoomedSessionId ? nodeId : undefined,
          };
        }),
        nodes: {
          ...prev.nodes,
          [nodeId]: { ...prev.nodes[nodeId], parked: false, lastUsedAt },
        },
      };
      return { ...replaceWorkspace(previous, updated), activeWorkspaceId: owner.id };
    });
    ptyClient.setActiveSession(nodeId);
  };

  /** Restoring is selecting: it re-enters geometry and takes keyboard focus. */
  const handleRestoreNode = (nodeId: string) => handleSelectNode(nodeId);

  const handleSetGroupLayout = (groupId: string, layout: SplitLayoutMode) => {
    setWorkspace((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => g.id === groupId
        ? {
            ...g,
            layout,
            paneTree: treeFromLayout(
              layout,
              [g.activeNodeId, ...g.nodeIds.filter((id) => id !== g.activeNodeId)],
            ) ?? undefined,
          }
        : g),
    }));
    audioEngine.playSound('click', 3);
  };

  const handleSetPaneTree = (groupId: string, paneTree: PaneTree) => {
    setWorkspace((prev) => ({
      ...prev,
      groups: prev.groups.map((group) => group.id === groupId ? { ...group, paneTree } : group),
    }));
  };

  const handleEqualizePanes = (groupId: string) => {
    setWorkspace((prev) => ({
      ...prev,
      groups: prev.groups.map((group) => group.id === groupId && group.paneTree
        ? { ...group, paneTree: equalizeTree(group.paneTree) }
        : group),
    }));
  };

  const handleTogglePaneZoom = (groupId: string, sessionId: string) => {
    setWorkspace((prev) => ({
      ...prev,
      groups: prev.groups.map((group) => group.id === groupId
        ? {
            ...group,
            zoomedSessionId: group.zoomedSessionId === sessionId ? undefined : sessionId,
          }
        : group),
    }));
  };

  const handleParkNode = (nodeId: string) => {
    const node = workspace.nodes[nodeId];
    const group = workspace.groups.find((candidate) => candidate.id === node?.groupId);
    if (!node || !group) return;
    const sibling = group.nodeIds.find((id) => id !== nodeId);
    const fallback = sibling ?? handleCreateNode(group.id, 'terminal');

    setWorkspace((prev) => ({
      ...prev,
      groups: prev.groups.map((candidate) => {
        if (candidate.id !== group.id) return candidate;
        return {
          ...candidate,
          nodeIds: candidate.nodeIds.filter((id) => id !== nodeId),
          activeNodeId: candidate.activeNodeId === nodeId ? fallback : candidate.activeNodeId,
          paneTree: candidate.paneTree
            ? removeLeaf(candidate.paneTree, nodeId) ?? paneLeaf(fallback)
            : paneLeaf(fallback),
          zoomedSessionId: candidate.zoomedSessionId === nodeId
            ? undefined
            : candidate.zoomedSessionId,
        };
      }),
      nodes: {
        ...prev.nodes,
        [nodeId]: { ...prev.nodes[nodeId], parked: true },
      },
    }));
    ptyClient.setActiveSession(fallback);
  };

  const handleKillNode = async (nodeId: string) => {
    const owner = workspaceSetRef.current.workspaces.find(candidate => candidate.nodes[nodeId]);
    const original = owner?.nodes[nodeId];
    if (!owner || !original || pendingClosures.current.has(nodeId)) return;
    pendingClosures.current.add(nodeId);
    try {
      if (!cachedOnly(original) && !await ptyClient.killSession(nodeId)) return;
      const latest = workspaceSetRef.current.workspaces.find(candidate => candidate.id === owner.id)?.nodes[nodeId];
      if (!latest || latest.incarnation !== original.incarnation) return;
      // No optimistic cache deletion, replacement spawn or active-workspace
      // mutation while the correlated lifecycle result is still unknown.
      ptyClient.forgetSession(nodeId);
      disposeEmulator(nodeId); disposeActivity(nodeId); attentionQueue.dispose(nodeId);
      const replacementId = uniqueId('node');
      const replacementCreatedAt = Date.now();
      setWorkspaceSet(previous => {
        const workspace = previous.workspaces.find(candidate => candidate.id === owner.id);
        const node = workspace?.nodes[nodeId];
        if (!workspace || !node || node.incarnation !== original.incarnation) return previous;
        const group = workspace.groups.find(candidate => candidate.id === node.groupId);
        const needsReplacement = !!group?.nodeIds.includes(nodeId) && group.nodeIds.length === 1;
        const nodes = { ...workspace.nodes }; delete nodes[nodeId];
        if (needsReplacement) {
          nodes[replacementId] = {
            id: replacementId, groupId: node.groupId, title: derivedSessionTitle(node.cwd, ''),
            number: nextSessionNumber(previous.workspaces.flatMap(candidate => Object.values(candidate.nodes))
              .filter(candidate => candidate.id !== nodeId).map(candidate => candidate.number).filter((number): number is number => number !== null)),
            kind: 'terminal', cwd: node.cwd, gitBranch: '', activeBlockId: null,
            isTuiActive: false, agentState: 'unknown', tuiLines: [], commandHistory: [], createdAt: replacementCreatedAt,
          };
        }
        const groups = workspace.groups.map(candidate => {
          const ids = candidate.nodeIds.filter(id => id !== nodeId);
          if (needsReplacement && candidate.id === node.groupId) ids.push(replacementId);
          return {
            ...candidate, nodeIds: ids,
            activeNodeId: candidate.activeNodeId === nodeId ? ids[0] ?? '' : candidate.activeNodeId,
            paneTree: needsReplacement && candidate.id === node.groupId ? paneLeaf(replacementId)
              : candidate.paneTree ? removeLeaf(candidate.paneTree, nodeId) ?? undefined : undefined,
            zoomedSessionId: candidate.zoomedSessionId === nodeId ? undefined : candidate.zoomedSessionId,
          };
        }).filter(candidate => candidate.nodeIds.length > 0);
        return replaceWorkspace(previous, {
          ...workspace, nodes, groups,
          activeGroupId: groups.some(candidate => candidate.id === workspace.activeGroupId) ? workspace.activeGroupId : groups[0]?.id ?? '',
        });
      });
    } finally { pendingClosures.current.delete(nodeId); }
  };

  const openOrUpdateArtifact = useCallback((artifact: ArtifactRecord, openPane = true) => {
    setWorkspace((prev) => {
      const existingEntry = Object.entries(prev.nodes).find(
        ([_, n]) => n.kind === 'artifact' && (n.artifactId === artifact.id || n.id === artifact.id),
      );

      if (existingEntry) {
        const [nodeId, existingNode] = existingEntry;
        return {
          ...prev,
          nodes: {
            ...prev.nodes,
            [nodeId]: {
              ...existingNode,
              artifactTitle: artifact.title,
              artifactType: artifact.type,
              artifactContent: artifact.content,
              artifactVersion: artifact.version,
              artifactUpdatedAt: artifact.updated_at,
            },
          },
        };
      }

      if (!openPane) {
        return prev;
      }

      const newNodeId = uniqueId('node');
      const activeGroup = prev.groups.find((g) => g.id === prev.activeGroupId) || prev.groups[0];
      const source = prev.nodes[activeGroup?.activeNodeId];
      const cwd = source?.cwd || prev.rootPath || '~';

      const newNode: SessionNode = {
        id: newNodeId,
        groupId: activeGroup.id,
        title: `❖ ${artifact.title}`,
        number: nextSessionNumber(
          workspaceSetRef.current.workspaces
            .flatMap((w) => Object.values(w.nodes))
            .map((n) => n.number)
            .filter((n): n is number => n !== null),
        ),
        kind: 'artifact',
        cwd,
        gitBranch: '',
        activeBlockId: null,
        isTuiActive: false,
        agentState: 'idle',
        tuiLines: [],
        commandHistory: [],
        artifactId: artifact.id,
        artifactTitle: artifact.title,
        artifactType: artifact.type,
        artifactContent: artifact.content,
        artifactVersion: artifact.version,
        artifactUpdatedAt: artifact.updated_at,
        createdAt: Date.now(),
      };

      const baseTree =
        activeGroup.paneTree ??
        treeFromLayout(activeGroup.layout, [
          activeGroup.activeNodeId,
          ...activeGroup.nodeIds.filter((id) => id !== activeGroup.activeNodeId),
        ]);
      const paneTree = baseTree
        ? splitLeaf(baseTree, activeGroup.activeNodeId, newNodeId, 'column')
        : undefined;

      return {
        ...prev,
        groups: prev.groups.map((g) => {
          if (g.id !== activeGroup.id) return g;
          return {
            ...g,
            nodeIds: [...g.nodeIds, newNodeId],
            activeNodeId: newNodeId,
            paneTree,
          };
        }),
        nodes: {
          ...prev.nodes,
          [newNodeId]: newNode,
        },
      };
    });
  }, []);

  return {
    workspaceSet,
    workspace,
    setWorkspace,
    setEventWorkspace,
    activeGroup,
    activeNode,
    handleCreateNode,
    handleRenameNode,
    handleOpenWorkspaceFolder,
    needsWorkspaceChoice,
    chooseStartupWorkspace,
    dismissStartupChoice,
    handleSelectWorkspace,
    handleCloseWorkspace,
    handleSelectNode,
    handleRestoreNode,
    handleSetGroupLayout,
    handleSetPaneTree,
    handleEqualizePanes,
    handleTogglePaneZoom,
    handleParkNode,
    handleKillNode,
    openOrUpdateArtifact,
  };
}
