import { describe, expect, it } from 'vitest';
import { Diagnostics, LEDGER_LIMIT } from './diagnostics';

describe('Diagnostics', () => {
  it('records entries in order with a timestamp', () => {
    const ledger = new Diagnostics();
    ledger.record({ kind: 'event', name: 'StreamRecord', sessionId: 'node-1', requestId: null, reason: null });
    const { entries } = ledger.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('StreamRecord');
    expect(entries[0].sessionId).toBe('node-1');
    expect(typeof entries[0].at).toBe('number');
  });

  it('bounds the ring at LEDGER_LIMIT, discarding oldest first', () => {
    const ledger = new Diagnostics();
    for (let i = 0; i < LEDGER_LIMIT + 10; i++) {
      ledger.record({ kind: 'event', name: `E${i}`, sessionId: null, requestId: null, reason: null });
    }
    const { entries } = ledger.snapshot();
    expect(entries).toHaveLength(LEDGER_LIMIT);
    expect(entries[0].name).toBe('E10');
    expect(entries[entries.length - 1].name).toBe(`E${LEDGER_LIMIT + 9}`);
  });

  it('counts named counters from zero', () => {
    const ledger = new Diagnostics();
    expect(ledger.snapshot().counters.unknownVariants).toBe(0);
    ledger.count('unknownVariants');
    ledger.count('unknownVariants');
    expect(ledger.snapshot().counters.unknownVariants).toBe(2);
  });

  it('returns a snapshot that later writes cannot mutate', () => {
    const ledger = new Diagnostics();
    ledger.record({ kind: 'event', name: 'First', sessionId: null, requestId: null, reason: null });
    const first = ledger.snapshot();
    ledger.record({ kind: 'event', name: 'Second', sessionId: null, requestId: null, reason: null });
    expect(first.entries).toHaveLength(1);
    expect(first.counters.reconnects).toBe(0);
  });

  it('never stores payload bytes: only declared fields survive', () => {
    const ledger = new Diagnostics();
    ledger.record({
      kind: 'event', name: 'Output', sessionId: 'node-1', requestId: null, reason: null,
      data: 'SECRET_TERMINAL_CONTENTS',
    } as never);
    expect(JSON.stringify(ledger.snapshot())).not.toContain('SECRET_TERMINAL_CONTENTS');
  });
});
