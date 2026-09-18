import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { BINDINGS, VIEW_BINDINGS } from '../core/keymap';
import { buildPaletteActions } from '../core/paletteActions';
import { CommandPalette } from './CommandPalette';
import { CloseSessionPrompt } from './CloseSessionPrompt';
import { PermissionModeModal } from './PermissionModeModal';
import { RenameSessionModal } from './RenameSessionModal';
import { SessionNode, SessionGroup } from '../types/sessionTree';

describe('Frontend Visual & Design Invariants', () => {
  it('strictly forbids soft shadows, CSS blur filters, and border radius in all src components', () => {
    const srcDir = path.resolve(__dirname, '..');
    const files: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          (entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx')) &&
          !entry.name.includes('.test.')
        ) {
          files.push(full);
        }
      }
    }
    walk(srcDir);

    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(srcDir, file);

      // Forbidden soft shadows: class names with shadow-sm/md/lg/xl/2xl/inner
      if (/\bshadow-(sm|md|lg|xl|2xl|inner)\b/.test(content)) {
        violations.push(`${rel} contains soft shadow utility`);
      }
      // Forbidden blur filters: class names with backdrop-blur
      if (/\bbackdrop-blur\b/.test(content)) {
        violations.push(`${rel} contains backdrop-blur filter`);
      }
      // Forbidden rounded corners: class names with rounded
      if (/\brounded(-\w+)?\b/.test(content)) {
        violations.push(`${rel} contains rounded corner utility`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('guarantees keymap chord labels never wrap or collide with description column', () => {
    const allBindings = [...BINDINGS, ...VIEW_BINDINGS];
    for (const b of allBindings) {
      // The grid column is 20ch; labels must comfortably fit under 20 characters
      expect(
        b.label.length,
        `Chord label "${b.label}" (${b.label.length} chars) must fit in 20ch column`,
      ).toBeLessThan(20);
    }
  });

  it('ensures Command Palette passes clean rawTitle and distinguishes attention types', () => {
    const mockGroup: SessionGroup = {
      id: 'g1',
      projectId: 'proj1',
      name: 'Group 1',
      layout: 'single',
      activeNodeId: 'n1',
      nodeIds: ['n1', 'n2', 'n3'],
      createdAt: 1000,
    };

    const mockNodes: SessionNode[] = [
      {
        id: 'n1',
        groupId: 'g1',
        title: 'CLEADMON',
        number: 1,
        kind: 'agent',
        cwd: '/test',
        gitBranch: 'main',
        activeBlockId: null,
        isTuiActive: false,
        agentState: 'idle',
        blockedOnUser: true, // Needs ASKS badge
        tuiLines: [],
        commandHistory: [],
        createdAt: 1000,
      },
      {
        id: 'n2',
        groupId: 'g1',
        title: 'BUILD_TASK',
        number: 2,
        kind: 'terminal',
        cwd: '/test',
        gitBranch: 'main',
        activeBlockId: null,
        isTuiActive: false,
        agentState: 'idle',
        lastExitCode: 1, // Non-zero exit code: Needs FAIL badge
        tuiLines: [],
        commandHistory: [],
        createdAt: 1000,
      },
      {
        id: 'n3',
        groupId: 'g1',
        title: 'BACKGROUND_JOB',
        number: 3,
        kind: 'terminal',
        cwd: '/test',
        gitBranch: 'main',
        activeBlockId: null,
        isTuiActive: false,
        agentState: 'idle',
        tuiLines: [],
        commandHistory: [],
        createdAt: 1000,
      },
    ];

    const actions = buildPaletteActions({
      activeGroup: mockGroup,
      activeNode: mockNodes[0],
      workspaceName: 'TestWorkspace',
      nodes: mockNodes,
      attention: {
        isAcknowledged: (id) => id !== 'n3', // n3 has unread output
      },
      setIsWorkspaceModalOpen: () => {},
      onCreateNode: () => {},
      onRenameNode: () => {},
      onSetGroupLayout: () => {},
      onEqualizePanes: () => {},
      onSelectNode: () => {},
      onViewAction: () => {},
    });

    const session1 = actions.find((a) => a.id === 'goto-n1');
    expect(session1).toBeDefined();
    // Raw title must be preserved cleanly without slot number or compound tags
    expect(session1?.rawTitle).toBe('CLEADMON');
    // Title must NOT have redundant "· ASKS"
    expect(session1?.title).not.toContain('ASKS');
    // Attention type must be specifically 'asks'
    expect(session1?.attentionType).toBe('asks');

    const session2 = actions.find((a) => a.id === 'goto-n2');
    expect(session2?.attentionType).toBe('fail');

    const session3 = actions.find((a) => a.id === 'goto-n3');
    expect(session3?.attentionType).toBe('unread');

    // Render palette and verify semantic badge rendering
    render(
      <CommandPalette
        isOpen={true}
        onClose={() => {}}
        actions={actions}
      />,
    );

    expect(screen.getByText('ASKS')).toBeDefined();
    expect(screen.getByText('FAIL')).toBeDefined();
    expect(screen.getByText('UNREAD')).toBeDefined();
  });

  it('renders CloseSessionPrompt with high-contrast buttons and valid warning tokens', () => {
    render(
      <CloseSessionPrompt
        title="Active Shell"
        durable={false}
        onPark={() => {}}
        onKill={() => {}}
        onCancel={() => {}}
      />,
    );

    const warning = screen.getByText('PARK SURVIVES ONLY WHILE THIS DAEMON RUNS.');
    expect(warning.style.color).toBe('var(--st-live)');

    const footer = screen.getByText('ENTER CONFIRMS · ESC CANCELS');
    expect(footer.style.color).toBe('var(--ink-plate)');
  });

  it('renders PermissionModeModal with high-contrast footer and recessed dismiss button', () => {
    render(
      <PermissionModeModal
        isOpen={true}
        currentMode="manual"
        onSelectMode={() => {}}
        onClose={() => {}}
      />,
    );

    const footerHint = screen.getByText('USE ↑/↓ TO NAVIGATE · ENTER TO APPLY');
    expect(footerHint.parentElement?.style.color).toBe('var(--ink-plate)');

    const dismissBtn = screen.getByText('DISMISS');
    expect(dismissBtn.className).toContain('recess');
  });

  it('renders RenameSessionModal with high-contrast cancel and save buttons', () => {
    render(
      <RenameSessionModal
        isOpen={true}
        initialTitle="Test Terminal"
        sessionNumber={1}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );

    const cancelBtn = screen.getByText('CANCEL');
    expect(cancelBtn.className).toContain('recess');

    const saveBtn = screen.getByText('SAVE [ENTER]');
    expect(saveBtn.className).toContain('bev-up');
  });
});
