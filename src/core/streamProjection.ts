import type { SessionNode } from '../types/sessionTree';
import type { StreamRecord } from './streamProtocol';
import type { AppliedContext } from './streamApplication';
export function projectStreamRecord(node: SessionNode, record: StreamRecord, context: AppliedContext): SessionNode {
  const state = context.state;
  const liveEnd = context.phase === 'live' && record.payload.type === 'Event' && record.payload.payload.type === 'ExecutionEnd';
  const knownAgent = ['idle', 'running', 'waiting_input', 'verifying', 'errored'].includes(state.agentState ?? '');
  const patch: Partial<SessionNode> = {
    incarnation: record.incarnation,
    streamObserved: true,
    executionSerial: state.completedCommands ?? undefined,
    lastExitCode: state.lastExitCode,
    lastExecutionDurationMs: state.lastExecutionDurationMs ?? undefined,
    lastExecutionStartedAt: undefined,
    atPrompt: state.atPrompt ?? undefined,
    cwd: state.cwd ?? node.cwd,
    agentState: knownAgent ? state.agentState as SessionNode['agentState'] : 'unknown',
    isTuiActive: state.isTuiActive ?? node.isTuiActive,
    exited: state.closed,
    blockedOnUser: state.closed ? false : node.blockedOnUser,
    lastLiveExecutionEventId: liveEnd ? context.eventId : node.lastLiveExecutionEventId,
  };
  // Output has its own coalesced screen notification. Do not turn every byte
  // record into a React update (and a reset of the persistence debounce).
  if (Object.entries(patch).every(([key, value]) => node[key as keyof SessionNode] === value)) return node;
  return { ...node, ...patch };
}
