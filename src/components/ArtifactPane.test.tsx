import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ArtifactPane } from './ArtifactPane';
import type { SessionNode } from '../types/sessionTree';

describe('ArtifactPane', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });
  const baseNode: SessionNode = {
    id: 'node-art-1',
    groupId: 'group-1',
    title: 'PR Walkthrough',
    number: 1,
    kind: 'artifact',
    cwd: '/projects/doom-term',
    gitBranch: 'main',
    activeBlockId: null,
    isTuiActive: false,
    agentState: 'idle',
    tuiLines: [],
    commandHistory: [],
    artifactId: 'pr-walkthrough',
    artifactTitle: 'PR Walkthrough: Auth Module',
    artifactType: 'markdown',
    artifactContent: '# Summary\nAll checks pass.\n\n> [!NOTE]\nAuth credentials refreshed.\n\n- [x] Database migration\n- [ ] Deploy rollout\n\n```ts\nconst token = "secret";\n```',
    artifactVersion: 2,
    createdAt: Date.now(),
  };

  it('renders markdown artifact with title, type, and version badges', () => {
    render(<ArtifactPane node={baseNode} />);

    expect(screen.getByText('ARTIFACT: PR Walkthrough: Auth Module')).toBeTruthy();
    expect(screen.getByText('[MARKDOWN]')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText('All checks pass.')).toBeTruthy();
    expect(screen.getByText('NOTE')).toBeTruthy();
    expect(screen.getByText('Auth credentials refreshed.')).toBeTruthy();
    expect(screen.getByText('Database migration')).toBeTruthy();
    expect(screen.getByText('Deploy rollout')).toBeTruthy();
    expect(screen.getByText('const token = "secret";')).toBeTruthy();
  });

  it('renders diff artifact with additions and deletions', () => {
    const diffNode: SessionNode = {
      ...baseNode,
      artifactTitle: 'Git Changes',
      artifactType: 'diff',
      artifactContent: 'diff --git a/src/auth.ts b/src/auth.ts\n@@ -1,3 +1,3 @@\n-const old = 1;\n+const fresh = 2;',
    };

    render(<ArtifactPane node={diffNode} />);

    expect(screen.getByText('[DIFF]')).toBeTruthy();
    expect(screen.getByText('diff --git a/src/auth.ts b/src/auth.ts')).toBeTruthy();
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeTruthy();
    expect(screen.getByText('+const fresh = 2;')).toBeTruthy();
    expect(screen.getByText('-const old = 1;')).toBeTruthy();
  });

  it('renders html artifact with external browser launcher and source preview', () => {
    const htmlNode: SessionNode = {
      ...baseNode,
      artifactTitle: 'Dashboard',
      artifactType: 'html',
      artifactContent: '<div id="app"><h1>Metrics</h1></div>',
    };

    render(<ArtifactPane node={htmlNode} />);

    expect(screen.getByText('[HTML]')).toBeTruthy();
    expect(screen.getByText('LAUNCH INTERACTIVE VIEW ↗')).toBeTruthy();
    expect(screen.getByText('<div id="app"><h1>Metrics</h1></div>')).toBeTruthy();
  });

  it('toggles between preview and raw source modes', () => {
    const onUpdate = vi.fn();
    render(<ArtifactPane node={baseNode} onUpdateContent={onUpdate} />);

    // Initially in preview mode
    expect(screen.getByText('SOURCE')).toBeTruthy();
    expect(screen.getByText('Summary')).toBeTruthy();

    // Switch to source mode
    fireEvent.click(screen.getByText('SOURCE'));
    expect(screen.getByText('RENDER')).toBeTruthy();
    const textarea = screen.getByPlaceholderText('Raw artifact content...') as HTMLTextAreaElement;
    expect(textarea.value).toContain('# Summary');

    // Edit content
    fireEvent.change(textarea, { target: { value: '# New content' } });
    expect(onUpdate).toHaveBeenCalledWith('# New content');
  });

  it('copies content and invokes close callback', () => {
    const onClose = vi.fn();
    render(<ArtifactPane node={baseNode} onClose={onClose} />);

    const copyBtn = screen.getByText('COPY');
    fireEvent.click(copyBtn);
    expect(screen.getByText('COPIED!')).toBeTruthy();

    const closeBtn = screen.getByTitle('Close artifact pane');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});
