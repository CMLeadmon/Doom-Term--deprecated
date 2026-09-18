import { describe, expect, it, vi } from 'vitest';
import type { SessionGroup, SessionNode } from '../types/sessionTree';
import { buildPaletteActions, type PaletteContext } from './paletteActions';

const node: SessionNode = {
  id: 'node-1',
  groupId: 'group-1',
  title: 'Terminal 1',
  number: 1,
  kind: 'terminal',
  cwd: '/workspace',
  gitBranch: 'main',
  activeBlockId: null,
  isTuiActive: false,
  agentState: 'idle',
  tuiLines: [],
  commandHistory: [],
  createdAt: 1,
};

const group: SessionGroup = {
  id: 'group-1',
  projectId: 'workspace-1',
  name: 'Main',
  layout: 'single',
  activeNodeId: node.id,
  nodeIds: [node.id],
  createdAt: 1,
};

function context(onViewAction: ReturnType<typeof vi.fn>): PaletteContext {
  return {
    activeGroup: group,
    activeNode: node,
    workspaceName: 'Workspace',
    nodes: [node],
    setIsWorkspaceModalOpen: vi.fn(),
    onCreateNode: vi.fn(),
    onRenameNode: vi.fn(),
    onSetGroupLayout: vi.fn(),
    onEqualizePanes: vi.fn(),
    onSelectNode: vi.fn(),
    onViewAction,
  };
}

describe('view-local palette commands', () => {
  it('routes every advertised terminal-view command to executable behavior', () => {
    const onViewAction = vi.fn();
    const actions = buildPaletteActions(context(onViewAction));
    const routes = {
      'quick-select': 'quickSelect',
      'copy-turn': 'copyTurn',
      'previous-turn': 'previousTurn',
      'next-turn': 'nextTurn',
      'search-scrollback': 'searchScrollback',
      'copy-selection': 'copySelection',
      'paste-clipboard': 'pasteClipboard',
    } as const;

    for (const [id] of Object.entries(routes)) {
      actions.find((action) => action.id === id)?.run();
    }

    expect(onViewAction.mock.calls.map(([action]) => action)).toEqual(Object.values(routes));
  });

  it('does not advertise terminal commands while a scratchpad is active', () => {
    const scratchpad = { ...node, id: 'notes-1', kind: 'scratchpad' as const };
    const actions = buildPaletteActions({
      ...context(vi.fn()),
      activeNode: scratchpad,
      nodes: [scratchpad],
    });

    expect(actions.some((action) => action.category === 'Terminal')).toBe(false);
  });
});
