import type { AnsiLine, AnsiSpan } from '../types/terminal';

export const ARCHIVE_BYTE_LIMIT = 8 * 1024 * 1024;
export const ARCHIVE_LINE_LIMIT = 5000;
export interface PresentationCache { lines: AnsiLine[]; bytes: number; truncated: boolean }
const encoder = new TextEncoder();
const color = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function presentationLine(value: unknown): AnsiLine | null {
  if (!object(value) || typeof value.id !== 'string' || value.id.length > 256
      || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)
      || !Array.isArray(value.spans) || value.spans.length > 65535) return null;
  const spans: AnsiSpan[] = [];
  let characters = 0;
  for (const valueSpan of value.spans) {
    if (!object(valueSpan) || typeof valueSpan.text !== 'string' || /[\r\n]/.test(valueSpan.text)) return null;
    characters += valueSpan.text.length;
    if (characters > ARCHIVE_BYTE_LIMIT) return null;
    const span: AnsiSpan = { text: valueSpan.text };
    if (color(valueSpan.fg)) span.fg = valueSpan.fg;
    if (color(valueSpan.bg)) span.bg = valueSpan.bg;
    for (const key of ['bold', 'dim', 'italic', 'underline', 'strikethrough', 'invert'] as const) {
      if (valueSpan[key] === true) span[key] = true;
    }
    spans.push(span);
  }
  return { id: value.id, timestamp: value.timestamp, spans,
    ...(value.isError === true ? { isError: true } : {}),
    ...(value.isWrapped === true ? { isWrapped: true } : {}) };
}

/** Whole-line, newest-suffix retention. Never a terminal checkpoint. Account
 * the serialized presentation (including style/ids), not just visible text. */
export function boundCachedLines(value: unknown): PresentationCache {
  if (!Array.isArray(value)) return { lines: [], bytes: 0, truncated: value != null };
  const lines: AnsiLine[] = [];
  let bytes = 2;
  let truncated = false;
  for (let index = value.length - 1; index >= 0; index--) {
    if (lines.length === ARCHIVE_LINE_LIMIT) { truncated = true; break; }
    const line = presentationLine(value[index]);
    if (!line) { truncated = true; break; }
    const charge = encoder.encode(JSON.stringify(line)).length + (lines.length ? 1 : 0);
    if (bytes + charge > ARCHIVE_BYTE_LIMIT) { truncated = true; break; }
    lines.push(line); bytes += charge;
  }
  lines.reverse();
  return { lines, bytes: lines.length ? bytes : 0, truncated };
}
