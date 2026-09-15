import { describe, expect, it } from 'vitest';
import type { SessionNode } from '../types/sessionTree';
import { notificationTransition } from './sessionNotifications';

const node = (over: Partial<SessionNode> = {}): SessionNode => ({
  id: 'n1', groupId: 'g', title: 'BUILD', number: 1, kind: 'terminal', cwd: '/x',
  gitBranch: '', activeBlockId: null, isTuiActive: false, agentState: 'idle',
  tuiLines: [{ id: '1', spans: [{ text: 'finished compile' }], isError: false, timestamp: 0 }],
  commandHistory: [], createdAt: 0, ...over,
});

const background = { activeSessionId: 'other', documentFocused: true };

describe('notificationTransition', () => {
  it('restores an ask without a new notification, then uses the live source identity', () => {
    const before = node({ blockedOnUser: false });
    const restored = node({ blockedOnUser: true, lastHookEventId: 'restored', attentionSerial: 4 });
    expect(notificationTransition(before, restored, background)).toBeNull();
    const live = node({ blockedOnUser: true, lastHookEventId: 'live', lastLiveAskEventId: 'live', attentionSerial: 5 });
    expect(notificationTransition(before, live, background)).toMatchObject({ key: 'ask:n1:live' });
  });
  it('routes a new background question to the exact session', () => {
    const notice = notificationTransition(
      node({ blockedOnUser: false, attentionSerial: 0 }),
      node({ blockedOnUser: true, attentionSerial: 1 }),
      background,
    );
    expect(notice).toEqual({
      key: 'ask:n1:1', sessionId: 'n1', title: '[1] BUILD asks', body: 'finished compile',
    });
  });

  it('suppresses every notice for the visible session while the document is focused', () => {
    const notice = notificationTransition(
      node({ blockedOnUser: false }),
      node({ blockedOnUser: true, attentionSerial: 1 }),
      { activeSessionId: 'n1', documentFocused: true },
    );
    expect(notice).toBeNull();
  });

  it('reports a new non-zero exit without requiring a duration', () => {
    const notice = notificationTransition(
      node({ executionSerial: 1 }),
      node({ executionSerial: 2, lastExitCode: 7, lastExecutionDurationMs: 20 }),
      background,
    );
    expect(notice).toMatchObject({ key: 'exit:n1:2', title: '[1] BUILD failed', sessionId: 'n1' });
  });

  it('reports a successful command only after ten seconds', () => {
    expect(notificationTransition(
      node({ executionSerial: 1 }),
      node({ executionSerial: 2, lastExitCode: 0, lastExecutionDurationMs: 9_999 }),
      background,
    )).toBeNull();
    expect(notificationTransition(
      node({ executionSerial: 1 }),
      node({ executionSerial: 2, lastExitCode: 0, lastExecutionDurationMs: 10_000 }),
      background,
    )).toMatchObject({ key: 'exit:n1:2', title: '[1] BUILD complete' });
  });

  it('does not repeat an unchanged transition', () => {
    const unchanged = node({ blockedOnUser: true, attentionSerial: 2, executionSerial: 3 });
    expect(notificationTransition(unchanged, unchanged, background)).toBeNull();
  });
});
