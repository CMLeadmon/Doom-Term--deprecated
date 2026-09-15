import { describe, expect, it } from 'vitest';
import { RecoveredArchive } from './recoveredArchive';

const identity = { session_id: 'pane', incarnation: 'a'.repeat(32), attachment_id: 'b'.repeat(32) };
const capture = 'c'.repeat(32);
const packet = (patch: Record<string, unknown> = {}) => ({ ...identity, capture_id: capture, ...patch });
const begin = (text: string, chunks = 1) => packet({ cols: 80, rows: 24, bytes: new TextEncoder().encode(text).length,
  lines: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, chunks,
  history_at_limit: false, potentially_overlapping: true, potentially_incomplete: true });

describe('separate recovered archive', () => {
  it('only exposes a complete archive after exact byte, line, ordinal and capture completion', () => {
    const receiver = new RecoveredArchive(identity);
    const text = '三\n\x1b[31mred';
    expect(receiver.accept('HistoryBegin', begin(text, 2))).toBe(true);
    receiver.accept('HistoryChunk', packet({ ordinal: 0, data: '三\n' }));
    expect(receiver.state.status).toBe('receiving');
    expect(receiver.state.receivedBytes).toBe(4);
    expect(receiver.state.data).toBeNull();
    receiver.accept('HistoryChunk', packet({ ordinal: 1, data: '\x1b[31mred' }));
    expect(receiver.state.status).toBe('receiving');
    receiver.accept('HistoryComplete', packet({ chunks: 2, bytes: new TextEncoder().encode(text).length }));
    expect(receiver.state).toMatchObject({ status: 'complete', data: text, receivedChunks: 2, reason: null });
    expect(receiver.state.metadata).toMatchObject({ cols: 80, rows: 24, potentially_overlapping: true, potentially_incomplete: true });
    receiver.disconnect();
    expect(receiver.state.status).toBe('complete');
  });

  it('ignores stale attachments and marks a disconnected partial transfer incomplete', () => {
    const receiver = new RecoveredArchive(identity);
    receiver.accept('HistoryBegin', begin('old'));
    expect(receiver.accept('HistoryChunk', packet({ attachment_id: 'd'.repeat(32), ordinal: 0, data: 'wrong' }))).toBe(false);
    expect(receiver.state.receivedBytes).toBe(0);
    receiver.accept('HistoryChunk', packet({ ordinal: 0, data: 'old' }));
    receiver.disconnect();
    expect(receiver.state).toMatchObject({ status: 'incomplete', data: null, receivedBytes: 0 });
    expect(receiver.state.reason).toMatch(/incomplete/i);
  });

  it('requires explicit completion even for an empty historical snapshot', () => {
    const receiver = new RecoveredArchive(identity);
    receiver.accept('HistoryBegin', begin('', 0));
    expect(receiver.state.status).toBe('receiving');
    receiver.accept('HistoryComplete', packet({ chunks: 0, bytes: 0 }));
    expect(receiver.state).toMatchObject({ status: 'complete', data: '' });
  });

  it.each([
    ['forward ordinal', 'HistoryChunk', packet({ ordinal: 1, data: 'x' })],
    ['wrong capture', 'HistoryChunk', packet({ capture_id: 'd'.repeat(32), ordinal: 0, data: 'x' })],
    ['too many bytes', 'HistoryChunk', packet({ ordinal: 0, data: 'xx' })],
    ['unpaired surrogate', 'HistoryChunk', packet({ ordinal: 0, data: '\ud800' })],
    ['early completion', 'HistoryComplete', packet({ chunks: 1, bytes: 1 })],
    ['second begin', 'HistoryBegin', begin('x')],
  ])('fails closed on %s without preserving a purported complete result', (_name, event, data) => {
    const receiver = new RecoveredArchive(identity);
    receiver.accept('HistoryBegin', begin('x'));
    expect(() => receiver.accept(event, data)).toThrow(/invalid|incomplete/i);
    expect(receiver.state).toMatchObject({ status: 'incomplete', data: null, receivedBytes: 0 });
  });

  it('shares the 8 MiB and 5,000-line budgets with the retained cached snapshot', () => {
    const bytes = new RecoveredArchive(identity, { bytes: 8 * 1024 * 1024 - 2, lines: 0 });
    expect(() => bytes.accept('HistoryBegin', begin('三'))).toThrow(/invalid/i);
    const lines = new RecoveredArchive(identity, { bytes: 0, lines: 4999 });
    expect(() => lines.accept('HistoryBegin', begin('one\ntwo\n'))).toThrow(/invalid/i);
    const declaredLie = new RecoveredArchive(identity, { bytes: 0, lines: 4999 });
    declaredLie.accept('HistoryBegin', { ...begin('one\ntwo\n'), lines: 1 });
    expect(() => declaredLie.accept('HistoryChunk', packet({ ordinal: 0, data: 'one\ntwo\n' }))).toThrow(/invalid/i);
  });
});
