import React from 'react';
import { PaneTree, SplitLayoutMode, SessionNode } from '../types/sessionTree';
import { leafSessionIds, paneLeaf, setSplitRatio } from '../core/paneTree';

export interface SplitPaneGridProps {
  layout: SplitLayoutMode;
  nodes: SessionNode[];
  activeNodeId: string;
  paneTree?: PaneTree;
  zoomedSessionId?: string;
  onPaneTreeChange?: (tree: PaneTree) => void;
  onSelectNode: (nodeId: string) => void;
  renderPane: (node: SessionNode, isActive: boolean) => React.ReactNode;
}

export const SplitPaneGrid: React.FC<SplitPaneGridProps> = ({
  layout,
  nodes,
  activeNodeId,
  paneTree,
  zoomedSessionId,
  onPaneTreeChange,
  onSelectNode,
  renderPane,
}) => {
  if (nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[13px] tracking-wider" style={{ color: 'var(--ink-dim)' }}>
        [NO ACTIVE SESSIONS - PRESS CTRL+SHIFT+T TO SPAWN]
      </div>
    );
  }

  const effectiveTree =
    layout === 'single' && paneTree?.type === 'leaf' && paneTree.sessionId !== activeNodeId && nodes.some((n) => n.id === activeNodeId)
      ? paneLeaf(activeNodeId)
      : paneTree;

  if (effectiveTree) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visibleIds = new Set(leafSessionIds(effectiveTree));
    const zooming = Boolean(zoomedSessionId && visibleIds.has(zoomedSessionId));

    const renderLeaf = (tree: PaneTree): React.ReactNode => {
      if (tree.type === 'leaf') {
        const node = byId.get(tree.sessionId);
        if (!node) return null;
        const isActive = node.id === activeNodeId;
        const isZoomed = zooming && node.id === zoomedSessionId;
        return (
          <div
            key={tree.id}
            data-testid="pane-leaf"
            data-pane={node.id}
            onClick={() => onSelectNode(node.id)}
            className="flex flex-1 flex-col min-h-0 min-w-0"
            style={{
              border: isActive ? '1px solid var(--st-live)' : '1px solid transparent',
              background: 'var(--ground)',
              position: zooming ? 'absolute' : 'relative',
              inset: zooming ? 0 : undefined,
              visibility: zooming && !isZoomed ? 'hidden' : 'visible',
              pointerEvents: zooming && !isZoomed ? 'none' : 'auto',
              zIndex: isZoomed ? 10 : undefined,
            }}
          >
            {renderPane(node, isActive)}
          </div>
        );
      }

      const horizontal = tree.direction === 'row';
      const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!onPaneTreeChange) return;
        event.preventDefault();
        const box = event.currentTarget.parentElement?.getBoundingClientRect();
        if (!box) return;
        const move = (pointer: PointerEvent) => {
          const ratio = horizontal
            ? (pointer.clientX - box.left) / Math.max(1, box.width)
            : (pointer.clientY - box.top) / Math.max(1, box.height);
          onPaneTreeChange(setSplitRatio(effectiveTree, tree.id, ratio));
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
      };

      return (
        <div
          key={tree.id}
          data-split={tree.id}
          className={`flex flex-1 min-h-0 min-w-0 ${horizontal ? 'flex-row' : 'flex-col'}`}
          style={zooming ? { display: 'contents' } : undefined}
        >
          <div className="flex min-h-0 min-w-0" style={zooming ? { display: 'contents' } : horizontal ? { width: `${tree.ratio * 100}%` } : { height: `${tree.ratio * 100}%` }}>
            {renderLeaf(tree.first)}
          </div>
          <div
            role="separator"
            aria-orientation={horizontal ? 'vertical' : 'horizontal'}
            onPointerDown={beginResize}
            // The bevel stays one pixel; a transparent hit area makes it
            // draggable even when layout rounds its edge between pixels.
            className={`relative z-20 shrink-0 before:absolute before:-inset-1 before:content-[''] ${horizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'}`}
            style={{ background: 'var(--ink-dim)', display: zooming ? 'none' : undefined }}
          />
          <div className="flex flex-1 min-h-0 min-w-0" style={zooming ? { display: 'contents' } : undefined}>{renderLeaf(tree.second)}</div>
        </div>
      );
    };

    return (
      <div className="flex-1 relative flex min-h-0 min-w-0">
        {renderLeaf(effectiveTree)}
        {/*
            A backgrounded pane is the SAME BOX as a foreground one.

            It stays mounted and laid out on purpose — `visibility` rather than
            `display`, so it keeps measuring the window. That only works if it
            measures the same box: this wrapper used to carry no border while a
            leaf carries `1px solid`, so a session was 2px wider and 2px taller
            while it was in the background. At 8px cells that is a whole column,
            and selecting the session sent a real Resize — a SIGWINCH, which an
            inline agent answers by redrawing its entire frame at a new width.
            That redraw is what "the content shifts when I switch agents" is.
        */}
        {nodes.filter((node) => !visibleIds.has(node.id)).map((node) => (
          <div
            key={node.id}
            data-pane={node.id}
            aria-hidden="true"
            className="absolute inset-0 flex flex-col min-h-0 min-w-0"
            style={{
              border: '1px solid transparent',
              background: 'var(--ground)',
              visibility: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {renderPane(node, false)}
          </div>
        ))}
      </div>
    );
  }

  if (layout === 'single' || nodes.length === 1) {
    // Every pane stays mounted and only the active one is shown. Rendering just
    // the active node meant a tab switch unmounted its subtree and rebuilt the
    // other from state — throwing away the DOM, the scroll position and focus.
    //
    // visibility rather than display: display:none removes the layout box, so a
    // backgrounded pane would measure 0x0 and stop tracking the window size.
    const activeId = nodes.some((n) => n.id === activeNodeId) ? activeNodeId : nodes[0].id;
    return (
      <div className="flex-1 relative min-h-0 min-w-0">
        {nodes.map((node) => {
          const isActive = node.id === activeId;
          return (
            <div
              key={node.id}
              data-pane={node.id}
              aria-hidden={!isActive}
              className="absolute inset-0 flex flex-col min-h-0 min-w-0"
              style={{
                visibility: isActive ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
              }}
            >
              {renderPane(node, isActive)}
            </div>
          );
        })}
      </div>
    );
  }

  let gridClasses = 'flex-1 grid gap-1.5 min-h-0 min-w-0 ';
  if (layout === 'split-v') {
    gridClasses += 'grid-cols-2 grid-rows-1';
  } else if (layout === 'split-h') {
    gridClasses += 'grid-cols-1 grid-rows-2';
  } else if (layout === 'grid-2x2') {
    gridClasses += 'grid-cols-2 grid-rows-2';
  }

  return (
    <div className={gridClasses}>
      {nodes.map((node) => {
        const isActive = node.id === activeNodeId;
        return (
          <div
            key={node.id}
            onClick={() => onSelectNode(node.id)}
            className={`flex flex-col min-h-0 min-w-0 ${isActive ? 'bev-up' : 'bev-dn'}`}
            style={{
              border: isActive ? '1px solid var(--st-live)' : '1px solid transparent',
              background: 'var(--ground)',
            }}
          >
            <div
              className="flex items-center justify-between px-2 py-0.5 text-[11px] font-bold tracking-wider plate"
              style={{ color: 'var(--ink-plate)', opacity: isActive ? 1 : 0.75 }}
            >
              <div className="flex items-center gap-1.5 truncate">
                <span>{isActive ? '▸' : '▪'}</span>
                <span className="truncate">{node.title}</span>
                <span className="text-[10px] opacity-75">({node.kind.toUpperCase()})</span>
              </div>
              <span className="text-[10px] uppercase">{node.agentState}</span>
            </div>
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
              {renderPane(node, isActive)}
            </div>
          </div>
        );
      })}
    </div>
  );
};
