import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStreamRecord } from './streamProtocol';

/**
 * The Rust DemuxEvent and this parser are ONE wire format.
 *
 * Nothing enforced that, and it cost a release: `RemoteEnrichment` was added to
 * the Rust enum and the daemon emitted it on every remote prompt, while
 * `parseEvent` had no case for it and fell through to `invalid()`, which
 * throws. The attachment failed, the connection tore down, and every write
 * rejected with "delivery is unknown" — but only for someone who had actually
 * installed the remote snippet, which no test did.
 *
 * The variant list is read from the Rust source rather than restated here, so a
 * new variant fails this test until the parser and a sample are added.
 */
// Resolved from the project root: vitest runs jsdom, where import.meta.url is
// not a file: URL.
const RUST = resolve(process.cwd(), 'crates/doom-term-pty/src/demuxer.rs');

function rustVariants(): string[] {
  const source = readFileSync(RUST, 'utf8');
  const body = source.slice(source.indexOf('pub enum DemuxEvent'));
  const decl = body.slice(0, body.indexOf('\n}'));
  return [...decl.matchAll(/^\s{4}([A-Z][A-Za-z]*)/gm)].map((m) => m[1]);
}

/** One valid payload per variant. A new variant must add its own. */
const SAMPLES: Record<string, unknown> = {
  Output: { data: 'hi' },
  PromptStart: undefined,
  CommandStart: undefined,
  ExecutionStart: undefined,
  ExecutionEnd: { exit_code: 0 },
  TuiMode: { active: true },
  BracketedPasteMode: { enabled: true },
  AgentState: { state: 'running' },
  Cwd: { path: '/tmp' },
  RemoteEnrichment: { data: { host: 'devbox', user: null, shell: null, cwd: null, branch: 'main', agent: null, busy: true } },
  StreamFault: { reason: 'ControlTooLong' },
};

const record = (event: unknown) => ({
  session_id: 's1',
  incarnation: 'a'.repeat(32),
  stream_epoch: 'b'.repeat(32),
  sequence: '1',
  observed_micros: 1,
  payload: { type: 'Event', payload: event },
});

describe('stream protocol contract', () => {
  it('accepts every DemuxEvent variant the Rust enum declares', () => {
    const variants = rustVariants();
    expect(variants.length).toBeGreaterThan(5);
    for (const name of variants) {
      expect(
        Object.prototype.hasOwnProperty.call(SAMPLES, name),
        `${name} is a Rust DemuxEvent variant with no sample here — add one, and a case in parseEvent`,
      ).toBe(true);
      const event = SAMPLES[name] === undefined ? { type: name } : { type: name, payload: SAMPLES[name] };
      expect(
        () => parseStreamRecord(record(event)),
        `parseEvent rejects ${name}; the daemon can emit it and the client would tear down the connection`,
      ).not.toThrow();
    }
  });

  it('parses unknown event types as Unknown without throwing', () => {
    const parsed = parseStreamRecord(record({ type: 'NotARealEvent' }));
    expect(parsed.payload).toEqual({
      type: 'Event',
      payload: { type: 'Unknown', payload: { variant: 'NotARealEvent' } },
    });
  });

  it('still rejects malformed event shapes', () => {
    expect(() => parseStreamRecord(record({ type: 'Output', payload: { data: 123 } }))).toThrow();
    expect(() => parseStreamRecord(record({ type: 'ExecutionEnd', payload: { exit_code: 'not-a-number' } }))).toThrow();
  });

  it('carries a remote enrichment payload through intact', () => {
    const parsed = parseStreamRecord(record({ type: 'RemoteEnrichment', payload: SAMPLES.RemoteEnrichment }));
    const payload = parsed.payload as { type: 'Event'; payload: { type: string; payload: { data: Record<string, unknown> } } };
    expect(payload.payload.payload.data.host).toBe('devbox');
    expect(payload.payload.payload.data.branch).toBe('main');
    // Absent is unknown, never a default.
    expect(payload.payload.payload.data.user).toBeNull();
  });
});
