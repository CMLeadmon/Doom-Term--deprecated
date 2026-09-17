import React, { useEffect, useRef } from 'react';
import { SessionNode } from '../types/sessionTree';
import { isWorking } from '../core/activityMonitor';
import { markSurface } from '../hud/agentMark';
import { pulsePhase } from '../hud/state';

/** Matches the plate's own 28px-scale chrome. Integer, like every cell here. */
const BAR_H = 28;
const MARK = 20;

export interface TitleBarProps {
  nodes: SessionNode[];
  activeSessionId: string | null;
  onSelectNode: (nodeId: string) => void;
  title: string;
  onMinimize?: () => void;
  onToggleMaximize?: () => void;
  onClose?: () => void;
}

/**
 * One agent mark, painted from the plate's own bitmap.
 *
 * Integer scale only, for the same reason the plate scales at 2 or 3:
 * fractional scaling interpolates and destroys a 1px bitmap. jsdom has no 2D
 * context, so every path degrades to drawing nothing rather than throwing.
 */
const AgentMark: React.FC<{ agentKey: string; pulse?: number }> = ({ agentKey, pulse }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const surface = markSurface(agentKey, MARK, pulse);
    const scale = 2;
    canvas.width = MARK * scale;
    canvas.height = MARK * scale;
    const image = ctx.createImageData(MARK, MARK);
    image.data.set(surface.data);
    const off = document.createElement('canvas');
    off.width = MARK;
    off.height = MARK;
    off.getContext('2d')?.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, MARK * scale, MARK * scale);
  }, [agentKey, pulse]);
  return <canvas ref={ref} style={{ width: MARK, height: MARK, display: 'block' }} />;
};

/**
 * The window's own chrome, in the plate's four materials.
 *
 * This is the amendment to Axiom 2, made in the open: the Status Plate remains
 * the only persistent APPLICATION chrome, and window management gets a strip.
 * It replaces an OS titlebar that was already persistent and already outside
 * the design system, and it removes the floating agents indicator, which was
 * chrome over the terminal that never had an exception.
 */
export const TitleBar: React.FC<TitleBarProps> = ({
  nodes, activeSessionId, onSelectNode, title,
  onMinimize, onToggleMaximize, onClose,
}) => {
  const agents = nodes.filter((n) => !n.parked && (n.foregroundAgent || n.kind === 'agent'));

  /*
     Axiom 1: the terminal keeps the keyboard.

     tabIndex={-1} alone is not enough — a click focuses an element without
     consulting the tab order, and a focused button swallows the next keystroke
     with nothing on screen to say why. That is exactly how the pass-through
     terminal failed before it took focus on activation.
  */
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const CONTROLS: ReadonlyArray<[string, (() => void) | undefined, string]> = [
    ['−', onMinimize, 'Minimize'],
    ['□', onToggleMaximize, 'Maximize'],
    ['×', onClose, 'Close'],
  ];

  return (
    <div
      className="flex items-stretch plate select-none"
      style={{ height: BAR_H, boxShadow: 'var(--bevel-up)' }}
    >
      <div className="flex items-center gap-px pl-1">
        {agents.map((node) => (
          <button
            key={node.id}
            type="button"
            tabIndex={-1}
            data-testid="agent-mark"
            title={`${node.number ? `[${node.number}] ` : ''}${node.title}`}
            onMouseDown={keepFocus}
            onClick={() => onSelectNode(node.id)}
            className="flex items-center justify-center px-1"
            style={{
              height: BAR_H - 6,
              background: 'transparent',
              boxShadow: node.id === activeSessionId ? 'var(--bevel-dn)' : 'none',
            }}
          >
            <AgentMark
              agentKey={(node.foregroundAgent || 'agy').toLowerCase()}
              pulse={isWorking(node.id) ? pulsePhase(Date.now()) : undefined}
            />
          </button>
        ))}
      </div>

      {/* The title is the one part of a titlebar with nothing else to do, so it
          is the drag region. */}
      <div
        data-tauri-drag-region
        className="flex-1 flex items-center justify-center text-[11px] tracking-wider"
        style={{ color: 'var(--ink-plate)' }}
      >
        {title.toUpperCase()}
      </div>

      <div className="flex items-stretch">
        {CONTROLS.map(([glyph, run, label]) => (
          <button
            key={label}
            type="button"
            tabIndex={-1}
            aria-label={label}
            onMouseDown={keepFocus}
            onClick={() => run?.()}
            className="w-[34px] flex items-center justify-center text-[13px] leading-none"
            style={{ color: 'var(--ink-plate)', background: 'transparent' }}
          >
            {glyph}
          </button>
        ))}
      </div>
    </div>
  );
};
