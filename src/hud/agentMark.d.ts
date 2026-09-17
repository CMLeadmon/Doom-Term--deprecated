import type { PlateRenderResult } from './plate';

export function markSurface(agentKey: string, size: number, pulse?: number): PlateRenderResult;

export function drawAgentMark(
  s: PlateRenderResult,
  agentKey: string,
  cx: number,
  cy: number,
  pulse?: number,
): PlateRenderResult;

export const AGENT_COLORS: Record<string, string>;
export const MARKS: Record<string, unknown>;
