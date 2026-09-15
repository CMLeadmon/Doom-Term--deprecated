import type { SessionNode } from '../types/sessionTree';

export interface NotificationContext {
  activeSessionId: string;
  documentFocused: boolean;
}

export interface SessionNotice {
  /** Stable transition key, also used as the native notification tag. */
  key: string;
  sessionId: string;
  title: string;
  body: string;
}

const tail = (node: SessionNode): string => {
  for (let i = node.tuiLines.length - 1; i >= 0; i--) {
    const line = node.tuiLines[i].spans.map((span) => span.text).join('').trim();
    if (line) return line.slice(0, 180);
  }
  return node.cwd;
};

/**
 * Decide whether one observed node transition deserves interruption outside
 * the terminal. It is intentionally pure: permission prompts and the platform
 * Notification object are adapter concerns, while duplicate/threshold policy
 * stays deterministic and independently reviewable.
 */
export function notificationTransition(
  previous: SessionNode,
  next: SessionNode,
  context: NotificationContext,
): SessionNotice | null {
  if (context.documentFocused && context.activeSessionId === next.id) return null;
  const prefix = `[${next.number ?? '-'}] ${next.title}`;

  if (!previous.blockedOnUser && next.blockedOnUser) {
    if (next.lastHookEventId && (!next.lastLiveAskEventId || next.lastLiveAskEventId === previous.lastLiveAskEventId)) return null;
    return {
      key: `ask:${next.id}:${next.lastHookEventId ? next.lastLiveAskEventId : next.attentionSerial ?? 0}`,
      sessionId: next.id,
      title: `${prefix} asks`,
      body: tail(next),
    };
  }

  if (next.streamObserved) {
    if (!next.lastLiveExecutionEventId || next.lastLiveExecutionEventId === previous.lastLiveExecutionEventId) return null;
  } else if ((next.executionSerial ?? 0) === (previous.executionSerial ?? 0)) return null;
  const failed = typeof next.lastExitCode === 'number' && next.lastExitCode !== 0;
  const longSuccess = next.lastExitCode === 0 && (next.lastExecutionDurationMs ?? 0) >= 10_000;
  if (!failed && !longSuccess) return null;
  return {
    key: `exit:${next.id}:${next.streamObserved ? next.lastLiveExecutionEventId : next.executionSerial ?? 0}`,
    sessionId: next.id,
    title: `${prefix} ${failed ? 'failed' : 'complete'}`,
    body: tail(next),
  };
}
