import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { SessionNode } from './types/sessionTree';
import { ptyClient } from './core/ptyClient';
import { audioEngine } from './core/audioEngine';
import { RawTerminalView } from './components/RawTerminalView';
import { StatusPlate } from './components/StatusPlate';
import { SplitPaneGrid } from './components/SplitPaneGrid';
import { SessionModeNotice } from './components/SessionModeNotice';
import { CommandPalette, type CommandPaletteAction } from './components/CommandPalette';
import { Scratchpad } from './components/Scratchpad';
import { WorkspaceModal } from './components/WorkspaceModal';
import { isWorking, lastOutputAt } from './core/activityMonitor';
import { buildWaitingList } from './core/waitingList';
import { attentionQueue } from './core/attentionQueue';
import { stateOf as scrollbackOf } from './core/scrollback';
import { usePtyEvents } from './hooks/usePtyEvents';
import { useWorkspaceSet } from './hooks/useWorkspaceSet';
import { useGlobalKeys } from './hooks/useGlobalKeys';
import { buildPaletteActions } from './core/paletteActions';
import { useSessionNotifications, enableSessionNotifications } from './hooks/useSessionNotifications';
import { type AppTelemetry } from './hud/state';
import { adjacentPane } from './core/paneTree';
import { PaneSelectOverlay } from './components/PaneSelectOverlay';
import { closeDisposition } from './core/sessionClose';
import { CloseSessionPrompt } from './components/CloseSessionPrompt';
import { SessionSnapshotNotice } from './components/SessionSnapshotNotice';
import { AgentQueueIndicator } from './components/AgentQueueIndicator';
import { PermissionModeModal, type PermissionMode } from './components/PermissionModeModal';
import { RenameSessionModal } from './components/RenameSessionModal';
import { DaemonAuthModal } from './components/DaemonAuthModal';
import type { ViewAction, ViewActionRequest } from './core/keymap';

/** A stable empty list, so a closed palette does not hand out a new array. */
const EMPTY_ACTIONS: CommandPaletteAction[] = [];

const isSessionFailed = (n: SessionNode) =>
  n.agentState === 'errored' || (n.lastExitCode != null && n.lastExitCode !== 0);

