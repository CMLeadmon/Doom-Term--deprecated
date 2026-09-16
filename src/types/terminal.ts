export type CommandStatus = 'idle' | 'running' | 'completed' | 'error';

export interface AnsiSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  invert?: boolean;
}

export interface AnsiLine {
  id: string;
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
}
