/** Negotiated v2 stream shapes. Numeric cursors are never JavaScript numbers. */
import { parseGrid } from './terminalGeometry';
export type StreamFault = 'RecordTooLarge' | 'SequenceExhausted' | 'ControlTooLong' | 'AdapterRetired' | 'AdapterLost' | 'Unknown';
export type StreamEvent =
  | { type: 'Output'; payload: { data: string } }
  | { type: 'PromptStart' | 'CommandStart' | 'ExecutionStart' }
  | { type: 'ExecutionEnd'; payload: { exit_code: number | null } }
  | { type: 'TuiMode'; payload: { active: boolean } }
  | { type: 'TuiModeUnknown' }
  | { type: 'BracketedPasteMode'; payload: { enabled: boolean } }
  | { type: 'AgentState'; payload: { state: string } }
  | { type: 'Cwd'; payload: { path: string } }
  | { type: 'RemoteEnrichment'; payload: { data: RemoteEnrichment } }
  | { type: 'StreamFault'; payload: { reason: StreamFault } }
  | { type: 'Unknown'; payload?: { variant: string } };
/** What a shell on the far end of a transport reported about itself. */
export interface RemoteEnrichment {
  host: string | null; user: string | null; shell: string | null;
  cwd: string | null; branch: string | null; agent: string | null; busy: boolean | null;
}
export type StreamPayload =
  | { type: 'Event'; payload: StreamEvent }
  | { type: 'Resize'; payload: { cols: number; rows: number } }
  | { type: 'Closed'; payload: { exit_code: number | null } }
  | { type: 'Fault'; payload: { reason: StreamFault } }
  | { type: 'Unknown'; payload?: { variant: string } };
export interface StreamDescriptor {
  session_id: string;
  incarnation: string;
  stream_epoch: string;
  clock_epoch: string;
  initial_cols: number;
  initial_rows: number;
  durable: boolean;
}
export interface StreamRecord {
  session_id: string;
  incarnation: string;
  stream_epoch: string;
  sequence: string;
  observed_micros: number;
  payload: StreamPayload;
}
export interface ResumeCursor { stream_epoch: string; after_sequence: string }

const encoder = new TextEncoder();
function invalid(): never { throw new Error('Invalid v2 stream value'); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function boolean(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function integer(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function identity(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : invalid();
}
function sessionId(value: unknown): string {
  const id = text(value);
  return id.length > 0 && encoder.encode(id).length <= 256 ? id : invalid();
}
function exitCode(value: unknown): number | null {
  return value === null ? null : integer(value, -2147483648, 2147483647);
}
function fault(value: unknown): StreamFault {
  switch (value) {
    case 'RecordTooLarge': case 'SequenceExhausted': case 'ControlTooLong': case 'AdapterRetired': case 'AdapterLost': return value;
    default: return 'Unknown';
  }
}
export function parseSequence(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return invalid();
  const sequence = BigInt(value);
  return sequence <= 18446744073709551615n ? sequence : invalid();
}
export function parseStreamDescriptor(value: unknown): StreamDescriptor {
  const input = object(value);
  const grid = parseGrid(input.initial_cols, input.initial_rows);
  return Object.freeze({ session_id: sessionId(input.session_id), incarnation: identity(input.incarnation),
    stream_epoch: identity(input.stream_epoch), clock_epoch: identity(input.clock_epoch),
    initial_cols: grid.cols, initial_rows: grid.rows,
    durable: boolean(input.durable) });
}
/** Every field optional on the wire; an absent one is unknown, never a default. */
function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}
function remoteEnrichment(value: unknown): RemoteEnrichment {
  const input = object(value);
  return {
    host: optionalText(input.host), user: optionalText(input.user),
    shell: optionalText(input.shell), cwd: optionalText(input.cwd),
    branch: optionalText(input.branch), agent: optionalText(input.agent),
    busy: input.busy === null || input.busy === undefined ? null : boolean(input.busy),
  };
}

function parseEvent(value: unknown): StreamEvent {
  const event = object(value);
  switch (event.type) {
    case 'PromptStart': case 'CommandStart': case 'ExecutionStart': case 'TuiModeUnknown': return { type: event.type };
    case 'Output': return { type: event.type, payload: { data: text(object(event.payload).data) } };
    case 'ExecutionEnd': return { type: event.type, payload: { exit_code: exitCode(object(event.payload).exit_code) } };
    case 'TuiMode': return { type: event.type, payload: { active: boolean(object(event.payload).active) } };
    case 'BracketedPasteMode': return { type: event.type, payload: { enabled: boolean(object(event.payload).enabled) } };
    case 'AgentState': return { type: event.type, payload: { state: text(object(event.payload).state) } };
    case 'Cwd': return { type: event.type, payload: { path: text(object(event.payload).path) } };
    case 'RemoteEnrichment': return { type: event.type, payload: { data: remoteEnrichment(object(event.payload).data) } };
    case 'StreamFault': return { type: event.type, payload: { reason: fault(object(event.payload).reason) } };
    default: {
      const variant = typeof event.type === 'string' ? event.type : 'Unknown';
      return { type: 'Unknown', payload: { variant } };
    }
  }
}
function parsePayload(value: unknown): StreamPayload {
  const input = object(value);
  switch (input.type) {
    case 'Event': return { type: input.type, payload: parseEvent(input.payload) };
    case 'Resize': return { type: input.type, payload: parseGrid(object(input.payload).cols, object(input.payload).rows) };
    case 'Closed': return { type: input.type, payload: { exit_code: exitCode(object(input.payload).exit_code) } };
    case 'Fault': return { type: input.type, payload: { reason: fault(object(input.payload).reason) } };
    default: {
      const variant = typeof input.type === 'string' ? input.type : 'Unknown';
      return { type: 'Unknown', payload: { variant } };
    }
  }
}
export function parseStreamRecord(value: unknown): StreamRecord {
  const input = object(value);
  const sequence = text(input.sequence);
  if (parseSequence(sequence) === 0n) return invalid();
  const payload = parsePayload(input.payload);
  const record = { session_id: sessionId(input.session_id), incarnation: identity(input.incarnation),
    stream_epoch: identity(input.stream_epoch), sequence,
    observed_micros: integer(input.observed_micros, 0, Number.MAX_SAFE_INTEGER), payload };
  if (encoder.encode(JSON.stringify(record)).length > 65536) return invalid();
  // Copy and freeze the validated shape: asynchronous application must not
  // observe a caller changing a queued record or an observer changing its ids.
  if ('payload' in payload && payload.payload && typeof payload.payload === 'object') {
    if ('payload' in payload.payload && payload.payload.payload && typeof payload.payload.payload === 'object') {
      Object.freeze(payload.payload.payload);
    }
    Object.freeze(payload.payload);
  }
  Object.freeze(payload);
  return Object.freeze(record);
}
