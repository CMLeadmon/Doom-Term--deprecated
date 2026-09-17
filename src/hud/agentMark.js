import { drawAgentMark, Surface, AGENT_COLORS, MARKS } from './plate.js';

/**
 * One agent's mark on a surface of its own, for a DOM component to paint.
 *
 * A thin wrapper over the plate's own renderer rather than a second
 * implementation: the title bar and the plate must not be able to disagree
 * about what an agent looks like. They used to — `AgentQueueIndicator` carried
 * a private colour table whose values differed from `plate.js`'s, and drew
 * hand-rolled SVG paths instead of the canonical bitmaps.
 *
 * `pulse` is a phase 0..1 while the agent is working, and `undefined` when it
 * has halted, so a still mark is a stopped agent.
 */
export function markSurface(agentKey, size, pulse) {
  const surface = Surface(size, size);
  return drawAgentMark(surface, agentKey, size / 2, size / 2, pulse);
}

export { drawAgentMark, AGENT_COLORS, MARKS };
