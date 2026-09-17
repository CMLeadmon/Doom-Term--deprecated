import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TitleBar } from './TitleBar';
import { SessionNode } from '../types/sessionTree';

const node = (id: string, agent: string | null): SessionNode => ({
  id,
  title: `Session ${id}`,
  kind: 'terminal',
  cwd: '/',
  gitBranch: '',
  foregroundAgent: agent,
  parked: false,
} as SessionNode);

describe('TitleBar', () => {
  it('draws one mark per agent session, and no label', () => {
    render(<TitleBar nodes={[node('a', 'claude'), node('b', 'codex')]}
      activeSessionId="a" onSelectNode={() => {}} title="Doom Term" />);
    expect(screen.getAllByTestId('agent-mark')).toHaveLength(2);
    expect(screen.queryByText(/AGENTS/i)).toBeNull();
  });

  it('shows no mark for a session with no agent in the foreground', () => {
    render(<TitleBar nodes={[node('a', null)]} activeSessionId="a"
      onSelectNode={() => {}} title="Doom Term" />);
    expect(screen.queryAllByTestId('agent-mark')).toHaveLength(0);
  });

  it('shows no mark for a parked session', () => {
    const parked = { ...node('a', 'claude'), parked: true };
    render(<TitleBar nodes={[parked]} activeSessionId="a"
      onSelectNode={() => {}} title="Doom Term" />);
    expect(screen.queryAllByTestId('agent-mark')).toHaveLength(0);
  });

  it('never takes the keyboard from the terminal', () => {
    // Axiom 1. A control that can be focused is a control that swallows the
    // next keystroke, and the pane has no way to say why.
    render(<TitleBar nodes={[node('a', 'claude')]} activeSessionId="a"
      onSelectNode={() => {}} title="Doom Term" />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) {
      expect(button.getAttribute('tabindex')).toBe('-1');
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('uses only material tokens, never a literal colour', () => {
    const { container } = render(<TitleBar nodes={[]} activeSessionId={null}
      onSelectNode={() => {}} title="Doom Term" />);
    expect(container.innerHTML.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it('carries a drag region for the window', () => {
    const { container } = render(<TitleBar nodes={[]} activeSessionId={null}
      onSelectNode={() => {}} title="Doom Term" />);
    expect(container.querySelector('[data-tauri-drag-region]')).not.toBeNull();
  });

  it('draws the three window controls as Unicode glyphs, not an icon library', () => {
    render(<TitleBar nodes={[]} activeSessionId={null}
      onSelectNode={() => {}} title="Doom Term" />);
    expect(screen.getByLabelText('Minimize').textContent).toBe('−');
    expect(screen.getByLabelText('Maximize').textContent).toBe('□');
    expect(screen.getByLabelText('Close').textContent).toBe('×');
  });

  it('runs the window action its control names', () => {
    const onClose = vi.fn();
    const onMinimize = vi.fn();
    render(<TitleBar nodes={[]} activeSessionId={null} onSelectNode={() => {}}
      title="Doom Term" onClose={onClose} onMinimize={onMinimize} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Minimize'));
    expect(onMinimize).toHaveBeenCalledTimes(1);
  });

  it('does not throw when a control has no handler wired', () => {
    render(<TitleBar nodes={[]} activeSessionId={null}
      onSelectNode={() => {}} title="Doom Term" />);
    expect(() => fireEvent.click(screen.getByLabelText('Close'))).not.toThrow();
  });

  it('selects the session whose mark was clicked', () => {
    const onSelectNode = vi.fn();
    render(<TitleBar nodes={[node('a', 'claude')]} activeSessionId={null}
      onSelectNode={onSelectNode} title="Doom Term" />);
    fireEvent.click(screen.getAllByTestId('agent-mark')[0]);
    expect(onSelectNode).toHaveBeenCalledWith('a');
  });
});
