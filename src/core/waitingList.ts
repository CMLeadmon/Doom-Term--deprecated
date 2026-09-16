import type { SessionNode } from '../types/sessionTree';
import type { WaitingRow, WaitingStatus } from '../hud/state';

export interface ActivityProbe {
  /** Is output arriving continuously enough to call this work? */
  isBusy(id: string): boolean;
  /** When this session last emitted, or undefined if it never has. */
  lastOutputAt(id: string): number | undefined;
}

export interface AttentionProbe {
  isAcknowledged(id: string, blockedOnUser: boolean): boolean;
}

/**
 * Four characters of vendor, for the slot the elapsed timer used to hold.
 *
 * The keys are the kernel's (foreground.rs classify_agent), so this table can
 * only ever be BEHIND the kernel, never ahead of it. That asymmetry decides the
 * fallback: an unmapped key is a real agent we have not caught up with, so it
 * prints its own first four characters. Calling it SH would claim it is a plain
 * shell, and a shell is exactly what it is not.
 */
const VENDOR_TAGS: Record<string, string> = {
  claude: 'CLAU',
  codex: 'CODX',
  gemini: 'GEMI',
  antigravity: 'AGY',
  aider: 'AIDR',
  opencode: 'OPCD',
  grok: 'GROK',
  copilot: 'CPLT',
};

/** A bare shell holds its own foreground. Honest, and not an agent. */
const SHELL_TAG = 'SH';

/**
 * The tag a row prints, guaranteed to be four renderable characters or fewer.
 *
 * FONT_SM answers an unknown character with a blank, so an unsanitised key
 * would paint an empty slot that reads as "no agent" — the one thing it is
 * not. Stripping to the alphabet the font actually has keeps the failure
 * visible as text rather than silent as whitespace.
 */
export function vendorTag(agent: string | null | undefined): string {
  if (!agent) return SHELL_TAG;
  const mapped = VENDOR_TAGS[agent];
  if (mapped) return mapped;
  const printable = agent.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return printable.slice(0, 4) || SHELL_TAG;
}

/**
 * What this row is telling you, from signals we actually hold.
 *
 * Ordered by how much the operator is owed. A live question outranks a dead
 * process: `blockedOnUser` is the agent's own word that it is stuck on YOU
 * right now, while a non-zero exit code is history that has already happened
 * and will still be there after you answer.
 */
function statusOf(n: SessionNode, working: boolean): WaitingStatus {
  if (working) return 'working';
  if (n.blockedOnUser) return 'asks';
  if (typeof n.lastExitCode === 'number' && n.lastExitCode !== 0) return 'failed';
  return 'quiet';
}

/**
 * How much a waiting row is owed, most first.
 *
 * A live question beats a dead process beats mere silence. `working` is listed
 * for completeness but never sorted through here — working rows are a separate
 * partition appended afterwards.
 */
const RANK: Record<WaitingStatus, number> = { asks: 0, failed: 1, quiet: 2, working: 3 };

/** A working session with no slot key sorts last, not first. NaN would do neither. */
const SLOT_LAST = 99;

/**
 * The sessions that have stopped and want you, then the ones still working.
 *
 * Three exclusions, each load-bearing:
 *
 *  - the session on screen, because you are already looking at it;
 *  - anything that has never emitted, because it has not started — which is
 *    not the same as having stopped, and claiming otherwise would put every
 *    freshly opened terminal into the list;
 *  - scratchpads, which have no process to be waiting on.
 *
 * A session that merely went quiet IS the signal: from a terminal, an agent
 * waiting on its provider and an agent waiting on you are indistinguishable,
 * and guessing between them would be inventing state. The honest report is
 * that it stopped, which is what `quiet` says and all it says.
 *
 * Working sessions are APPENDED, never interleaved. They are not asking for
 * anything, so they may only ever occupy row slots that nothing waiting wanted
 * — and they sort by slot number rather than by recency, because a row that
 * reorders itself as output arrives is movement, and on this plate movement
 * means something. The caller draws as many rows as it has room for; the
 * partition guarantees it never spends that room on a working session while a
 * waiting one goes unshown.
 *
 * No clock reaches this function. The elapsed timers are gone, so a row's
 * content changes only when the session's own state does.
 */
export function buildWaitingList(
  nodes: SessionNode[],
  activeId: string,
  probe: ActivityProbe,
  attention?: AttentionProbe,
): WaitingRow[] {
  const toRow = (n: SessionNode, working: boolean): WaitingRow => ({
    sessionId: n.id,
    // A session past the ninth slot has no key of its own; a dash says so
    // rather than printing "null" at you.
    n: n.number === null ? '-' : String(n.number),
    name: n.title,
    status: statusOf(n, working),
    tag: vendorTag(n.foregroundAgent),
  });

  const candidates = nodes
    .filter((n) => n.id !== activeId)
    .filter((n) => n.kind !== 'scratchpad' && n.kind !== 'artifact')
    .filter((n) => probe.lastOutputAt(n.id) !== undefined);

  const waiting = candidates
    .filter((n) => !probe.isBusy(n.id))
    // A vendor question is cleared only by the vendor's Stop hook. Even an
    // over-broad/custom acknowledgement probe must not hide it.
    .filter((n) => !!n.blockedOnUser || !attention?.isAcknowledged(n.id, false))
    .map((n) => toRow(n, false))
    .sort((a, b) => {
      if (RANK[a.status] !== RANK[b.status]) return RANK[a.status] - RANK[b.status];
      return (probe.lastOutputAt(a.sessionId) ?? 0) - (probe.lastOutputAt(b.sessionId) ?? 0);
    });

  // Acknowledgement settles a request for attention, and a working session is
  // not making one — so it is deliberately not consulted here.
  const working = candidates
    .filter((n) => probe.isBusy(n.id))
    .map((n) => toRow(n, true))
    .sort((a, b) => (Number(a.n) || SLOT_LAST) - (Number(b.n) || SLOT_LAST));

  return [...waiting, ...working];
}
