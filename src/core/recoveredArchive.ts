/** In-memory historical capture. Never an input to the live terminal parser. */
import { ARCHIVE_BYTE_LIMIT, ARCHIVE_LINE_LIMIT } from './presentationCache';
export interface ArchiveIdentity { session_id: string; incarnation: string; attachment_id: string }
export interface ArchiveMetadata {
  capture_id: string;
  cols: number;
  rows: number;
  bytes: number;
  lines: number;
  chunks: number;
  history_at_limit: boolean;
  potentially_overlapping: true;
  potentially_incomplete: true;
}
export interface ArchiveState {
  status: 'unavailable' | 'receiving' | 'complete' | 'incomplete';
  receivedBytes: number;
  receivedChunks: number;
  data: string | null;
  reason: string | null;
  metadata: Readonly<ArchiveMetadata> | null;
}
const encoder = new TextEncoder();
const MAX_BYTES = ARCHIVE_BYTE_LIMIT;
const MAX_LINES = ARCHIVE_LINE_LIMIT;
function integer(value: unknown, maximum: number, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid history value');
  return value;
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Error('Invalid history identity');
  return value;
}
export class RecoveredArchive {
  private current: Readonly<ArchiveState> = Object.freeze({ status: 'unavailable', receivedBytes: 0,
    receivedChunks: 0, data: null, reason: null, metadata: null });
  private fragments: string[] = [];
  private linefeeds = 0;
  private actualLines = 0;
  private started = false;
  private readonly byteBudget: number;
  private readonly lineBudget: number;

  constructor(private readonly binding: ArchiveIdentity, cached = { bytes: 0, lines: 0 }) {
    identity(binding.incarnation);
    identity(binding.attachment_id);
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(binding.session_id)) throw new Error('Invalid history session');
    this.binding = Object.freeze({ ...binding });
    this.byteBudget = MAX_BYTES - integer(cached.bytes, MAX_BYTES);
    this.lineBudget = MAX_LINES - integer(cached.lines, MAX_LINES);
  }
  get state(): Readonly<ArchiveState> { return this.current; }
  private update(patch: Partial<ArchiveState>): void { this.current = Object.freeze({ ...this.current, ...patch }); }
  private fail(): never {
    this.fragments = [];
    this.started = true;
    const reason = 'Invalid or incomplete history transfer; cached snapshot retained';
    this.update({ status: 'incomplete', data: null, receivedBytes: 0, receivedChunks: 0, reason });
    throw new Error(reason);
  }
  accept(event: string, value: unknown): boolean {
    if (!['HistoryBegin', 'HistoryChunk', 'HistoryComplete', 'HistoryUnavailable'].includes(event)) return false;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    if (input.session_id !== this.binding.session_id || input.incarnation !== this.binding.incarnation
        || input.attachment_id !== this.binding.attachment_id) return false;
    try {
      if (encoder.encode(JSON.stringify(input)).length > 65536) return this.fail();
      if (event === 'HistoryUnavailable') {
        if (this.started) return this.fail();
        this.started = true;
        this.update({ reason: 'History unavailable; cached snapshot retained' });
        return true;
      }
      if (event === 'HistoryBegin') {
        if (this.started) return this.fail();
        const metadata: ArchiveMetadata = {
          capture_id: identity(input.capture_id), cols: integer(input.cols, 65535, 1), rows: integer(input.rows, 65535, 1),
          bytes: integer(input.bytes, this.byteBudget), lines: integer(input.lines, this.lineBudget),
          chunks: integer(input.chunks, 2048), history_at_limit: input.history_at_limit === true,
          potentially_overlapping: true, potentially_incomplete: true,
        };
        if (typeof input.history_at_limit !== 'boolean' || input.potentially_overlapping !== true
            || input.potentially_incomplete !== true || (metadata.bytes === 0) !== (metadata.chunks === 0)
            || (metadata.bytes === 0) !== (metadata.lines === 0)) return this.fail();
        this.started = true;
        this.update({ status: 'receiving', metadata: Object.freeze(metadata) });
        return true;
      }
      const metadata = this.current.metadata;
      if (this.current.status !== 'receiving' || !metadata || input.capture_id !== metadata.capture_id) return this.fail();
      if (event === 'HistoryChunk') {
        if (input.ordinal !== this.current.receivedChunks || this.current.receivedChunks >= metadata.chunks
            || typeof input.data !== 'string' || !input.data) return this.fail();
        const data = input.data;
        for (const char of data) {
          const point = char.codePointAt(0)!;
          if (point >= 0xd800 && point <= 0xdfff) return this.fail();
        }
        const bytes = encoder.encode(data).length;
        if (bytes > 8192 || this.current.receivedBytes + bytes > metadata.bytes) return this.fail();
        for (const char of data) if (char === '\n') this.linefeeds++;
        this.actualLines = this.linefeeds + (data.endsWith('\n') ? 0 : 1);
        if (this.actualLines > metadata.lines || this.actualLines > this.lineBudget) return this.fail();
        this.fragments.push(data);
        this.update({ receivedBytes: this.current.receivedBytes + bytes, receivedChunks: this.current.receivedChunks + 1 });
        return true;
      }
      if (input.bytes !== metadata.bytes || input.chunks !== metadata.chunks || this.current.receivedBytes !== metadata.bytes
          || this.current.receivedChunks !== metadata.chunks || this.actualLines !== metadata.lines) return this.fail();
      this.update({ status: 'complete', data: this.fragments.join(''), reason: null });
      this.fragments = [];
      return true;
    } catch { return this.fail(); }
  }
  disconnect(): void {
    if (this.current.status !== 'receiving') return;
    this.fragments = [];
    this.update({ status: 'incomplete', data: null, receivedBytes: 0, receivedChunks: 0,
      reason: 'History transfer incomplete after disconnection; cached snapshot retained' });
  }
}
