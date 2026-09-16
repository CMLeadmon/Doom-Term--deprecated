import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePtyEvents } from './usePtyEvents';
import { getEmulator, resetAllEmulators, onScreenParsed } from '../core/emulatorRegistry';
import type { ProjectWorkspace, SessionNode } from '../types/sessionTree';

/**
 * The caret and the lines are ONE observation.
 *
 * `cursor.row` is an index into the array `getLines()` returned, so anything
 * that reads them at two different times describes two different buffers. The
 * screen handler used to read the lines in the parsed callback and the caret
 * inside the `setWorkspace` updater — and a state updater does not run in the
 * calling tick. React runs it during the next render, and is free to run it
 * again. Output kept arriving in between, so the caret came from a buffer that
 * had scrolled past the captured lines and `baseY + cursorY` pointed at a row
 * that, in those lines, held something else. On screen that is the caret
 * flashing to a random row for one frame while output streams.
 */

const node = (over: Partial<SessionNode> = {}): SessionNode => ({
  id: 'n1', groupId: 'g', title: 'T', number: 1, kind: 'terminal', cwd: '/x',
  gitBranch: '', activeBlockId: null, isTuiActive: false, agentState: 'idle',
  tuiLines: [], commandHistory: [], createdAt: 0, ...over,
});

const workspace = (): ProjectWorkspace => ({
  id: 'w', name: 'W', rootPath: '/x', activeGroupId: 'g',
  groups: [{ id: 'g', projectId: 'w', name: 'Main', layout: 'single',
    activeNodeId: 'n1', nodeIds: ['n1'], createdAt: 0 }],
  nodes: { n1: node() },
});

/** Resolves once the emulator has published a frame. */
function nextFrame(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const stop = onScreenParsed((id) => { if (id === sessionId) { stop(); resolve(); } });
  });
}

afterEach(() => { resetAllEmulators(); });

describe('screen frame capture', () => {
  it('pairs the caret with the lines it indexes, not with a later buffer', async () => {
    // The updaters React would have run later. Collected, never applied yet —
    // which is exactly the window the old shape read the caret in.
    const deferred: Array<(prev: ProjectWorkspace) => ProjectWorkspace> = [];
    const { unmount } = renderHook(() =>
      usePtyEvents(
        (updater) => { deferred.push(updater); },
        () => undefined,
      ));

    const emu = getEmulator('n1');
    emu.resize(20, 4);

    const settled = nextFrame('n1');
    emu.write('one\r\ntwo\r\nthree');
    await settled;

    const linesAtFrame = emu.getLines().length;
    const cursorAtFrame = emu.getCursor().row;
    expect(deferred.length).toBeGreaterThan(0);
    // Only the updaters this frame produced. They are what React still owes.
    const owed = deferred.splice(0, deferred.length);

    // More output lands before React gets round to the updater. The buffer
    // scrolls; the caret moves with it; the captured lines do not.
    const scrolled = nextFrame('n1');
    emu.write('\r\n' + Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\r\n'));
    await scrolled;
    expect(emu.getCursor().row).not.toBe(cursorAtFrame);

    const updated = owed.reduce((state, updater) => updater(state), workspace());
    const target = updated.nodes.n1;

    expect(target.cursor?.row).toBe(cursorAtFrame);
    expect(target.tuiLines.length).toBe(linesAtFrame);
    // And the caret still indexes the lines it was captured with.
    expect(target.cursor!.row).toBeLessThan(target.tuiLines.length);

    unmount();
  });
});
