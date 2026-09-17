export interface PlateSpec {
  width: number;
  height: number;
  valueChars: number;
  zoneX: number;
  zoneW: number;
  sandboxX?: number;
  cardsX?: number;
  [key: string]: unknown;
}

export interface PlateRenderResult {
  w: number;
  h: number;
  data: Uint8Array;
}

export const PLATE_480: PlateSpec;
/** Rows on offer when the zone is wide enough for both columns. */
export const WAITING_ROWS: number;
export const WAITING_ROWS_PER_COL: number;
export const WAITING_ROWS_MIN_W: number;
export const WAITING_MIN_W: number;
export const WAITING_COL_MIN_W: number;

/** Where one waiting row was painted, and how much name it can hold. */
export interface WaitingRowBox {
  /** Left edge of the row's own column. */
  x: number;
  y: number;
  /** The column's width. A row may never draw outside x..x+w-1. */
  w: number;
  /** Where the name starts: past the slot number and the status glyph. */
  nameX: number;
  /** Characters of name this row can honestly show. Never below three. */
  nameRoom: number;
  /** Right edge, where the vendor tag is right-aligned. */
  tagX: number;
}

/**
 * Where row `index` was painted, or null if it was not. The renderer and the
 * hit test share this so a row cannot be clickable where nothing was drawn.
 */
export function waitingRowBox(
  spec: PlateSpec,
  index: number,
  tag: string,
): WaitingRowBox | null;

/** How many columns of rows the zone can hold: 0, 1 or 2. */
export function waitingColumns(spec: PlateSpec): number;

/** How many of these rows are actually asking for you (working rows are not). */
export function waitingCount(rows: { status?: string }[]): number;

/** Column geometry for a plate of any width. plateSpec(480) === PLATE_480. */
export function plateSpec(width: number): PlateSpec;

export function renderPlate(
  state: Record<string, unknown>,
  scale?: number,
  spec?: PlateSpec,
): PlateRenderResult;

export function truncateLeft(str: string, maxLen: number): string;

/** One colour per agent key. Missing keys fall back to the plate's tan. */
export const AGENT_COLORS: Record<string, string>;

export interface MarkTones {
  core: number[];
  dim: number[];
  ring: { phase: number; base: string } | null;
}

/** The mark's colour ladder for one phase. `pulse === undefined` = halted. */
export function markTones(agentKey: string, pulse?: number): MarkTones;

export function mix(from: string | number[], to: string | number[], t: number): number[];

/**
 * Draw one agent's mark, centred on (cx, cy). The single place that answers
 * what an agent looks like; see `agentMark.d.ts` for the DOM-facing wrapper.
 */
export function drawAgentMark(
  s: PlateRenderResult,
  agentKey: string,
  cx: number,
  cy: number,
  pulse?: number,
): PlateRenderResult;
