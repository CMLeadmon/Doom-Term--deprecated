import type { SessionNode } from '../types/sessionTree';

export type CloseDisposition = 'kill' | 'confirm';

/**
 * Only an observed, idle shell is cheap enough to close immediately.
 * Unknown state is live state for safety: OSC 133 may not be installed, and a
 * terminal manager must never turn missing telemetry into process loss.
 */
export function closeDisposition(node: SessionNode, _durable = true): CloseDisposition {
  if (node.kind === 'scratchpad' || node.kind === 'artifact') return 'kill';
  const idleShell = node.atPrompt === true
    && !node.foregroundAgent
    && !node.isTuiActive
    && !node.lastExecutionStartedAt
    && node.agentState === 'idle';
  return idleShell ? 'kill' : 'confirm';
}