export const App: React.FC = () => {
  const [authMessage, setAuthMessage] = useState(ptyClient.getAuthMessage());
  useEffect(() => ptyClient.onAuthChange(setAuthMessage), []);
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState<boolean>(false);

  // Nothing here is claimed until the daemon reports it. contextUsed, rateUsed
  // and tokens stay absent because no agent CLI reports them to the terminal.
  const [telemetry, setTelemetry] = useState<AppTelemetry>({
    agent: 'shell',
    chips: [false, false, false],
  });

  const {
    workspaceSet,
    workspace,
    setWorkspace,
    setEventWorkspace,
    activeGroup,
    activeNode,
    recoveryState,
    bindingFor,
    handleReviveNode,
    handleCreateNode,
    handleRenameNode,
    handleOpenWorkspaceFolder,
    needsWorkspaceChoice,
    chooseStartupWorkspace,
    dismissStartupChoice,
    handleSelectNode,
    handleSetGroupLayout,
    handleSetPaneTree,
    handleEqualizePanes,
    handleTogglePaneZoom,
    handleParkNode,
    handleKillNode,
    handleRecoverSession,
  } = useWorkspaceSet();
  // Selection commits before the next daemon poll. Do not lend the old pane's
  // context, quota, model, or environment to the new one during that gap.
  const visibleTelemetry: AppTelemetry = telemetry.sessionId === activeNode?.id
    ? telemetry
    : {
      ...telemetry,
      cwd: activeNode?.cwd,
      branch: activeNode?.gitBranch,
      agent: activeNode?.foregroundAgent ?? 'shell',
      agentName: undefined,
      model: undefined,
      contextUsed: undefined,
      rateUsed: undefined,
      tokens: undefined,
      isolation: undefined,
      agentBusy: activeNode ? isWorking(activeNode.id) : false,
    };
  const workspaceNodes = useMemo(
    () => workspaceSet.workspaces.flatMap(w => Object.values(w.nodes)),
    [workspaceSet.workspaces],
  );
  const workspaceNames = useMemo(
    () => Object.fromEntries(workspaceSet.workspaces.flatMap(w => Object.keys(w.nodes).map(id => [id, w.name]))),
    [workspaceSet.workspaces],
  );

  // Modals & Panels
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [isPaneSelectorOpen, setIsPaneSelectorOpen] = useState(false);
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(audioEngine.isMuted());
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('doom-term-notifications-enabled') !== 'false';
    } catch {
      return true;
    }
  });
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [dismissedAsks, setDismissedAsks] = useState<Set<string>>(new Set());
  const [notificationPermission, setNotificationPermission] = useState(() =>
    ptyClient.getIsTauri() ? 'granted' : typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  useEffect(() => {
    if (!toastMessage) return;
    const t = window.setTimeout(() => setToastMessage(null), 2500);
    return () => window.clearTimeout(t);
  }, [toastMessage]);

  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    try {
      // A saved preference is not permission to press Enter in a future
      // process. Hooks report waiting, not a verifiable approval contract.
      return localStorage.getItem('doom-term-permission-mode') === 'auto' ? 'auto' : 'manual';
    } catch {
      return 'manual';
    }
  });
  const [isPermissionModalOpen, setIsPermissionModalOpen] = useState(false);
  const nextViewActionId = useRef(0);
  const [viewActionRequest, setViewActionRequest] = useState<ViewActionRequest | null>(null);
  const [renameModalState, setRenameModalState] = useState<{
    isOpen: boolean;
    nodeId: string;
    title: string;
    sessionNumber?: number | null;
  }>({ isOpen: false, nodeId: '', title: '' });

  const activeViewSessionId = activeNode?.kind === 'scratchpad' ? null : activeNode?.id ?? null;
  const requestViewAction = useCallback((action: ViewAction) => {
    // A cached snapshot has no terminal view to acknowledge this request. If
    // it were queued anyway, reviving the session later would replay an old
    // palette action against the newly started shell.
    if (!activeViewSessionId || bindingFor(activeViewSessionId) !== 'ready') return;
    nextViewActionId.current += 1;
    setViewActionRequest({
      id: nextViewActionId.current,
      sessionId: activeViewSessionId,
      action,
    });
  }, [activeViewSessionId, bindingFor]);
  const handleViewActionHandled = useCallback((requestId: number) => {
    setViewActionRequest((current) => current?.id === requestId ? null : current);
  }, []);

  const handleSetPermissionMode = (mode: PermissionMode) => {
    if (mode === 'yolo') return;
    setPermissionMode(mode);
    try {
      localStorage.setItem('doom-term-permission-mode', mode);
    } catch {}
    setToastMessage(mode === 'auto' ? 'PERMISSION REVIEW BANNER: ON' : 'PERMISSION REVIEW: IN TERMINAL');
  };

  const handleToggleAudio = () => {
    const muted = audioEngine.toggleMute();
    setIsMuted(muted);
    if (!muted) audioEngine.playSound('pickup', 2);
    setToastMessage(muted ? 'SOUND FX: MUTED' : 'SOUND FX: ACTIVE');
  };

  const handleToggleNotifications = async () => {
    // Computed and persisted out here, never inside the updater: React calls
    // updaters twice under StrictMode, so a toast or a localStorage write in
    // there fires twice and is not what the returned state says it is.
    const next = !(notificationsEnabled && notificationPermission === 'granted');
    if (next) {
      const permission = ptyClient.getIsTauri() ? 'granted' : await enableSessionNotifications();
      setNotificationPermission(permission);
      if (permission !== 'granted') {
        setToastMessage(`NOTIFICATIONS: ${permission.toUpperCase()}`);
        return;
      }
    }
    setNotificationsEnabled(next);
    try {
      localStorage.setItem('doom-term-notifications-enabled', String(next));
    } catch {}
    setToastMessage(next ? 'NOTIFICATIONS: ENABLED' : 'NOTIFICATIONS: DISABLED');
  };

  const handleInspectSystemAlert = () => {
    const failedNode = workspaceNodes.find(isSessionFailed);
    if (failedNode) {
      handleSelectNode(failedNode.id);
      audioEngine.playSound('oof', 2);
      setToastMessage(`JUMPED TO FAILED SESSION #${failedNode.number ?? '?'}`);
    } else if (!ptyClient.getIsConnected()) {
      ptyClient.connect();
      setToastMessage('RECONNECTING TO PTY DAEMON...');
    } else {
      setToastMessage('SYSTEM HEALTH: ALL SERVICES OPERATIONAL');
    }
  };

  // One chip, one action. chipAtPoint() returns 0 | 1 | 2 and the plate's own
  // hover text promises all three, so every index a click can produce has a
  // branch here and no branch does a second chip's job.
  const handleSelectChip = (chipIndex: number) => {
    if (chipIndex === 0) handleToggleAudio();
    else if (chipIndex === 1) handleToggleNotifications();
    else if (chipIndex === 2) handleInspectSystemAlert();
  };

  const handleCreateWorktreeSession = async (branchName: string) => {
    const result = await ptyClient.createWorktree(activeNode?.cwd ?? workspace.rootPath, branchName);
    handleOpenWorkspaceFolder(result.path, result.branch);
    setToastMessage(`WORKTREE CREATED: ${result.branch}`);
  };

  const anyModalOpen =
    authMessage !== null ||
    isPaletteOpen ||
    isWorkspaceModalOpen ||
    needsWorkspaceChoice ||
    isPaneSelectorOpen ||
    isPermissionModalOpen ||
    renameModalState.isOpen ||
    pendingCloseId !== null;

  useEffect(() => {
    if (anyModalOpen || !activeNode) return;
    const frame = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-pane="${activeNode.id}"] [data-testid="raw-terminal"]`)
        ?? document.querySelector<HTMLElement>('[data-testid="raw-terminal"]');
      if (el && !el.contains(document.activeElement)) {
        el.focus({ preventScroll: true });
      }
    });
    // A modal can open before the next frame. Cancel the pending transfer so
    // the surface that just appeared remains the final keyboard owner.
    return () => cancelAnimationFrame(frame);
  }, [anyModalOpen, activeNode?.id]);

  usePtyEvents(setEventWorkspace, setTelemetry);

  useEffect(() => ptyClient.registerHandler({
    onOutput: () => undefined,
    onInputRefused: (_id, reason) => setToastMessage(reason),
  }), []);

  // Focus is not attachment. useWorkspaceSet binds all workspaces and parked
  // nodes; selecting a pane must not create, reset or replay its process.
  useEffect(() => {
    if (!activeNode) return;
    if (activeNode.kind === 'scratchpad') return;
    // Nobody has said where the first terminal opens yet. Spawning HOME behind
    // the picker would leave a shell running in a folder no one chose, and the
    // chosen folder would then be the second session rather than the first.
    if (needsWorkspaceChoice) return;
    ptyClient.setActiveSession(activeNode.id);
  }, [activeNode?.id, activeNode?.kind, needsWorkspaceChoice]);

  // The foreground process changes without any PTY event, so ask the daemon.
  useEffect(() => {
    const tick = () => ptyClient.requestTelemetry(activeNode?.cwd);
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [activeNode?.cwd, activeNode?.id]);

  /*
    Is the agent working? The mark pulses on this, so the answer has to be
    observed rather than asserted, and it has to be able to say no.

    `isWorking` asks whether output has been arriving CONTINUOUSLY, not merely
    recently — an agent parked at its prompt still repaints its own footer every
    second or so, and a recency test flagged that as work forever.

    There is no longer an `agentState === 'running'` arm here: that only ever
    applied to a block command, and there is no block editor to launch one from.
  */
  useEffect(() => {
    const apply = () =>
      setTelemetry((prev) => {
        const busy = activeNode ? isWorking(activeNode.id) : false;
        // Reading back is a mode, and the plate is the only place a mode's
        // controls can live now.
        const sb = activeNode ? scrollbackOf(activeNode.id) : null;
        const mode: 'waiting' | 'transport' =
          sb && (sb.detached || sb.query) ? 'transport' : 'waiting';
        const waiting = buildWaitingList(
          workspaceNodes,
          activeNode?.id ?? '',
          { isBusy: isWorking, lastOutputAt },
          attentionQueue,
        );
        // No clock reaches the rows any more, so this comparison now settles
        // far more often than it used to: a row changes only when its session
        // does. It still has to be made, because the array itself is rebuilt
        // every 150ms and a fresh object would redraw the plate for nothing.
        const unchanged =
          prev.agentBusy === busy &&
          prev.mode === mode &&
          prev.transport?.line === sb?.line &&
          prev.transport?.total === sb?.total &&
          prev.transport?.query === sb?.query &&
          prev.transport?.hit === sb?.hit &&
          prev.waiting?.length === waiting.length &&
          waiting.every((r, i) => {
            const p = prev.waiting?.[i];
            return p && p.sessionId === r.sessionId && p.n === r.n && p.name === r.name && p.status === r.status && p.tag === r.tag;
          });
        // SANDBOX reads WAIT while anything is blocked on you. The plate has
        // rendered pendingApproval that way since the gate existed; only the
        // source of the signal changed, from our own guess to the agent's word.
        const blocked = workspaceNodes.some((node) => node.blockedOnUser);
        if (unchanged && prev.pendingApproval === blocked) return prev;
        return { ...prev, agentBusy: busy, waiting, mode, transport: sb, pendingApproval: blocked };
      });

    apply();
    // The stream going quiet is not an event, so it has to be noticed on a
    // timer. Cheap: it only ever flips a boolean that is already correct.
    const id = window.setInterval(apply, 150);
    return () => window.clearInterval(id);
  }, [activeNode?.id, activeGroup.nodeIds, workspaceNodes]);

  const requestClose = (nodeId: string) => {
    const node = workspace.nodes[nodeId];
    if (!node) return;
    const mode = ptyClient.getSessionMode(nodeId);
    if (closeDisposition(node, mode?.durable ?? true) === 'kill') {
      handleKillNode(nodeId);
      return;
    }
    setPendingCloseId(nodeId);
  };

  useGlobalKeys({
    onNewTerminal: () => handleCreateNode(activeGroup.id, 'terminal'),
    onCloseSession: () => requestClose(activeGroup.activeNodeId),
    onOpenPalette: () => setIsPaletteOpen(true),
    onToggleAudio: () => setIsMuted(audioEngine.toggleMute()),
    onNextAttention: () => {
      const target = attentionQueue.next(telemetry.waiting ?? [], activeNode?.id ?? null);
      if (!target) return;
      attentionQueue.acknowledge(target);
      handleSelectNode(target);
    },
    onFocusPane: (direction) => {
      if (!activeGroup.paneTree) return;
      const target = adjacentPane(activeGroup.paneTree, activeGroup.activeNodeId, direction);
      if (target) handleSelectNode(target);
    },
    onSelectPane: () => {
      if (activeGroup.paneTree) setIsPaneSelectorOpen(true);
    },
    onTogglePaneZoom: () => {
      if (activeGroup.paneTree) {
        handleTogglePaneZoom(activeGroup.id, activeGroup.activeNodeId);
      }
    },
    onOpenWorkspace: () => setIsWorkspaceModalOpen(true),
    // A number with no session behind it does nothing, rather than guessing at
    // a neighbour. Ctrl+4 with three sessions open is a no-op on purpose.
    onJumpToNumber: (n) => {
      const target = workspaceNodes.find((node) => node.number === n);
      if (target) handleSelectNode(target.id);
    },
    onSnapToBottom: null,
  });

  /*
    Command palette actions — built only while the palette is on screen.

    This ran on EVERY App render, open or closed. Each build maps every
    session's whole rendered scrollback into a search corpus and joins it, so
    the most expensive thing in the app was being recomputed continuously for a
    surface nobody was looking at. It also handed the palette a brand new array
    every time, which used to reset the keyboard selection — see CommandPalette.
  */
  const paletteActions = useMemo(
    () => (isPaletteOpen ? buildPaletteActions({
    activeGroup,
    activeNode,
    workspaceName: workspace.name,
    workspaceNames,
    nodes: workspaceNodes,
    recoverableSessions: recoveryState.recoverable,
    setIsWorkspaceModalOpen,
    onCreateNode: handleCreateNode,
    onRenameNode: handleRenameNode,
    onSetGroupLayout: handleSetGroupLayout,
    onEqualizePanes: handleEqualizePanes,
    onSelectNode: handleSelectNode,
    onRecoverSession: handleRecoverSession,
    onCloseSession: (nodeId) => setPendingCloseId(nodeId),
    onTogglePaneZoom: () => {
      if (activeGroup.paneTree) {
        handleTogglePaneZoom(activeGroup.id, activeGroup.activeNodeId);
      }
    },
    onFocusPane: (direction) => {
      if (!activeGroup.paneTree) return;
      const targetId = adjacentPane(activeGroup.paneTree, activeGroup.activeNodeId, direction);
      if (targetId) handleSelectNode(targetId);
    },
    onSelectPane: () => {
      if (activeGroup.paneTree && activeGroup.paneTree.type === 'split') {
        setIsPaneSelectorOpen(true);
      }
    },
    onNextAttention: () => {
      const nextId = attentionQueue.next(
        telemetry.waiting ?? [],
        activeGroup.activeNodeId,
      );
      if (nextId) handleSelectNode(nextId);
    },
    onOpenPermissionsModal: () => setIsPermissionModalOpen(true),
    onOpenRenameModal: (nodeId, currentTitle) => {
      const node = workspace.nodes[nodeId];
      setRenameModalState({
        isOpen: true,
        nodeId,
        title: node ? node.title : currentTitle,
        sessionNumber: node?.number,
      });
    },
    onSendSignal: (sig) => {
      if (!activeNode) return;
      ptyClient.sendSignalToSession(activeNode.id, sig);
    },
    onViewAction: requestViewAction,
    onToggleAudio: handleToggleAudio,
    onToggleNotifications: handleToggleNotifications,
    // The same acknowledgement state the plate reads, so the palette and the
    // waiting rows agree about what is asking for you.
    attention: attentionQueue,
    }) : EMPTY_ACTIONS),
    // Deliberately coarse: while the palette is closed this never runs, and
    // while it is open the selection is tracked by id rather than by position,
    // so a rebuild no longer moves the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isPaletteOpen, workspaceNodes, activeGroup, activeNode, recoveryState.recoverable, notificationsEnabled, notificationPermission],
  );

  /**
   * One view.
   *
   * A shell is just another process that owns the keyboard, so there is no
   * mode to choose between and no `ownsKeyboard` test to get wrong. That test
   * existed only to decide between this and the block editor, and it was the
   * source of the worst class of bug in the app: an inline agent that never
   * set DECSET 1049 got the block editor, which buffered a whole line and
   * submitted it as a new command, losing characters to the agent's own redraw.
   */
  const renderSessionPane = (node: SessionNode, isActive: boolean) => {
    if (node.kind === 'scratchpad') {
      return (
        <Scratchpad
          title={node.title}
          initialContent={node.scratchpadContent}
          onSave={(content) => {
            setWorkspace((prev) => ({
              ...prev,
              nodes: {
                ...prev.nodes,
                [node.id]: { ...node, scratchpadContent: content },
              },
            }));
          }}
        />
      );
    }

    // A restored session with no process behind it is not a terminal, and
    // drawing one over its cached lines is what made a silently-respawned
    // shell indistinguishable from a recovered one.
    const binding = bindingFor(node.id);
    if (binding !== 'ready') {
      return (
        <SessionSnapshotNotice
          title={node.title}
          cwd={node.cwd}
          pending={binding === 'waiting'}
          lines={node.tuiLines}
          truncated={node.cacheTruncated}
          snapshotOf={node.snapshotOf ?? { sessionId: node.id, incarnation: node.incarnation }}
          onStart={() => handleReviveNode(node.id)}
        />
      );
    }

    return (
      <RawTerminalView
        lines={node.tuiLines}
        sessionId={node.id}
        isActive={isActive}
        agentKey={node.foregroundAgent ?? null}
        cursor={node.cursor ?? null}
        viewActionRequest={isActive ? viewActionRequest : null}
        onViewActionHandled={handleViewActionHandled}
        recoveredHistory={node.recoveredHistory}
        recoveryCacheLines={node.recoveryCacheLines}
        recoveryCacheTruncated={node.recoveryCacheTruncated}
        onWrite={(data: string) => ptyClient.writeToSession(node.id, data)}
        captureInputIdentity={() => ptyClient.captureInputIdentity(node.id)}
        onPasteText={(text, expected) => ptyClient.pasteToSession(node.id, text, expected)}
        onSendSignal={(sig: 'ctrl+c' | 'ctrl+d' | 'ctrl+z') => ptyClient.sendSignalToSession(node.id, sig)}
      />
    );
  };

  const groupNodes = activeGroup.nodeIds.map((id) => workspace.nodes[id]).filter(Boolean);
  useSessionNotifications(workspaceNodes, activeGroup.activeNodeId, handleSelectNode, notificationsEnabled);

  const isAudioActive = !isMuted;
  const hasFailed = workspaceNodes.some(isSessionFailed);
  const daemonConnected = ptyClient.getIsConnected();
  const chipStates: [boolean, boolean, boolean] = [
    isAudioActive,
    notificationsEnabled && notificationPermission === 'granted',
    hasFailed || !daemonConnected,
  ];

  const liveShellMetrics = {
    lines: activeNode?.tuiLines.length ?? 0,
    commands: activeNode?.executionSerial,
    active: activeNode?.number ?? 1,
    totalSessions: workspaceNodes.length,
    errors: workspaceNodes.filter(isSessionFailed).length,
  };

  const autoBlockedNode = permissionMode === 'auto'
    ? workspaceNodes.find((n) => n.blockedOnUser && !dismissedAsks.has(`${n.id}:${n.attentionSerial ?? 0}`))
    : null;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden select-none font-mono" style={{ background: 'var(--ground)' }}>
      <SessionModeNotice sessionId={activeNode?.id ?? null} />

      {/* The terminal reaches all four window edges. The plate is the only
          chrome, and Ctrl+1-9 plus the plate's waiting rows are how you move
          between sessions now that the strip and the sidebar are gone. */}
      <div className="flex-1 flex relative min-h-0 min-w-0">
        <AgentQueueIndicator
          nodes={workspaceNodes}
          activeSessionId={activeGroup.activeNodeId}
          onSelectNode={handleSelectNode}
        />
        <SplitPaneGrid
          layout={activeGroup.layout}
          nodes={groupNodes}
          activeNodeId={activeGroup.activeNodeId}
          paneTree={activeGroup.paneTree}
          zoomedSessionId={activeGroup.zoomedSessionId}
          onPaneTreeChange={(tree) => handleSetPaneTree(activeGroup.id, tree)}
          onSelectNode={handleSelectNode}
          renderPane={renderSessionPane}
        />
        {isPaneSelectorOpen && activeGroup.paneTree && (
          <PaneSelectOverlay
            tree={activeGroup.paneTree}
            onSelect={handleSelectNode}
            onClose={() => setIsPaneSelectorOpen(false)}
          />
        )}
      </div>

      {/* The agent owns approval; this banner only opens its terminal. */}
      {autoBlockedNode && (
        <div
          className="shrink-0 flex items-center justify-between px-3 py-1.5 font-mono text-[12px]"
          style={{
            background: '#1a1714',
            borderTop: '1px solid var(--st-live)',
            borderBottom: '1px solid var(--st-live)',
            boxShadow: 'var(--bevel-up)',
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className="px-1.5 py-0.5 font-bold text-[10px] tracking-wider uppercase"
              style={{ background: 'var(--st-live)', color: '#000' }}
            >
              REVIEW
            </span>
            <span style={{ color: 'var(--st-live)' }}>
              Session #{autoBlockedNode.number ?? '?'} requested tool permission
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                handleSelectNode(autoBlockedNode.id);
              }}
              className="px-2.5 py-0.5 text-[11px] font-bold plate hover:bg-[#322f28]"
              style={{ color: 'var(--st-pass)' }}
            >
              REVIEW IN TERMINAL
            </button>
            <button
              type="button"
              onClick={() => {
                setDismissedAsks((prev) => new Set(prev).add(`${autoBlockedNode.id}:${autoBlockedNode.attentionSerial ?? 0}`));
                audioEngine.playSound('click', 2);
                setToastMessage(`DISMISSED FOR #${autoBlockedNode.number ?? '?'}`);
              }}
              className="px-2.5 py-0.5 text-[11px] font-bold plate hover:bg-[#322f28]"
              style={{ color: 'var(--st-fail)' }}
            >
              DISMISS
            </button>
          </div>
        </div>
      )}

      {/* Transient Status Feedback Overlay */}
      {toastMessage && (
        <div
          className="fixed bottom-10 right-4 z-40 plate px-3 py-1 text-[11px] font-bold tracking-wider"
          style={{
            boxShadow: 'var(--bevel-up)',
            color: 'var(--st-live)',
            background: '#1a1714',
            border: '1px solid var(--st-live)',
          }}
        >
          ▸ {toastMessage}
        </div>
      )}

      {/* Bottom Doom 1993 Status Plate (STBAR) */}
      <div className="shrink-0">
        <StatusPlate
          telemetry={{
            ...visibleTelemetry,
            permissionMode,
            chips: chipStates,
            shellMetrics: liveShellMetrics,
          }}
          onSelectWaiting={(sessionId) => {
            attentionQueue.acknowledge(sessionId);
            handleSelectNode(sessionId);
          }}
          onOpenPermissionsModal={() => setIsPermissionModalOpen(true)}
          onSelectChip={handleSelectChip}
        />
      </div>

      {/* Universal Command Palette Modal */}
      <CommandPalette
        isOpen={isPaletteOpen}
        onClose={() => setIsPaletteOpen(false)}
        actions={paletteActions}
        onRenameSession={(nodeId, currentTitle) => {
          const node = workspace.nodes[nodeId];
          setRenameModalState({
            isOpen: true,
            nodeId,
            title: node ? node.title : currentTitle,
            sessionNumber: node?.number,
          });
        }}
      />

      {/* Workspace Folder Picker Modal. On a run with nothing to restore this
          opens itself: the first terminal belongs in a folder someone chose,
          and Esc still means HOME. */}
      <WorkspaceModal
        isOpen={isWorkspaceModalOpen || needsWorkspaceChoice}
        onClose={() => {
          if (needsWorkspaceChoice) dismissStartupChoice();
          setIsWorkspaceModalOpen(false);
        }}
        onSelectWorkspace={(path, name) => {
          if (needsWorkspaceChoice) chooseStartupWorkspace(path, name);
          else handleOpenWorkspaceFolder(path, name);
        }}
      />

      {/* In-App Rename Session Modal */}
      <RenameSessionModal
        isOpen={renameModalState.isOpen}
        initialTitle={renameModalState.title}
        sessionNumber={renameModalState.sessionNumber}
        onRename={(newTitle) => handleRenameNode(renameModalState.nodeId, newTitle)}
        onClose={() => setRenameModalState((prev) => ({ ...prev, isOpen: false }))}
      />

      {/* Execution Permission & Environment Mode Modal */}
      <PermissionModeModal
        isOpen={isPermissionModalOpen}
        currentMode={permissionMode}
        isolation={visibleTelemetry.isolation}
        cwd={activeNode?.cwd}
        branch={activeNode?.gitBranch}
        isAudioMuted={!isAudioActive}
        notificationsEnabled={notificationsEnabled && notificationPermission === 'granted'}
        onToggleAudio={handleToggleAudio}
        onToggleNotifications={handleToggleNotifications}
        onSelectMode={handleSetPermissionMode}
        onCreateWorktreeSession={handleCreateWorktreeSession}
        onToggleZoom={() => {
          if (activeGroup.paneTree) {
            handleTogglePaneZoom(activeGroup.id, activeGroup.activeNodeId);
          }
        }}
        onClose={() => setIsPermissionModalOpen(false)}
      />

      {pendingCloseId && workspace.nodes[pendingCloseId] && (
        <CloseSessionPrompt
          title={workspace.nodes[pendingCloseId].title}
          // Null is "the daemon has not said yet", which `?? false` turned into
          // a confident warning that parking would not survive. Pass it through.
          durable={ptyClient.getSessionMode(pendingCloseId)?.durable ?? null}
          onPark={() => {
            handleParkNode(pendingCloseId);
            setPendingCloseId(null);
          }}
          onKill={() => {
            handleKillNode(pendingCloseId);
            setPendingCloseId(null);
          }}
          onCancel={() => setPendingCloseId(null)}
        />
      )}
      {authMessage !== null && <DaemonAuthModal message={authMessage} onAuthenticate={(token) => ptyClient.authenticate(token)} />}
    </div>
  );
};
