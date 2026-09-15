import { expect, vi } from 'vitest';
import { PtyClient } from '../core/ptyClient';
import type { RecoverySocket } from '../core/recoveryConnection';
import type { StreamDescriptor, StreamPayload } from '../core/streamProtocol';

export const TEST_INCARNATION = '1'.repeat(32);
export const TEST_STREAM = '2'.repeat(32);
export interface WireRequest { action: string; payload: Record<string, unknown> }
interface Bound {
  session_id: string; incarnation: string; attachment_id: string;
  descriptor: StreamDescriptor; sequence: bigint;
}
/** Controlled network boundary with the real public client, attachment state
 * machine and xterm parser. Never opens a daemon socket or runs a process. */
export class TestRecoverySocket implements RecoverySocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: WireRequest[] = [];
  bound = new Map<string, Bound>();
  constructor(private ordinal: number) {}
  send(raw: string): void { this.sent.push(JSON.parse(raw)); }
  close(): void { this.readyState = 3; }
  drop(): void { this.close(); this.onclose?.(); }
  receive(event: string, data?: unknown): void { this.onmessage?.({ data: JSON.stringify({ event, data }) }); }
  openSocket(): void { this.readyState = 1; this.onopen?.(); }
  negotiate(): void {
    this.receive('Protocol', { version: 2, daemon_epoch: TEST_STREAM });
    this.receive('Negotiated', { version: 2, daemon_epoch: TEST_STREAM });
  }
  open(): void { this.openSocket(); this.negotiate(); }
  actions(action: string): WireRequest[] { return this.sent.filter(request => request.action === action); }
  created(id: string, incarnation = TEST_INCARNATION): void {
    const request = this.actions('Create').find(request => request.payload.id === id)!;
    expect(request).toBeDefined();
    this.receive('CreateResult', { request_id: request.payload.request_id, session_id: id, incarnation, error: null });
  }
  async offer(id: string, options: { kind?: 'resume' | 'replay-from-start' | 'rebuild'; cut?: string; incarnation?: string; stream?: string } = {}): Promise<Bound> {
    await vi.waitFor(() => expect(this.actions('Attach').some(request => request.payload.id === id)).toBe(true));
    const request = this.actions('Attach').find(request => request.payload.id === id)!;
    const resume = request.payload.resume as { after_sequence: string; stream_epoch: string } | null;
    const descriptor = { session_id: id, incarnation: options.incarnation ?? TEST_INCARNATION,
      stream_epoch: options.stream ?? TEST_STREAM, clock_epoch: TEST_STREAM, initial_cols: 80, initial_rows: 24, durable: true };
    const attachment_id = (this.ordinal * 1000 + this.bound.size + 1).toString(16).padStart(32, '0');
    const sequence = options.cut ?? resume?.after_sequence ?? '0';
    const kind = options.kind ?? (resume ? 'resume' : 'replay-from-start');
    const bound = { session_id: id, incarnation: descriptor.incarnation, attachment_id, descriptor, sequence: BigInt(sequence) };
    this.bound.set(id, bound);
    this.receive('AttachResult', { request_id: request.payload.request_id, session_id: id, outcome: kind, attachment_id, descriptor });
    this.receive('StreamBegin', { session_id: id, incarnation: descriptor.incarnation, attachment_id, descriptor, kind, cut: sequence });
    return bound;
  }
  async caughtUp(id: string): Promise<void> {
    const bound = this.bound.get(id)!;
    const cut = { session_id: id, incarnation: bound.incarnation, attachment_id: bound.attachment_id, sequence: bound.sequence.toString() };
    this.receive('StreamCaughtUp', cut);
    await vi.waitFor(() => expect(this.actions('StreamApplied').some(request => request.payload.id === id)).toBe(true));
    this.receive('AttachmentReady', cut);
  }
  async ready(id: string): Promise<void> { await this.offer(id); await this.caughtUp(id); }
  record(id: string, payload: StreamPayload, phase: 'live' | 'catch-up' = 'live', sequence?: string): void {
    const bound = this.bound.get(id)!;
    if (sequence !== undefined) bound.sequence = BigInt(sequence); else bound.sequence++;
    this.receive('StreamRecord', { attachment_id: bound.attachment_id, phase, record: {
      session_id: id, incarnation: bound.incarnation, stream_epoch: bound.descriptor.stream_epoch,
      sequence: bound.sequence.toString(), observed_micros: Number(bound.sequence) * 1000, payload,
    } });
  }
}
export function recoveryFixture(): { client: PtyClient; sockets: TestRecoverySocket[] } {
  const sockets: TestRecoverySocket[] = [];
  const client = new PtyClient({ socket: () => { const socket = new TestRecoverySocket(sockets.length + 1); sockets.push(socket); return socket; } });
  return { client, sockets };
}
