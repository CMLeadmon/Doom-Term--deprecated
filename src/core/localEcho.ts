/**
 * Predictive local echo.
 *
 * Over SSH the round trip IS the input latency, and the only thing that touches
 * it is drawing the character before the child confirms it. The rules are VS
 * Code's, which has the field evidence: engage above 30ms, disengage on the
 * alternate screen and for full-screen editors, roll the whole ledger back on
 * any disagreement.
 *
 * ── ON AXIOM 3 ─────────────────────────────────────────────────────────────
 *
 * Painting an unconfirmed character puts something on screen the child has not
 * said, and that deserves an answer rather than a shrug. The answer is that a
 * prediction is drawn in `--st-idle` — one of the five canonical state colours,
 * already WCAG-AA guaranteed against the ground, and already meaning *not
 * settled*. A predicted cell is visibly not a confirmed one, in the vocabulary
 * the plate already uses for exactly this. A stated uncertainty is what Axiom 3
 * asks for; an unstated one would not be.
 *
 * This layer never changes what is sent. `keyToBytes` hands the child exactly
 * the bytes it always did.
 */

/** VS Code's `localEchoLatencyThreshold` default. */
export const LATENCY_THRESHOLD_MS = 30;

/** VS Code's `localEchoExcludePrograms` default. */
export const EXCLUDED_PROGRAMS: readonly string[] = ['vim', 'vi', 'nano', 'tmux'];

/** Round-trip samples kept. Enough to shrug off one slow frame. */
const SAMPLE_WINDOW = 8;

export interface EchoConditions {
  /** Measured round trip, or null when there is no measurement yet. */
  rttMs: number | null;
  altScreen: boolean;
  /** The kernel's foreground answer, or null when unknown. */
  foreground: string | null;
}

export function shouldEngage({ rttMs, altScreen, foreground }: EchoConditions): boolean {
  // No measurement is not a fast link and not a slow one. It is no answer, and
  // predicting on no answer would be inventing the reason to predict.
  if (rttMs === null) return false;
  if (altScreen) return false;
  if (foreground !== null && EXCLUDED_PROGRAMS.includes(foreground.toLowerCase())) return false;
  return rttMs > LATENCY_THRESHOLD_MS;
}

/** Keep the most recent samples, newest last. */
export function noteSample(samples: readonly number[], ms: number): number[] {
  if (!Number.isFinite(ms) || ms < 0) return [...samples];
  return [...samples, ms].slice(-SAMPLE_WINDOW);
}

/**
 * The representative round trip, or null when nothing has been measured.
 *
 * Median, not mean: one 800ms stall while a remote pages in a file should not
 * engage prediction for the next minute, and one 2ms frame should not disengage
 * it mid-sentence.
 */
export function rttOf(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The ledger after one keystroke, or null when this key is not predictable.
 *
 * Null is not a failure — it means "send it and wait", which is what the
 * terminal did for every key before this existed.
 */
export function predict(pending: readonly string[], bytes: string): string[] | null {
  if (bytes === '\x7f') {
    // Only ever erase our own. A backspace past the ledger edits a buffer we
    // cannot see, and guessing at it is how a character becomes unkillable.
    return pending.length > 0 ? pending.slice(0, -1) : null;
  }
  if (bytes.length !== 1) return null;
  const code = bytes.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) return null;
  return [...pending, bytes];
}

/**
 * The ledger after the child's own output arrives, or null to roll it all back.
 *
 * Rolling back the WHOLE ledger on one disagreement, rather than resyncing, is
 * deliberate: a partial reconciliation leaves predictions standing that are now
 * attached to the wrong column, and a wrong character drawn confidently is
 * worse than a character drawn late.
 */
export function reconcile(pending: readonly string[], confirmed: string): string[] | null {
  let i = 0;
  for (const ch of confirmed) {
    if (i >= pending.length) break;
    if (ch !== pending[i]) return null;
    i++;
  }
  return pending.slice(i);
}
