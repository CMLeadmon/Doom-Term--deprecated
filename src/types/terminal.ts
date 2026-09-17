export type CommandStatus = 'idle' | 'running' | 'completed' | 'error';

export interface AnsiSpan {
  text: string;
  /**
   * Terminal columns this run occupies, as the emulator counted them.
   *
   * Carried so the view can put the run on the grid instead of hoping the
   * browser's text layout lands there. `letter-spacing` reconciles the two
   * only while every glyph advances by the base amount: a double-width
   * character advances by its own width (measured 13px against a 16px
   * two-cell allotment) and a character resolved from a FALLBACK font in the
   * stack advances by that font's amount (measured 7.81px against an 8px
   * cell). Either one shifts the whole rest of the line, which is how the
   * caret ends up sitting on a neighbouring character.
   */
  cols?: number;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  invert?: boolean;
}

/**
 * Where the caret is, in the coordinates `getLines()` returns.
 *
 * One shape, exported, because the view, the node and the screen interface all
 * need it and three hand-copied literals is how they drift apart.
 */
export interface ScreenCursor {
  /**
   * Absolute line number since the session began, monotonic across trimming —
   * the same space as `AnsiLine.row`, which is what this is compared against.
   *
   * NOT an index into the lines array, and it never was: `getCursor()` has
   * always returned `baseY + cursorY`. The comment that said otherwise was
   * wrong for as long as it existed.
   */
  row: number;
  /** Column, in cells. */
  col: number;
  /** Absent means visible; DECTCEM can turn it off. */
  visible?: boolean;
  /**
   * The character the caret is sitting on, read from the cell itself.
   *
   * A block caret is REVERSE VIDEO, so the view has to repaint that character
   * in the ground colour on top of the block. It cannot work the character out
   * from the spans without a width table of its own, and the emulator already
   * has one.
   */
  glyph?: string;
  /** Cells the caret covers: 2 over a double-width character, otherwise 1. */
  cells?: number;
}

export interface AnsiLine {
  /** `L<row>`. Stable for the life of the line; see `row`. */
  id: string;
  /**
   * Absolute line number since the session began, counting lines already
   * trimmed out of scrollback. Fixed for the life of the line, which is what
   * makes it usable as a React key and as a reader's scroll anchor.
   *
   * Distinct from the `data-terminal-line` DOM attribute and from
   * `scrollback.ts`'s `line`/`total`, which are both array indices.
   */
  row?: number;
  spans: AnsiSpan[];
  isError?: boolean;
  timestamp: number;
  isWrapped?: boolean;
}

export interface ImmutableSnapshot {
  id: string;
  lines: AnsiLine[];
  exitCode: number | null;
  durationMs: number;
  completedAt: number;
  totalLines: number;
}

export interface ToolCall {
  verb: 'READ' | 'EDIT' | 'GREP' | 'SHELL' | 'WEB';
  target: string;
  result?: string;
  added?: number;
  removed?: number;
  live?: boolean;
}

export interface DiffLine {
  n: number;
  sign: ' ' | '+' | '-';
  text: string;
}

export interface DiffContent {
  file: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export interface TerminalBlock {
  id: string;
  command: string;
  status: CommandStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  gitBranch?: string;
  currentDir?: string;
  liveLines: AnsiLine[];
  /** Index into the session emulator's scrollback where this block's output begins. */
  outputMark?: number;
  snapshot?: ImmutableSnapshot;
  isTuiSession?: boolean;
  pinned?: boolean;
  collapsed?: boolean;
  aiExplanation?: string;
  toolCalls?: ToolCall[];
  diffContent?: DiffContent;
}

export interface SessionTab {
  id: string;
  title: string;
  cwd: string;
  gitBranch: string;
  activeBlockId: string | null;
  isTuiActive: boolean;
  /** Drives the tab's state dot — one colour per state, never identity. */
  agentState?: 'idle' | 'running' | 'waiting_input' | 'verifying' | 'errored';
  lastExitCode?: number | null;
  blocks: TerminalBlock[];
  tuiLines: AnsiLine[];
  commandHistory: string[];
  createdAt: number;
}

export type InputMode = 'editor' | 'raw';

export interface SystemTelemetryData {
  /**
   * Which session this describes, echoed by the daemon from the request.
   * A reply that arrives after a tab switch belongs to the session that asked,
   * not the one now on screen.
   */
  session_id?: string | null;
  /** Exact process identity; delayed replies cannot describe its replacement. */
  incarnation?: string | null;
  username: string;
  hostname: string;
  current_dir: string;
  git_branch: string | null;
  /**
   * Observed from the container state and the repository, never assumed.
   * 'worktree' is reported for a Git worktree checkout at any depth.
   */
  isolation: 'sandbox' | 'worktree' | 'host';
  /** The kernel's answer to what is in the terminal's foreground, or null. */
  agent_key: string | null;
  agent_name: string | null;
  /**
   * Fraction 0..1 of the account's binding rate limit that is used, from the
   * provider's own quota endpoint. `null` when unknown — the plate shows '--'.
   */
  rate_used?: number | null;
  /**
   * Fraction 0..1 of the agent's context window that is filled, or null when
   * unknown. Unrelated to rate_used — that is the account's rate limit, this
   * is one session's window. Null renders '--'; it must not become 0.
   */
  context_used?: number | null;
  /** The model the agent is running, read from its transcript. Never inferred. */
  agent_model?: string | null;
  /**
   * What a shell on the far end of a transport reported, or null when the
   * session is local.
   *
   * Its presence changes how every sibling field must be read: a remote
   * session's unreported branch is unknown, never this machine's own.
   */
  remote?: RemoteEnrichment | null;
}

/** The far end's own answers. Every field optional; absent means unknown. */
export interface RemoteEnrichment {
  host?: string | null;
  user?: string | null;
  shell?: string | null;
  cwd?: string | null;
  branch?: string | null;
  agent?: string | null;
  busy?: boolean | null;
}
