import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SplitPaneGrid } from './SplitPaneGrid';
import { SessionNode } from '../types/sessionTree';
import { paneLeaf, treeFromLayout } from '../core/paneTree';

const node = (id: string, title: string, number: number | null = 1): SessionNode => ({
  id,
  groupId: 'g1',
  title,
  number,
  kind: 'terminal',
  cwd: '/test',
  gitBranch: 'main',
  activeBlockId: null,
  isTuiActive: false,
  agentState: 'idle',
  tuiLines: [],
  commandHistory: [],
  createdAt: 1000,
});

const nodes = [node('n1', 'One'), node('n2', 'Two')];

const renderGrid = (activeNodeId: string) =>
  render(
    <SplitPaneGrid
      layout="single"
      nodes={nodes}
      activeNodeId={activeNodeId}
      onSelectNode={vi.fn()}
      renderPane={(n) => <div>Pane: {n.title}</div>}
    />
  );

/** The visibility-toggling wrapper this pane is rendered inside. */
const paneBox = (title: string): HTMLElement =>
  screen.getByText(`Pane: ${title}`).closest('[data-pane]') as HTMLElement;

describe('SplitPaneGrid single layout', () => {
  it('mounts every pane, not only the active one', () => {
    // A tab switch used to unmount the inactive pane and rebuild the other from
    // state, throwing away its DOM, scroll position and focus.
    renderGrid('n1');
    expect(screen.getByText('Pane: One')).toBeDefined();
    expect(screen.getByText('Pane: Two')).toBeDefined();
  });

  it('shows only the active pane', () => {
    renderGrid('n1');
    expect(paneBox('One').style.visibility).toBe('visible');
    expect(paneBox('Two').style.visibility).toBe('hidden');
  });

  it('does not let a hidden pane take the mouse', () => {
    renderGrid('n1');
    expect(paneBox('Two').style.pointerEvents).toBe('none');
  });

  it('falls back to the first pane when the active id matches nothing', () => {
    renderGrid('gone');
    expect(paneBox('One').style.visibility).toBe('visible');
  });
});

describe('SplitPaneGrid persistent tree', () => {
  it('renders the recursive leaf order from a persisted tree', () => {
    render(
      <SplitPaneGrid
        layout="single"
        paneTree={treeFromLayout('split-v', ['n2', 'n1'])!}
        nodes={nodes}
        activeNodeId="n2"
        onSelectNode={vi.fn()}
        renderPane={(n) => <div>Tree: {n.title}</div>}
      />,
    );
    expect(screen.getAllByTestId('pane-leaf').map((leaf) => leaf.getAttribute('data-pane')))
      .toEqual(['n2', 'n1']);
  });

  it('zooms one leaf while keeping its sibling mounted', () => {
    render(
      <SplitPaneGrid
        layout="split-v"
        paneTree={treeFromLayout('split-v', ['n1', 'n2'])!}
        zoomedSessionId="n2"
        nodes={nodes}
        activeNodeId="n2"
        onSelectNode={vi.fn()}
        renderPane={(n) => <div>Zoom: {n.title}</div>}
      />,
    );
    expect(screen.getByText('Zoom: One')).toBeTruthy();
    expect(screen.getByText('Zoom: Two')).toBeTruthy();
    expect((screen.getByText('Zoom: One').closest('[data-pane]') as HTMLElement).style.visibility).toBe('hidden');
    expect((screen.getByText('Zoom: Two').closest('[data-pane]') as HTMLElement).style.position).toBe('absolute');
  });
});

describe('single layout AFTER pane-tree migration', () => {
  // Every existing single-layout test above renders without a `paneTree`, which
  // is not what production looks like once a workspace has been migrated. With
  // one present the tree is the visibility authority, and that is where the
  // committed selection bug lived.
  const renderWithTree = (activeNodeId: string, showing: string) =>
    render(
      <SplitPaneGrid
        layout="single"
        nodes={nodes}
        activeNodeId={activeNodeId}
        paneTree={paneLeaf(showing)}
        onSelectNode={vi.fn()}
        renderPane={(n) => <div>Pane: {n.title}</div>}
      />
    );

  it('shows the active session even when the stored tree still names another', () => {
    // Reproduced with an active id that is absent from the tree: the session
    // was active in state and hidden on screen, with no focused terminal.
    renderWithTree('n2', 'n1');
    expect(screen.getByText('Pane: Two')).toBeDefined();
    expect(paneBox('Two').getAttribute('data-pane')).toBe('n2');
  });

  it('marks the visible pane as the active one', () => {
    renderWithTree('n2', 'n1');
    expect(paneBox('Two').style.border).toContain('var(--st-live)');
  });

  it('does not correct the tree for a session the group does not hold', () => {
    // A stale id must not blank the pane: fall back to what the tree says.
    render(
      <SplitPaneGrid
        layout="single"
        nodes={nodes}
        activeNodeId="ghost"
        paneTree={paneLeaf('n1')}
        onSelectNode={vi.fn()}
        renderPane={(n) => <div>Pane: {n.title}</div>}
      />
    );
    expect(screen.getByText('Pane: One')).toBeDefined();
  });
});

describe('a backgrounded pane measures the same box as a foreground one', () => {
  /*
   * `useTerminalSize` measures the pane's own box and floors it into columns,
   * so any geometry difference between the shown pane and the hidden one is a
   * column difference the moment you switch. It was 2px: a leaf carries a 1px
   * border on every side (amber when active, transparent when not) and the
   * off-tree wrapper carried none. Measured in Chromium at a 1600px window:
   * 1600px hidden -> 195 columns, 1598px shown -> 194. Selecting the session
   * therefore sent a genuine Resize, and an inline agent redraws its whole
   * frame on SIGWINCH. That redraw is the "content shifts when switching
   * between agents" report.
   */
  const renderOffTree = () =>
    render(
      <SplitPaneGrid
        layout="single"
        nodes={nodes}
        activeNodeId="n1"
        paneTree={paneLeaf('n1')}
        onSelectNode={vi.fn()}
        renderPane={(n) => <div>Pane: {n.title}</div>}
      />
    );

  it('gives the hidden wrapper the same border box as the visible leaf', () => {
    renderOffTree();
    const shown = paneBox('One');
    const hidden = paneBox('Two');
    expect(hidden.style.visibility).toBe('hidden');
    // The width is the whole point; the colour is what differs between them.
    const width = (el: HTMLElement) => /^\s*(\S+)\s+solid/.exec(el.style.border)?.[1];
    expect(width(shown)).toBe('1px');
    expect(width(hidden)).toBe('1px');
  });

  it('stacks the hidden wrapper the same way, so its height matches too', () => {
    renderOffTree();
    expect(paneBox('Two').className).toContain('flex-col');
    expect(paneBox('One').className).toContain('flex-col');
  });

  it('keeps the hidden pane unpainted — matching geometry is not a visible frame', () => {
    renderOffTree();
    expect(paneBox('Two').style.border).not.toContain('var(--st-live)');
  });
});
