import { CommandPaletteAction } from '../components/CommandPalette';
import { PaneDirection, SessionGroup, SessionNode, SplitLayoutMode } from '../types/sessionTree';
import { audioEngine } from './audioEngine';
import { BINDINGS, type AppAction } from './keymap';
import type { ViewAction } from './keymap';
import { formatNodeTranscript } from './transcript';
import {
  attentionRank, previewSession, rankSessions, sessionSearchText,
  type SwitcherAttention,
} from './sessionSwitcher';
import type { RecoverableSession } from './sessionRecovery';

export interface PaletteContext {
  activeGroup: SessionGroup;
  activeNode: SessionNode | undefined;
  workspaceName: string;
  /** Every session across open workspaces. */
  nodes: SessionNode[];
  workspaceNames?: Record<string, string>;
  recoverableSessions: RecoverableSession[];
  /**
   * The same acknowledgement state the plate's waiting rows read.
   *
   * Optional so a test can build actions without one, but the app passes it:
   * without it the palette promotes only sessions that asked a question and
   * disagrees with the plate about what needs attention.
   */
  attention?: SwitcherAttention;
  setIsWorkspaceModalOpen: (next: boolean) => void;
  onCreateNode: (groupId: string, kind: SessionNode['kind'], splitDirection?: PaneDirection) => void;
  onRenameNode: (nodeId: string, title: string) => void;
  onSetGroupLayout: (groupId: string, layout: SplitLayoutMode) => void;
  onEqualizePanes: (groupId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onRecoverSession: (session: RecoverableSession) => void;
  onCloseSession?: (nodeId: string) => void;
  onTogglePaneZoom?: () => void;
  onFocusPane?: (direction: 'left' | 'right' | 'up' | 'down') => void;
  onSelectPane?: () => void;
  onNextAttention?: () => void;
  onOpenPermissionsModal?: () => void;
  onOpenRenameModal?: (nodeId: string, currentTitle: string) => void;
  onSendSignal?: (sig: 'ctrl+c' | 'ctrl+d' | 'ctrl+z') => void;
  onViewAction: (action: ViewAction) => void;
  onToggleAudio?: () => void;
  onToggleNotifications?: () => void;
}

/**
 * The chord for an action, as the keymap actually binds it.
 */
const chordFor = (action: AppAction): string | undefined =>
  BINDINGS.find((b) => b.action === action)?.label;

/**
 * How a session's agent reads in a list.
 *
 * The key, not a display name: the daemon sends the vendor's key and the plate
 * owns the long-form name. Blocked-on-you leads, because it is the one thing
 * that should make you pick that session next.
 */
function agentLabel(node: SessionNode): string {
  const parts = [];
  if (node.parked) parts.push('· PARKED');
  if (node.foregroundAgent) parts.push(`· ${node.foregroundAgent.toUpperCase()}`);
  return parts.join(' ');
}

/**
 * Everything the command palette can do.
 *
 * This is the only home for actions that have no on-screen control — the
 * design system has no header row, so the palette and the keyboard are where
 * layout, the sidebar and the workspace picker live.
 */
export function buildPaletteActions(ctx: PaletteContext): CommandPaletteAction[] {
  const {
    activeGroup,
    activeNode,
    nodes,
    recoverableSessions,
    workspaceName,
    setIsWorkspaceModalOpen,
    onCreateNode,
    onRenameNode,
    onSetGroupLayout,
    onEqualizePanes,
    onSelectNode,
    onRecoverSession,
    onCloseSession,
    onTogglePaneZoom,
    onFocusPane,
    onSelectPane,
    onNextAttention,
    onOpenPermissionsModal,
    onOpenRenameModal,
    onSendSignal,
    onViewAction,
  } = ctx;

  /*
    Sessions first, and one row each.

    Ctrl+K is described to a new user as "sessions, and every other command",
    and with no tab strip and no sidebar this list is the only place a session
    can be seen and chosen with the eyes rather than recalled by number. They
    lead because switching is the thing you do most.
  */
  const sessions: CommandPaletteAction[] = rankSessions(nodes, ctx.attention)
    .map((node) => ({
      id: `goto-${node.id}`,
      category: 'Session',
      rawTitle: node.title,
      title: [`${node.number ?? '-'}.`, node.title, agentLabel(node)]
        .filter(Boolean)
        .join(' '),
      shortcut: node.number ? `CTRL+${node.number}` : undefined,
      searchText: sessionSearchText(node, ctx.workspaceNames?.[node.id] ?? workspaceName),
      preview: [ctx.workspaceNames?.[node.id], previewSession(node, 4)].filter(Boolean).join('\n'),
      // Everything the plate calls attention, not only an explicit question:
      // a failed command and unread output are in the same queue.
      attention: attentionRank(node, ctx.attention) < 3,
      attentionType: node.blockedOnUser
        ? 'asks'
        : typeof node.lastExitCode === 'number' && node.lastExitCode !== 0
        ? 'fail'
        : 'unread',
      run: () => onSelectNode(node.id),
    }));

  const recoveries: CommandPaletteAction[] = recoverableSessions.map((session) => ({
    id: `recover-${session.id}`,
    category: 'Recovery',
    title: `Recover ${session.id} · ${session.command || 'shell'}`,
    searchText: `${session.id}\n${session.cwd}\n${session.command}`.toLowerCase(),
    preview: `${session.cwd}\n${session.durable ? 'DURABLE TMUX SESSION' : 'LIVE DAEMON SESSION'}`,
    run: () => onRecoverSession(session),
  }));

  return [
    ...sessions,
    ...recoveries,
    {
      id: 'rename-session',
      category: 'Session',
      title: 'Rename Active Session',
      shortcut: 'F2',
      run: () => {
        if (!activeNode) return;
        if (onOpenRenameModal) {
          onOpenRenameModal(activeNode.id, activeNode.title);
        } else {
          const newName = prompt('Enter new session name:', activeNode.title);
          if (newName && newName.trim()) onRenameNode(activeNode.id, newName.trim());
        }
      },
    },
    {
      id: 'close-session',
      category: 'Session',
      title: 'Close Active Session',
      shortcut: chordFor('closeSession'),
      run: () => {
        if (activeNode && onCloseSession) onCloseSession(activeNode.id);
      },
    },
    {
      id: 'permission-mode',
      category: 'Permissions',
      title: 'Permission Review, Worktrees & Settings',
      run: () => onOpenPermissionsModal?.(),
    },
    {
      id: 'next-attention',
      category: 'Navigation',
      title: 'Jump to Next Session Needing Attention',
      shortcut: chordFor('nextAttention'),
      run: () => onNextAttention?.(),
    },
    {
      id: 'toggle-zoom',
      category: 'Layout',
      title: 'Toggle Focused Pane Zoom',
      shortcut: chordFor('togglePaneZoom'),
      run: () => onTogglePaneZoom?.(),
    },
    {
      id: 'select-pane',
      category: 'Layout',
      title: 'Label Panes For Direct Selection',
      shortcut: chordFor('selectPane'),
      run: () => onSelectPane?.(),
    },
    {
      id: 'focus-left',
      category: 'Layout',
      title: 'Focus Pane Left',
      shortcut: chordFor('focusPaneLeft'),
      run: () => onFocusPane?.('left'),
    },
    {
      id: 'focus-right',
      category: 'Layout',
      title: 'Focus Pane Right',
      shortcut: chordFor('focusPaneRight'),
      run: () => onFocusPane?.('right'),
    },
    {
      id: 'focus-up',
      category: 'Layout',
      title: 'Focus Pane Above',
      shortcut: chordFor('focusPaneUp'),
      run: () => onFocusPane?.('up'),
    },
    {
      id: 'focus-down',
      category: 'Layout',
      title: 'Focus Pane Below',
      shortcut: chordFor('focusPaneDown'),
      run: () => onFocusPane?.('down'),
    },
    {
      id: 'new-term',
      category: 'Session',
      title: 'New Terminal Session',
      shortcut: chordFor('newSession'),
      run: () => onCreateNode(activeGroup.id, 'terminal'),
    },
    {
      id: 'open-workspace',
      category: 'Workspace',
      title: 'Open / Select Workspace Folder…',
      shortcut: chordFor('openWorkspace'),
      run: () => setIsWorkspaceModalOpen(true),
    },
    {
      id: 'split-right',
      category: 'Layout',
      title: 'Split Right',
      run: () => onCreateNode(activeGroup.id, 'terminal', 'row'),
    },
    {
      id: 'split-down',
      category: 'Layout',
      title: 'Split Down',
      run: () => onCreateNode(activeGroup.id, 'terminal', 'column'),
    },
    {
      id: 'equalize-panes',
      category: 'Layout',
      title: 'Equalize Pane Sizes',
      run: () => onEqualizePanes(activeGroup.id),
    },
    {
      id: 'layout-single',
      category: 'Layout',
      title: 'Layout: Single Full Pane',
      run: () => onSetGroupLayout(activeGroup.id, 'single'),
    },
    {
      id: 'layout-split-v',
      category: 'Layout',
      title: 'Layout: Split Vertical (2 Panes)',
      run: () => onSetGroupLayout(activeGroup.id, 'split-v'),
    },
    {
      id: 'layout-grid',
      category: 'Layout',
      title: 'Layout: 2x2 Quad Grid',
      run: () => onSetGroupLayout(activeGroup.id, 'grid-2x2'),
    },
    {
      id: 'quick-select',
      category: 'Terminal',
      title: 'Quick Select Developer Reference (URL, SHA, path)',
      shortcut: 'CTRL+SHIFT+E',
      run: () => onViewAction('quickSelect'),
    },
    {
      id: 'copy-turn',
      category: 'Terminal',
      title: 'Copy Current Agent Turn',
      shortcut: 'CTRL+SHIFT+Y',
      run: () => onViewAction('copyTurn'),
    },
    {
      id: 'previous-turn',
      category: 'Terminal',
      title: 'Jump to Previous Agent Turn',
      shortcut: 'CTRL+SHIFT+[',
      run: () => onViewAction('previousTurn'),
    },
    {
      id: 'next-turn',
      category: 'Terminal',
      title: 'Jump to Next Agent Turn',
      shortcut: 'CTRL+SHIFT+]',
      run: () => onViewAction('nextTurn'),
    },
    {
      id: 'search-scrollback',
      category: 'Terminal',
      title: 'Search Session Scrollback',
      shortcut: 'CTRL+SHIFT+F',
      run: () => onViewAction('searchScrollback'),
    },
    {
      id: 'copy-selection',
      category: 'Terminal',
      title: 'Copy Selection',
      shortcut: 'CTRL+SHIFT+C',
      run: () => onViewAction('copySelection'),
    },
    {
      id: 'paste-clipboard',
      category: 'Terminal',
      title: 'Paste Safely (Bracketed Paste)',
      shortcut: 'CTRL+SHIFT+V',
      run: () => onViewAction('pasteClipboard'),
    },
    {
      id: 'signal-interrupt',
      category: 'Terminal',
      title: 'Send Ctrl+C (Interrupt)',
      shortcut: 'CTRL+C',
      run: () => onSendSignal?.('ctrl+c'),
    },
    {
      id: 'signal-eof',
      category: 'Terminal',
      title: 'Send End-Of-File (EOF)',
      shortcut: 'CTRL+D',
      run: () => onSendSignal?.('ctrl+d'),
    },
    {
      id: 'copy-transcript',
      category: 'Session',
      title: 'Copy Entire Session Transcript',
      run: () => {
        if (!activeNode) return;
        navigator.clipboard.writeText(formatNodeTranscript(activeNode));
        audioEngine.playSound('click', 3);
      },
    },
    {
      id: 'enable-notifications',
      category: 'System',
      title: 'Toggle Desktop Notifications',
      run: () => ctx.onToggleNotifications?.(),
    },
    {
      id: 'new-scratchpad',
      category: 'Notes',
      title: 'Open Markdown Scratchpad',
      run: () => onCreateNode(activeGroup.id, 'scratchpad'),
    },
    {
      id: 'new-artifact',
      category: 'Artifacts',
      title: 'Create Blank Artifact Pane',
      run: () => onCreateNode(activeGroup.id, 'artifact'),
    },
    {
      id: 'toggle-audio',
      category: 'Audio',
      title: 'Toggle Sound Effects',
      shortcut: chordFor('toggleAudio'),
      run: () => ctx.onToggleAudio?.(),
    },
  ].filter((action) => (activeNode?.kind !== 'scratchpad' && activeNode?.kind !== 'artifact') || action.category !== 'Terminal');
}
