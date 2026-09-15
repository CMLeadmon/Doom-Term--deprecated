import { describe, expect, it } from 'vitest';
import { parseSequence, parseStreamDescriptor, parseStreamRecord } from './streamProtocol';

const identity = '0123456789abcdef0123456789abcdef';
const record = (sequence: unknown = '1', payload: unknown = { type: 'Event', payload: { type: 'Output', payload: { data: '三' } } }) => ({
  session_id: 'pane', incarnation: identity, stream_epoch: identity,
  sequence, observed_micros: 0, payload,
});

describe('v2 stream validation', () => {
  it('recognizes display-adapter loss as a rendering fault, not a process exit', () => {
    const fault = record('1', { type: 'Fault', payload: { reason: 'AdapterLost' } });
    expect(parseStreamRecord(fault)).toEqual(fault);
  });
  it('preserves exact u64 cursors beyond JavaScript number precision', () => {
    expect(parseSequence('9007199254740993')).toBe(9007199254740993n);
    expect(parseSequence('18446744073709551615')).toBe(18446744073709551615n);
    for (const bad of [1, -1, null, '', '01', '+1', ' 1', '1e3', '1.0', '18446744073709551616']) {
      expect(() => parseSequence(bad)).toThrow();
    }
  });

  it('rejects malformed identities, sizes, timestamps, event shapes and oversized records', () => {
    const descriptor = { session_id: 'pane', incarnation: identity, stream_epoch: identity,
      clock_epoch: identity, initial_cols: 80, initial_rows: 24, durable: true };
    expect(parseStreamDescriptor(descriptor)).toEqual(descriptor);
    for (const patch of [{ incarnation: 'invented' }, { initial_cols: 0 }, { initial_rows: 1.5 }, { durable: 1 }]) {
      expect(() => parseStreamDescriptor({ ...descriptor, ...patch })).toThrow();
    }
    expect(parseStreamRecord(record()).payload).toEqual({ type: 'Event', payload: { type: 'Output', payload: { data: '三' } } });
    for (const bad of [record('0'), { ...record(), observed_micros: -1 }, { ...record(), incarnation: 'F'.repeat(32) },
      record('1', { type: 'Resize', payload: { cols: 0, rows: 24 } }),
      record('1', { type: 'Event', payload: { type: 'ExecutionEnd', payload: { exit_code: '0' } } }),
      record('1', { type: 'Event', payload: { type: 'Output', payload: { data: 'x'.repeat(65536) } } }),
      record('1', { type: 'Invented' }),
    ]) expect(() => parseStreamRecord(bad)).toThrow();
  });

  it('charges the complete serialized record, including its identity envelope, to the byte limit', () => {
    const empty = record('1', { type: 'Event', payload: { type: 'Output', payload: { data: '' } } });
    const overhead = new TextEncoder().encode(JSON.stringify(empty)).length;
    const atLimit = record('1', { type: 'Event', payload: { type: 'Output', payload: { data: 'x'.repeat(65536 - overhead) } } });
    expect(parseStreamRecord(atLimit)).toEqual(atLimit);
    const overLimit = record('1', { type: 'Event', payload: { type: 'Output', payload: { data: 'x'.repeat(65537 - overhead) } } });
    expect(() => parseStreamRecord(overLimit)).toThrow();
  });

  it('bounds total screen allocation as well as each individual dimension', () => {
    const descriptor = { session_id: 'pane', incarnation: identity, stream_epoch: identity,
      clock_epoch: identity, initial_cols: 1025, initial_rows: 1025, durable: true };
    expect(() => parseStreamDescriptor(descriptor)).toThrow();
    expect(() => parseStreamRecord(record('1', { type: 'Resize', payload: { cols: 1025, rows: 1025 } }))).toThrow();
    expect(parseStreamDescriptor({ ...descriptor, initial_cols: 1024, initial_rows: 1024 }).initial_rows).toBe(1024);
  });
});
