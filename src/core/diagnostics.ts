/** Derived observation of client state. Owns nothing, stores no payload bytes.
 * Event names, identities, reasons and counts only: terminal contents must
 * never reach a diagnostic surface. */
export const LEDGER_LIMIT = 512;

export type CounterName =
  | 'framesDropped' | 'unknownEvents' | 'unknownVariants' | 'reconnects'
  | 'createsAttempted' | 'createsFailed' | 'attachmentsFaulted';

const COUNTER_NAMES: readonly CounterName[] = [
  'framesDropped', 'unknownEvents', 'unknownVariants', 'reconnects',
  'createsAttempted', 'createsFailed', 'attachmentsFaulted',
];

export interface LedgerEntry {
  at: number;
  kind: 'transition' | 'event' | 'refusal';
  name: string;
  sessionId: string | null;
  requestId: string | null;
  reason: string | null;
}
export type Counters = Record<CounterName, number>;

function zeroed(): Counters {
  return Object.fromEntries(COUNTER_NAMES.map(name => [name, 0])) as Counters;
}

export class Diagnostics {
  private entries: LedgerEntry[] = [];
  private counters: Counters = zeroed();

  /** Copies only the declared fields, so a careless caller cannot widen this. */
  record(entry: Omit<LedgerEntry, 'at'>): void {
    this.entries.push({
      at: Date.now(),
      kind: entry.kind,
      name: entry.name,
      sessionId: entry.sessionId,
      requestId: entry.requestId,
      reason: entry.reason,
    });
    if (this.entries.length > LEDGER_LIMIT) this.entries.splice(0, this.entries.length - LEDGER_LIMIT);
  }

  count(name: CounterName): void { this.counters[name] += 1; }

  snapshot(): { entries: LedgerEntry[]; counters: Counters } {
    return { entries: this.entries.map(entry => ({ ...entry })), counters: { ...this.counters } };
  }

  clear(): void { this.entries = []; this.counters = zeroed(); }
}

export const diagnostics = new Diagnostics();
