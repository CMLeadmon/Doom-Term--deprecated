import { describe, expect, it } from 'vitest';
import { projectStreamRecord } from './streamProjection';
import { notificationTransition } from './sessionNotifications';
import { createDefaultWorkspace } from './sessionStore';
import type { AppliedContext } from './streamApplication';
import type { StreamRecord } from './streamProtocol';

const record: StreamRecord = { session_id: 'node-1', incarnation: '1'.repeat(32), stream_epoch: '2'.repeat(32),
  sequence: '3', observed_micros: 3000000, payload: { type: 'Event', payload: { type: 'ExecutionEnd', payload: { exit_code: 7 } } } };
const context: AppliedContext = { phase: 'catch-up', eventId: 'incarnation/stream/3', clockEpoch: '3'.repeat(32), observedMicros: 3000000,
  state: { completedCommands: 2, lastExecutionDurationMs: 1500, lastExitCode: 7, closed: false, atPrompt: true,
    cwd: '/observed', agentState: null, isTuiActive: false } };
const background = { activeSessionId: 'other', documentFocused: true };
describe('stream projection into persistent presentation', () => {
  it('restores observed counters and duration without fabricating wall-clock timestamps or replaying a notification', () => {
    const before = { ...createDefaultWorkspace().nodes['node-1'], lastExecutionStartedAt: 1234, executionSerial: 99 };
    const next = projectStreamRecord(before, record, context);
    expect(next).toMatchObject({ executionSerial: 2, lastExecutionDurationMs: 1500, lastExitCode: 7, cwd: '/observed', atPrompt: true });
    expect(next.lastExecutionStartedAt).toBeUndefined();
    expect(notificationTransition(before, next, background)).toBeNull();
  });
  it('notifies a genuinely new live completion using stable source identity, not a reconstructed counter', () => {
    const before = createDefaultWorkspace().nodes['node-1'];
    const caughtUp = projectStreamRecord(before, record, context);
    const liveRecord = { ...record, sequence: '4' };
    const next = projectStreamRecord(caughtUp, liveRecord, { ...context, phase: 'live', eventId: 'incarnation/stream/4' });
    expect(notificationTransition(caughtUp, next, background)?.key).toContain('incarnation/stream/4');
    expect(notificationTransition(next, next, background)).toBeNull();
  });
  it('clears unprovable prior-stream measurements and marks closure without counting another command', () => {
    const before = { ...createDefaultWorkspace().nodes['node-1'], lastExecutionDurationMs: 5000, executionSerial: 10, blockedOnUser: true };
    const next = projectStreamRecord(before, { ...record, payload: { type: 'Closed', payload: { exit_code: null } } }, {
      ...context, state: { ...context.state, completedCommands: null, lastExecutionDurationMs: null, lastExitCode: null, closed: true, atPrompt: false },
    });
    expect(next.executionSerial).toBeUndefined(); expect(next.lastExecutionDurationMs).toBeUndefined();
    expect(next).toMatchObject({ exited: true, blockedOnUser: false, atPrompt: false, lastExitCode: null });
  });
  it('does not issue a React state change for output that changes only the separately rendered screen', () => {
    const first = projectStreamRecord(createDefaultWorkspace().nodes['node-1'], record, context);
    expect(projectStreamRecord(first, { ...record, payload: { type: 'Event', payload: { type: 'Output', payload: { data: 'more' } } } }, context)).toBe(first);
  });
});
