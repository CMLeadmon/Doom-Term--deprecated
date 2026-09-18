# Diagnostics Substrate Implementation Plan (Phase 0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Doom Term's failure states observable and reproducible, so that Phases 1–3 can be verified instead of guessed at — without changing a single runtime behavior.

**Architecture:** A bounded, read-only state ledger (`src/core/diagnostics.ts`) records connection transitions, protocol events, and counters; `window.__doom` exposes a snapshot of it. A fault-injection socket proxy, installed only in dev/test builds via `window.__doomFault`, lets a browser test cause the exact failures the spec documents. The 643-line sequential `tools/test-frontend-ui.mjs` is split into a real Playwright project with per-spec daemon fixtures, and fault specs land **red**, documenting Findings 1–9 as executable evidence.

**Tech Stack:** TypeScript, React 19, Vite 6, Vitest 3 (jsdom), Playwright 1.63 (real Chromium), Rust (tokio daemon), tmux.

**Spec:** [`../specs/2026-09-17-failure-containment-design.md`](../specs/2026-09-17-failure-containment-design.md)

## Global Constraints

- **No behavior changes in this phase.** Every task is additive or test-only. If a task would alter what the application does when nothing is faulted, it belongs in Phase 1.
- **The ledger stores no payload bytes.** Event names, identities, reasons, and counts only. Terminal contents must never enter diagnostics — this is the same rule `recoveryConnection.ts` already states for its own error paths and the reason `ConsumerFault` deliberately carries no cause.
- **The ledger is derived observation.** It reads state that already exists and owns none of its own. A second source of truth would be a new class of bug.
- **Fault injection never ships.** The `window.__doomFault` seam is guarded by `import.meta.env.DEV` and must be absent from a production bundle. Task 4 asserts this against the real `npm run build` output.
- **Tests never touch the user's daemon or tmux.** `DOOM_PORT=0`, a private `TMUX_TMPDIR`, and `tmux -L doom-term`. This is already correct in `tools/test-frontend-ui.mjs` and is preserved verbatim.
- **Design axioms hold for the overlay:** `border-radius: 0`, 1px bevels only (`--bevel-up` / `--bevel-dn`), the 5 canonical state colors, Unicode/ASCII glyphs only (no icon libraries), and `--` for anything unmeasured. The overlay is transient — no persistent chrome.
- Scope every e2e DOM query to the visible pane (`.filter({ visible: true })`), and close duplicate browser tabs before live testing: two tabs share `localStorage` and manufacture phantom session bugs.

---

### Task 1: The diagnostics ledger core

A pure, bounded, dependency-free record of what the client observed. No imports from the transport — the transport imports *it*, never the reverse.

**Files:**
- Create: `src/core/diagnostics.ts`
- Test: `src/core/diagnostics.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LedgerEntry = { at: number; kind: 'transition' | 'event' | 'refusal'; name: string; sessionId: string | null; requestId: string | null; reason: string | null }`
  - `type Counters = Record<CounterName, number>` where `type CounterName = 'framesDropped' | 'unknownEvents' | 'unknownVariants' | 'reconnects' | 'createsAttempted' | 'createsFailed' | 'attachmentsFaulted'`
  - `class Diagnostics` with `record(entry: Omit<LedgerEntry, 'at'>): void`, `count(name: CounterName): void`, `snapshot(): { entries: LedgerEntry[]; counters: Counters }`, `clear(): void`
  - `const diagnostics: Diagnostics` — the shared instance
  - `const LEDGER_LIMIT = 512`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/diagnostics.test.ts
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
      // A caller that leaks terminal contents must not have them retained.
      data: 'SECRET_TERMINAL_CONTENTS',
    } as never);
    expect(JSON.stringify(ledger.snapshot())).not.toContain('SECRET_TERMINAL_CONTENTS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/diagnostics.test.ts`
Expected: FAIL — `Failed to resolve import "./diagnostics"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/diagnostics.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/diagnostics.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/diagnostics.ts src/core/diagnostics.test.ts
git commit -m "feat(diagnostics): bounded ledger of client observations"
```

---

### Task 2: Instrument the transport

Record what the socket observes. This task adds only `diagnostics.*` calls — no control flow changes. Verified by asserting the ledger reflects a fault the current code already produces.

**Files:**
- Modify: `src/core/recoveryConnection.ts` (imports `diagnostics`; call sites at `:70`, `:85`, `:128-132`, `:175`)
- Test: `src/core/diagnostics.transport.test.ts`

**Interfaces:**
- Consumes: `diagnostics`, `LedgerEntry` from Task 1.
- Produces: ledger entries named `connection:<status>` for transitions, `event:<name>` for received events, and counter increments on `framesDropped` / `unknownEvents` / `reconnects`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/diagnostics.transport.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { RecoveryConnection } from './recoveryConnection';
import type { RecoverySocket } from './recoveryConnection';
import { diagnostics } from './diagnostics';

/** A socket the test drives directly; nothing here reaches a network. */
function controllable() {
  const sent: string[] = [];
  const socket: RecoverySocket & { fire(data: unknown): void } = {
    readyState: 1, bufferedAmount: 0,
    onopen: null, onclose: null, onerror: null, onmessage: null,
    send(text: string) { sent.push(text); },
    close() {},
    fire(data: unknown) { socket.onmessage?.({ data }); },
  };
  return { socket, sent };
}

function negotiate(socket: ReturnType<typeof controllable>['socket']) {
  const epoch = 'a'.repeat(32);
  socket.onopen?.();
  socket.fire(JSON.stringify({ event: 'Protocol', data: { version: 2, daemon_epoch: epoch } }));
  socket.fire(JSON.stringify({ event: 'Negotiated', data: { version: 2, daemon_epoch: epoch } }));
}

describe('transport diagnostics', () => {
  beforeEach(() => diagnostics.clear());

  it('records every connection transition with its reason', () => {
    const { socket } = controllable();
    new RecoveryConnection({ socket: () => socket, onMessage: () => {} }).connect();
    negotiate(socket);
    const names = diagnostics.snapshot().entries.map(e => e.name);
    expect(names).toContain('connection:connecting');
    expect(names).toContain('connection:negotiating');
    expect(names).toContain('connection:ready');
  });

  it('counts a malformed frame and names the transition that followed it', () => {
    const { socket } = controllable();
    new RecoveryConnection({ socket: () => socket, onMessage: () => {} }).connect();
    negotiate(socket);
    socket.fire('this is not json');
    const { entries, counters } = diagnostics.snapshot();
    expect(counters.framesDropped).toBe(1);
    // Phase 0 does not change behavior: the transition is still `incompatible`.
    // The point is that it is now *recorded* rather than invisible.
    expect(entries.some(e => e.name === 'connection:incompatible')).toBe(true);
  });

  it('records received events by name without their payloads', () => {
    const { socket } = controllable();
    new RecoveryConnection({ socket: () => socket, onMessage: () => {} }).connect();
    negotiate(socket);
    socket.fire(JSON.stringify({ event: 'Telemetry', data: { secret: 'SECRET_PAYLOAD' } }));
    const dumped = JSON.stringify(diagnostics.snapshot());
    expect(dumped).toContain('event:Telemetry');
    expect(dumped).not.toContain('SECRET_PAYLOAD');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/diagnostics.transport.test.ts`
Expected: FAIL — `expected [ ... ] to contain 'connection:connecting'` (the ledger is empty; nothing records yet).

- [ ] **Step 3: Write minimal implementation**

In `src/core/recoveryConnection.ts`, add the import:

```ts
import { diagnostics } from './diagnostics';
```

In `update()`, record the transition:

```ts
  private update(patch: Partial<ConnectionState>): void {
    const previous = this.current.status;
    this.current = Object.freeze({ ...this.current, ...patch });
    if (this.current.status !== previous) {
      diagnostics.record({ kind: 'transition', name: 'connection:' + this.current.status,
        sessionId: null, requestId: null, reason: this.current.message });
    }
    this.options.onState?.(this.current);
  }
```

In the `onmessage` handler's `catch`, count the drop before the existing branch:

```ts
        } catch (error) {
          diagnostics.count('framesDropped');
          if (error instanceof ConsumerFault) this.restart('Stream continuity fault; reattaching');
          else this.disconnect('incompatible', 'Invalid or incompatible recovery protocol; update both shells together', false);
        }
```

In `receive()`, record the event name immediately after the `event` is known to be a string — i.e. as the first statement of `receive`:

```ts
  private receive(event: string, value: unknown): void {
    diagnostics.record({ kind: 'event', name: 'event:' + event, sessionId: null, requestId: null, reason: null });
```

In the reconnect timer at `:85`, count the reconnect:

```ts
    if (retry && !this.disposed && this.reconnectTimer === null) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null; diagnostics.count('reconnects'); this.connect();
      }, 2000);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/diagnostics.transport.test.ts src/core/recoveryConnection.test.ts`
Expected: PASS. The existing `recoveryConnection.test.ts` must stay green — it is the proof that no behavior changed.

- [ ] **Step 5: Commit**

```bash
git add src/core/recoveryConnection.ts src/core/diagnostics.transport.test.ts
git commit -m "feat(diagnostics): record transport transitions, events and dropped frames"
```

---

### Task 3: Instrument the client and expose `window.__doom`

**Files:**
- Modify: `src/core/ptyClient.ts` (call sites at `:238`, `:279-300`, and `inputReadiness` at `:379`)
- Create: `src/core/diagnosticsWindow.ts`
- Modify: `src/main.tsx`
- Test: `src/core/diagnosticsWindow.test.ts`

**Interfaces:**
- Consumes: `diagnostics` from Task 1; `PtyClient` from `./ptyClient`.
- Produces:
  - `interface DoomSnapshot { connection: { status: string; message: string | null; daemonEpoch: string | null }; bindings: BindingSnapshot[]; entries: LedgerEntry[]; counters: Counters }`
  - `interface BindingSnapshot { id: string; incarnation: string | null; attachment: string | null; refusal: string | null; createStatus: string | null }`
  - `function installDiagnosticsWindow(client: PtyClient): void` — defines `window.__doom` as a zero-argument function returning `DoomSnapshot`.
  - `PtyClient.diagnosticsSnapshot(): DoomSnapshot` — the method `installDiagnosticsWindow` calls.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/diagnosticsWindow.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PtyClient } from './ptyClient';
import type { RecoverySocket } from './recoveryConnection';
import { installDiagnosticsWindow } from './diagnosticsWindow';
import { diagnostics } from './diagnostics';

function offlineSocket(): RecoverySocket {
  return {
    readyState: 0, bufferedAmount: 0,
    onopen: null, onclose: null, onerror: null, onmessage: null,
    send() {}, close() {},
  };
}

describe('window.__doom', () => {
  beforeEach(() => { diagnostics.clear(); delete (globalThis as never as Record<string, unknown>).__doom; });

  it('exposes a snapshot function returning connection, bindings, entries and counters', () => {
    const client = new PtyClient({ socket: offlineSocket });
    installDiagnosticsWindow(client);
    const snapshot = (globalThis as never as { __doom(): ReturnType<PtyClient['diagnosticsSnapshot']> }).__doom();
    expect(snapshot.connection.status).toBe('connecting');
    expect(Array.isArray(snapshot.bindings)).toBe(true);
    expect(Array.isArray(snapshot.entries)).toBe(true);
    expect(snapshot.counters.createsAttempted).toBe(0);
  });

  it('reports a pending creation as a binding with its create status', () => {
    const client = new PtyClient({ socket: offlineSocket });
    installDiagnosticsWindow(client);
    void client.createSession('node-1', 80, 24).catch(() => undefined);
    const snapshot = client.diagnosticsSnapshot();
    const binding = snapshot.bindings.find(candidate => candidate.id === 'node-1');
    expect(binding).toBeDefined();
    // Offline: the intent was never sent. This is Finding 7, made visible.
    expect(binding!.createStatus).toBe('unsent');
    expect(binding!.attachment).toBeNull();
  });

  it('never exposes an incarnation for a session that has none', () => {
    const client = new PtyClient({ socket: offlineSocket });
    void client.createSession('node-1', 80, 24).catch(() => undefined);
    expect(client.diagnosticsSnapshot().bindings[0].incarnation).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/diagnosticsWindow.test.ts`
Expected: FAIL — `Failed to resolve import "./diagnosticsWindow"`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/ptyClient.ts` — the import, and the method (place it beside `getAttachmentState`):

```ts
import { diagnostics } from './diagnostics';
import type { Counters, LedgerEntry } from './diagnostics';

export interface BindingSnapshot {
  id: string; incarnation: string | null; attachment: string | null;
  refusal: string | null; createStatus: string | null;
}
export interface DoomSnapshot {
  connection: { status: string; message: string | null; daemonEpoch: string | null };
  bindings: BindingSnapshot[];
  entries: LedgerEntry[];
  counters: Counters;
}
```

```ts
  /** Derived observation only. Never a second source of truth. */
  diagnosticsSnapshot(): DoomSnapshot {
    const { entries, counters } = diagnostics.snapshot();
    return {
      connection: {
        status: this.connection.state.status,
        message: this.connection.state.message,
        daemonEpoch: this.connection.state.daemonEpoch,
      },
      bindings: [...this.bindings.values()].map(binding => ({
        id: binding.id,
        incarnation: binding.incarnation ?? null,
        attachment: binding.attachment?.state.status ?? null,
        refusal: binding.reason ?? null,
        createStatus: binding.create?.status ?? null,
      })),
      entries,
      counters,
    };
  }
```

Record creation outcomes in `pumpBindings` — at `:279` where the intent is sent, and in the existing `.catch`:

```ts
        intent.status = 'sent'; this.creating.add(intent); diagnostics.count('createsAttempted');
```

```ts
        }).catch(error => {
          intent.status = 'failed'; binding.reason = (error as Error).message;
          diagnostics.count('createsFailed');
          diagnostics.record({ kind: 'refusal', name: 'create', sessionId: binding.id,
            requestId: null, reason: binding.reason });
          intent.reject(error as Error);
```

Record attachment faults in the `onState` observer at `:238`:

```ts
      onState: state => {
        this.attachmentHandlers.forEach(handler => handler(id, state));
        if (state.status === 'failed') {
          diagnostics.count('attachmentsFaulted');
          diagnostics.record({ kind: 'transition', name: 'attachment:failed', sessionId: id,
            requestId: null, reason: state.reason });
        }
```

Record every refusal in `refused()`:

```ts
  private refused(id: string, reason: string): false {
    diagnostics.record({ kind: 'refusal', name: 'input', sessionId: id, requestId: null, reason });
    this.notify(id, handler => handler.onInputRefused?.(id, reason));
    return false;
  }
```

Create `src/core/diagnosticsWindow.ts`:

```ts
import type { DoomSnapshot, PtyClient } from './ptyClient';

/** Read-only diagnostic accessor. Exposes a snapshot function, never the
 * client itself: nothing reached through `window` may mutate app state. */
export function installDiagnosticsWindow(client: PtyClient): void {
  Object.defineProperty(globalThis, '__doom', {
    configurable: true,
    writable: true,
    value: (): DoomSnapshot => client.diagnosticsSnapshot(),
  });
}
```

Wire it in `src/main.tsx`, above the `createRoot` call:

```tsx
import { installDiagnosticsWindow } from './core/diagnosticsWindow';
import { ptyClient } from './core/ptyClient';

installDiagnosticsWindow(ptyClient);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/diagnosticsWindow.test.ts src/core/ptyClient.test.ts && npm run typecheck`
Expected: PASS for both suites; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/ptyClient.ts src/core/diagnosticsWindow.ts src/core/diagnosticsWindow.test.ts src/main.tsx
git commit -m "feat(diagnostics): expose window.__doom snapshot of connection and bindings"
```

---

### Task 4: The fault-injection socket seam

A test must be able to cause a fault, not wait for one. `PtyClient.getInstance()` runs at module import, so the factory has to be readable synchronously at that moment — Playwright's `addInitScript` sets `window.__doomFault` before any page script runs.

**Files:**
- Create: `src/core/faultSocket.ts`
- Modify: `src/core/ptyClient.ts` (the `getInstance()` / constructor socket factory)
- Test: `src/core/faultSocket.test.ts`

**Interfaces:**
- Consumes: `RecoverySocket` from `./recoveryConnection`.
- Produces:
  - `type FaultKind = 'unknown-event' | 'unknown-variant' | 'malformed-frame' | 'oversized-frame' | 'stall' | 'close-midstream'`
  - `interface FaultConfig { kind: FaultKind; afterEvent?: string; sessionId?: string }`
  - `function faultSocket(inner: RecoverySocket, config: FaultConfig): RecoverySocket`
  - `function configuredFault(): FaultConfig | null` — reads `window.__doomFault`, returns null in a production build.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/faultSocket.test.ts
import { describe, expect, it } from 'vitest';
import { faultSocket } from './faultSocket';
import type { RecoverySocket } from './recoveryConnection';

function inner(): RecoverySocket & { deliver(data: string): void; closed: boolean } {
  const socket = {
    readyState: 1, bufferedAmount: 0,
    onopen: null, onclose: null, onerror: null, onmessage: null,
    closed: false,
    send() {}, close() { socket.closed = true; },
    deliver(data: string) { socket.onmessage?.({ data }); },
  } as RecoverySocket & { deliver(data: string): void; closed: boolean };
  return socket;
}

const record = (variant: string) => JSON.stringify({
  event: 'StreamRecord',
  data: { attachment_id: 'b'.repeat(32), record: { payload: { type: 'Event', payload: { type: variant } } } },
});

describe('faultSocket', () => {
  it('passes frames through untouched until the trigger event arrives', () => {
    const base = inner();
    const wrapped = faultSocket(base, { kind: 'malformed-frame', afterEvent: 'Negotiated' });
    const seen: unknown[] = [];
    wrapped.onmessage = event => seen.push(event.data);
    base.deliver(JSON.stringify({ event: 'Protocol', data: {} }));
    expect(seen).toEqual([JSON.stringify({ event: 'Protocol', data: {} })]);
  });

  it('replaces the frame after the trigger with unparseable text', () => {
    const base = inner();
    const wrapped = faultSocket(base, { kind: 'malformed-frame', afterEvent: 'Negotiated' });
    const seen: string[] = [];
    wrapped.onmessage = event => seen.push(event.data as string);
    base.deliver(JSON.stringify({ event: 'Negotiated', data: {} }));
    base.deliver(JSON.stringify({ event: 'Telemetry', data: {} }));
    expect(seen[0]).toContain('Negotiated');
    expect(() => JSON.parse(seen[1])).toThrow();
  });

  it('rewrites a stream record to carry an unknown event variant', () => {
    const base = inner();
    const wrapped = faultSocket(base, { kind: 'unknown-variant' });
    const seen: string[] = [];
    wrapped.onmessage = event => seen.push(event.data as string);
    base.deliver(record('Output'));
    // The shape is intact; only the variant name is one the client cannot know.
    const parsed = JSON.parse(seen[0]);
    expect(parsed.event).toBe('StreamRecord');
    expect(parsed.data.record.payload.payload.type).toBe('DoomTermSyntheticVariant');
  });

  it('delivers nothing at all once stalled', () => {
    const base = inner();
    const wrapped = faultSocket(base, { kind: 'stall', afterEvent: 'Negotiated' });
    const seen: string[] = [];
    wrapped.onmessage = event => seen.push(event.data as string);
    base.deliver(JSON.stringify({ event: 'Negotiated', data: {} }));
    base.deliver(JSON.stringify({ event: 'Telemetry', data: {} }));
    base.deliver(JSON.stringify({ event: 'Telemetry', data: {} }));
    expect(seen).toHaveLength(1);
  });

  it('closes the underlying socket mid-stream when asked', () => {
    const base = inner();
    const wrapped = faultSocket(base, { kind: 'close-midstream', afterEvent: 'Negotiated' });
    wrapped.onmessage = () => {};
    base.deliver(JSON.stringify({ event: 'Negotiated', data: {} }));
    expect(base.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/faultSocket.test.ts`
Expected: FAIL — `Failed to resolve import "./faultSocket"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/faultSocket.ts
import type { RecoverySocket } from './recoveryConnection';

export type FaultKind =
  | 'unknown-event' | 'unknown-variant' | 'malformed-frame'
  | 'oversized-frame' | 'stall' | 'close-midstream';

export interface FaultConfig { kind: FaultKind; afterEvent?: string; sessionId?: string }

/** The variant name a daemon would emit that this client has never been taught.
 * Deliberately not a real DemuxEvent: the point is that it never becomes one. */
const SYNTHETIC = 'DoomTermSyntheticVariant';

function eventName(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return null;
    const name = (parsed as Record<string, unknown>).event;
    return typeof name === 'string' ? name : null;
  } catch { return null; }
}

/** Wraps a real socket and corrupts what it delivers, on a trigger. Inbound
 * only: outbound commands pass through so the app behaves normally until the
 * fault fires. */
export function faultSocket(inner: RecoverySocket, config: FaultConfig): RecoverySocket {
  let armed = !config.afterEvent;
  let stalled = false;
  const wrapper: RecoverySocket = {
    get readyState() { return inner.readyState; },
    get bufferedAmount() { return inner.bufferedAmount; },
    onopen: null, onclose: null, onerror: null, onmessage: null,
    send(text: string) { inner.send(text); },
    close() { inner.close(); },
  };
  inner.onopen = () => wrapper.onopen?.();
  inner.onclose = () => wrapper.onclose?.();
  inner.onerror = () => wrapper.onerror?.();
  inner.onmessage = event => {
    if (stalled) return;
    const name = eventName(event.data);
    const fire = armed;
    if (!armed && name === config.afterEvent) { armed = true; wrapper.onmessage?.(event); 
      if (config.kind === 'close-midstream') inner.close();
      if (config.kind === 'stall') stalled = true;
      return; }
    if (!fire) { wrapper.onmessage?.(event); return; }
    switch (config.kind) {
      case 'malformed-frame':
        wrapper.onmessage?.({ data: '{ this is not json' }); return;
      case 'oversized-frame':
        wrapper.onmessage?.({ data: 'x'.repeat(4 * 1024 * 1024 + 1) }); return;
      case 'unknown-event':
        wrapper.onmessage?.({ data: JSON.stringify({ event: 'DoomTermSyntheticEvent', data: {} }) }); return;
      case 'unknown-variant': {
        if (typeof event.data !== 'string' || name !== 'StreamRecord') { wrapper.onmessage?.(event); return; }
        const parsed = JSON.parse(event.data);
        if (parsed?.data?.record?.payload?.payload) parsed.data.record.payload.payload.type = SYNTHETIC;
        wrapper.onmessage?.({ data: JSON.stringify(parsed) }); return;
      }
      case 'stall': stalled = true; return;
      case 'close-midstream': inner.close(); return;
    }
  };
  return wrapper;
}

/** Test-only. Absent from a production bundle: `import.meta.env.DEV` is a
 * compile-time constant, so this whole branch is dropped by the bundler. */
export function configuredFault(): FaultConfig | null {
  if (!import.meta.env.DEV) return null;
  const configured = (globalThis as Record<string, unknown>).__doomFault;
  if (!configured || typeof configured !== 'object') return null;
  const { kind } = configured as FaultConfig;
  return typeof kind === 'string' ? configured as FaultConfig : null;
}
```

In `src/core/ptyClient.ts`, wrap the default socket factory in the constructor:

```ts
      socket: options.socket ?? (() => {
        const host = this.isTauri ? '127.0.0.1' : window.location.hostname || '127.0.0.1';
        // Callbacks installed below consume only message.data or no event fields.
        const real = new WebSocket('ws://' + host + ':1421') as unknown as RecoverySocket;
        const fault = configuredFault();
        return fault ? faultSocket(real, fault) : real;
      }),
```

with `import { configuredFault, faultSocket } from './faultSocket';` at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/faultSocket.test.ts && npm run typecheck`
Expected: PASS, 5 tests; typecheck clean.

- [ ] **Step 5: Prove the seam cannot ship**

Run:

```bash
npm run build && grep -rc 'DoomTermSyntheticVariant\|__doomFault' dist/assets/*.js
```

Expected: every file reports `0`. If any reports non-zero, the `import.meta.env.DEV` guard was not tree-shaken — fix before committing, because a production build that can be told to corrupt its own socket is a security defect, not a test convenience.

- [ ] **Step 6: Commit**

```bash
git add src/core/faultSocket.ts src/core/faultSocket.test.ts src/core/ptyClient.ts
git commit -m "feat(test): dev-only fault-injection socket seam"
```

---

### Task 5: Playwright project and shared fixtures

Extract the daemon lifecycle and terminal helpers out of the 643-line script so any scenario can run alone. This task moves code; it writes no new assertions.

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/fixtures/daemon.ts`
- Create: `e2e/fixtures/terminal.ts`
- Create: `e2e/fixtures/test.ts`
- Modify: `package.json` (add `test:e2e`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `e2e/fixtures/daemon.ts` exports `interface DaemonHandle { port: number; process: ChildProcess; log(): string }`, `isolatedEnv(artifacts: string): NodeJS.ProcessEnv`, `startDaemon(env, requestedPort?: number): Promise<DaemonHandle>`, `stopDaemon(handle: DaemonHandle): Promise<void>` — lifted from `tools/test-frontend-ui.mjs:15-78`.
  - `e2e/fixtures/terminal.ts` exports `visibleTerminal(page)`, `palette(page, search)`, `command(page, text, expectedLine)`, `typeUntilEchoed(page, text, expected)`, `terminalGrid(page, marker)`, `paneProperty(env, sessionId, property)` — lifted from `tools/test-frontend-ui.mjs:74-205`.
  - `e2e/fixtures/test.ts` exports `test` and `expect` — a Playwright `test` with a **worker-scoped** `stack: { port: number; daemonPort: number; env; restartDaemon(): Promise<void> }` and test-scoped `doom: { snapshot(): Promise<DoomSnapshot>; withFault(config: FaultConfig): Promise<void>; disconnect(): Promise<void> }`.

**Two facts the fixture must respect, both established by the existing harness:**

1. **The page reaches the daemon through a `WebSocket` subclass, not a URL parameter.** `ptyClient.ts` hardcodes `ws://<host>:1421`. `tools/test-frontend-ui.mjs:229-240` installs a context init script that subclasses `window.WebSocket` and rewrites port `1421` to the private daemon's port. That script also already exposes `window.__doomTestDisconnect()`, a fault primitive this plan reuses rather than reinvents.
2. **The app is served by `vite preview` on a fixed port carrying the desktop's real CSP**, with only the daemon port substituted (`tools/test-frontend-ui.mjs:222-227`). Because `strictPort` forbids sharing, the preview server and its daemon are **worker-scoped** and bound to `1420 + workerIndex`, so parallel workers do not collide and each worker's CSP still names exactly one daemon port. Playwright gives every test a fresh browser context, so `localStorage` is clean per test and the app never restores a previous test's sessions.

- [ ] **Step 1: Write the failing test**

```ts
// e2e/happy/create.spec.ts
import { test, expect } from '../fixtures/test';
import { visibleTerminal } from '../fixtures/terminal';

test('a new session attaches and echoes a command', async ({ page }) => {
  await page.keyboard.press('Control+Shift+t');
  const terminal = visibleTerminal(page);
  await expect(terminal).toContainText(/[$#]/);
  await terminal.click();
  await page.keyboard.type('echo DOOM_CREATE_OK');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('DOOM_CREATE_OK');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test e2e/happy/create.spec.ts`
Expected: FAIL — no `playwright.config.ts`, so Playwright reports no tests found or cannot resolve `../fixtures/test`.

- [ ] **Step 3: Write the config and fixtures**

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // Each spec owns a daemon and a private tmux socket, so specs are independent.
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  // A real PTY through tmux through a headless emulator is not a 5s operation.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
```

Create `e2e/fixtures/daemon.ts` by moving `startDaemon`, `stopDaemon`, `testEnv` and `bashPath` from `tools/test-frontend-ui.mjs:15-78`, parameterising the artifacts directory and returning a handle rather than a bare port:

```ts
// e2e/fixtures/daemon.ts
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export interface DaemonHandle { port: number; process: ChildProcess; log(): string }

/** A daemon that can never reach the developer's own tmux server or sessions. */
export function isolatedEnv(artifacts: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env, DOOM_HOST: '127.0.0.1', DOOM_PORT: '0', DOOM_AUTH_TOKEN: '',
    TMUX_TMPDIR: artifacts, XDG_RUNTIME_DIR: artifacts,
    // An interactive POSIX shell with none of the user's startup commands.
    SHELL: '/bin/sh', RUST_LOG: 'info',
  };
  delete env.ENV; delete env.BASH_ENV; delete env.DOOM_TERM_NO_TMUX;
  return env;
}

/** Where bash actually is, or null. The bracketed-paste contract needs a shell
 * that implements it; an absent shell is an environment block, never a pass. */
export function bashPath(): string | null {
  const probe = spawnSync('sh', ['-lc', 'command -v bash || true'], { encoding: 'utf8' });
  const found = (probe.stdout ?? '').trim().split('\n')[0];
  return found && existsSync(found) ? found : null;
}

export async function startDaemon(env: NodeJS.ProcessEnv, requestedPort = 0): Promise<DaemonHandle> {
  let log = '';
  const target = resolve(root, process.env.CARGO_TARGET_DIR || 'target');
  const child = spawn(join(target, 'debug', 'doom-term-server'), [], {
    cwd: root, env: { ...env, DOOM_PORT: String(requestedPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon did not start: ${log}`)), 15000);
    const receive = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-32768);
      const match = log.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
    };
    child.stdout!.on('data', receive);
    child.stderr!.on('data', receive);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Daemon exited ${code}: ${log}`)); });
  });
  return { port, process: child, log: () => log };
}

export async function stopDaemon(handle: DaemonHandle): Promise<void> {
  if (handle.process.exitCode !== null) return;
  const exited = once(handle.process, 'exit');
  handle.process.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Daemon did not stop')), 5000)),
  ]);
}
```

Create `e2e/fixtures/terminal.ts` by moving `typeUntilEchoed`, `palette`, `command`, `terminalGrid`, `renderedRowsBetween`, `renderedRowsBetweenAfter`, `hasRenderedLineAfter`, `anchorScrollAt`, `scrollAnchorIsVisible` and `paneProperty` from `tools/test-frontend-ui.mjs:74-205` unchanged — except `paneProperty`, which takes the env as its first argument now that there is no module-level `testEnv` — and adding:

```ts
import type { Page, Locator } from '@playwright/test';

/** Always scope to the visible pane: sibling panes stay mounted through zoom
 * and a bare locator matches all of them. */
export function visibleTerminal(page: Page): Locator {
  return page.getByTestId('raw-terminal').filter({ visible: true }).last();
}
```

Create `e2e/fixtures/test.ts`:

```ts
import { test as base, expect, type PreviewServer } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview } from 'vite';
import { isolatedEnv, root, startDaemon, stopDaemon, type DaemonHandle } from './daemon';
import type { FaultConfig } from '../../src/core/faultSocket';
import type { DoomSnapshot } from '../../src/core/ptyClient';

interface Stack {
  origin: string; env: NodeJS.ProcessEnv; daemonPort: number; restartDaemon(): Promise<void>;
}
interface Worker { stack: Stack }
interface Fixtures {
  doom: {
    snapshot(): Promise<DoomSnapshot>;
    withFault(config: FaultConfig): Promise<void>;
    disconnect(): Promise<void>;
  };
}

export const test = base.extend<Fixtures, Worker>({
  // Worker-scoped: `vite preview` uses strictPort, so one server per worker on
  // its own port. Each worker's CSP names exactly its own daemon port, which
  // keeps the production policy honest instead of widening it to a wildcard.
  stack: [async ({}, use, workerInfo) => {
    const artifacts = mkdtempSync(join(tmpdir(), 'doom-e2e-'));
    const env = isolatedEnv(artifacts);
    let daemon: DaemonHandle = await startDaemon(env, 0);
    await build({ root });
    const policy = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
    const port = 1420 + workerInfo.workerIndex;
    const csp = Object.entries(policy).map(([directive, value]) => `${directive} ${value}`).join('; ')
      .replace('ws://127.0.0.1:1421', `ws://127.0.0.1:${daemon.port}`);
    const server: PreviewServer = await preview({
      root,
      preview: { host: '127.0.0.1', port, strictPort: true, headers: { 'Content-Security-Policy': csp } },
    });
    await use({
      origin: `http://127.0.0.1:${port}`,
      env,
      daemonPort: daemon.port,
      restartDaemon: async () => { await stopDaemon(daemon); daemon = await startDaemon(env, daemon.port); },
    });
    await new Promise<void>((done, fail) => server.httpServer.close(error => error ? fail(error) : done()));
    await stopDaemon(daemon);
    // Only this run's private socket. Never target the user's tmux server.
    (await import('node:child_process')).spawnSync('tmux', ['-L', 'doom-term', 'kill-server'], { env, timeout: 3000 });
  }, { scope: 'worker' }],

  page: async ({ page, stack }, use) => {
    // ptyClient.ts hardcodes ws://<host>:1421. Rewrite the port in the page
    // rather than parameterising the app: the production URL is part of what
    // this suite is testing.
    await page.addInitScript(({ daemonPort }) => {
      const Native = window.WebSocket;
      // @ts-expect-error deliberate replacement of the global constructor
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(String(url));
          if (target.hostname === '127.0.0.1' && target.port === '1421') target.port = String(daemonPort);
          super(target.toString(), protocols);
          ((window as never as { __doomTestSockets: WebSocket[] }).__doomTestSockets ??= []).push(this);
        }
      };
      (window as never as { __doomTestDisconnect(): void }).__doomTestDisconnect = () => {
        const sockets = (window as never as { __doomTestSockets?: WebSocket[] }).__doomTestSockets ?? [];
        const socket = [...sockets].reverse().find(candidate => candidate.readyState === WebSocket.OPEN);
        if (!socket) throw new Error('No open Doom Term socket');
        socket.close(4000, 'fixture disconnect');
      };
    }, { daemonPort: stack.daemonPort });
    await page.goto(stack.origin);
    await expect(page).toHaveTitle(/Doom/i);
    await use(page);
  },

  doom: async ({ page }, use) => {
    await use({
      snapshot: () => page.evaluate(() => (window as never as { __doom(): DoomSnapshot }).__doom()),
      // Must run before any page script: PtyClient's module-scope getInstance()
      // reads the fault at import. addInitScript is the only hook early enough,
      // so arming a fault requires a reload.
      withFault: async config => {
        await page.addInitScript(fault => { (window as Record<string, unknown>).__doomFault = fault; }, config);
        await page.reload();
      },
      disconnect: () => page.evaluate(() => (window as never as { __doomTestDisconnect(): void }).__doomTestDisconnect()),
    });
  },
});

export { expect };
```

Add to `package.json` scripts:

```json
    "test:e2e": "playwright test",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:e2e -- e2e/happy/create.spec.ts`
Expected: PASS. If the daemon binary is missing, the failure must read as an environment block — build it first with `cargo build --bin doom-term-server`.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e package.json
git commit -m "test(e2e): playwright project with per-spec daemon fixtures"
```

---

### Task 6: Port the happy-path scenarios

Move the surviving scenarios out of the monolith, one per file, so a failure in one no longer hides the rest. The two recovery scenarios (`tools/test-frontend-ui.mjs:357`, `:573-584`) are **not** ported — they are deleted in Phase 3 with the feature.

**Files:**
- Create: `e2e/happy/input.spec.ts`, `e2e/happy/split.spec.ts`, `e2e/happy/signals.spec.ts`, `e2e/happy/altscreen.spec.ts`, `e2e/happy/clipboard.spec.ts`, `e2e/happy/workspaces.spec.ts`, `e2e/happy/redraw.spec.ts`
- Modify: `tools/test-frontend-ui.mjs` (delete the ported scenarios)

**Interfaces:**
- Consumes: `test`, `expect` from `e2e/fixtures/test.ts`; helpers from `e2e/fixtures/terminal.ts` (Task 5).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Port one scenario and run it alone**

Move `tools/test-frontend-ui.mjs:400-424` (the Ctrl+C scenario) into:

```ts
// e2e/happy/signals.spec.ts
import { test, expect } from '../fixtures/test';
import { visibleTerminal, command } from '../fixtures/terminal';

test('Ctrl+C interrupts an observed foreground process', async ({ page }) => {
  await page.keyboard.press('Control+Shift+t');
  const terminal = visibleTerminal(page);
  await expect(terminal).toContainText(/[$#]/);
  await command(page, 'sleep 120', '');
  await terminal.click();
  await page.keyboard.press('Control+c');
  await expect(terminal).toContainText(/[$#]/);
});
```

Run: `npm run test:e2e -- e2e/happy/signals.spec.ts`
Expected: PASS in isolation — the property the monolith never had.

- [ ] **Step 2: Port the remaining scenarios**

One file each, copying the assertions verbatim from `tools/test-frontend-ui.mjs`:
`input.spec.ts` ← lines 215-257 (startup, real shell I/O, Unicode);
`clipboard.spec.ts` ← 426-444 (quick-select and real clipboard);
`altscreen.spec.ts` ← 446-471 (alternate-screen editor, file save, screen restoration);
`split.spec.ts` ← 473-506 (palette, settings, live split, mounted siblings through zoom);
`workspaces.spec.ts` ← 508-555 (multi-workspace selection, background hook activation);
`redraw.spec.ts` ← 586-620 (cursor hide/show, multi-frame redraw, scroll geometry).

- [ ] **Step 3: Run the whole ported suite**

Run: `npm run test:e2e -- e2e/happy`
Expected: PASS, 7 specs, running in parallel.

- [ ] **Step 4: Delete the ported scenarios from the monolith**

Remove the ported blocks from `tools/test-frontend-ui.mjs`, leaving only the two recovery scenarios (warm socket recovery, cold daemon restart) that Phase 3 deletes. Keep `npm run test:ui` pointing at it until then.

Run: `npm run test:ui`
Expected: PASS — the two remaining scenarios still work.

- [ ] **Step 5: Commit**

```bash
git add e2e/happy tools/test-frontend-ui.mjs
git commit -m "test(e2e): split happy-path scenarios into isolated specs"
```

---

### Task 7: The red fault specs

The deliverable of this phase. Each spec injects one fault and asserts **containment** — that the blast radius is one unit. Against today's code they fail; that failure is the executable evidence for Findings 1–9.

**Files:**
- Create: `e2e/faults/unknown-variant.spec.ts`, `e2e/faults/malformed-frame.spec.ts`, `e2e/faults/pane-isolation.spec.ts`, `e2e/faults/create-offline.spec.ts`, `e2e/faults/render-throw.spec.ts`
- Create: `docs/superpowers/plans/2026-09-17-phase-0-baseline.md` (the recorded red output)

**Interfaces:**
- Consumes: `test`, `expect`, `doom` fixture from `e2e/fixtures/test.ts`; `visibleTerminal` from `e2e/fixtures/terminal.ts`; `FaultConfig` from `src/core/faultSocket.ts`.
- Produces: nothing consumed by later tasks. Phase 1 turns these green.

- [ ] **Step 1: Write the containment spec for Finding 3**

```ts
// e2e/faults/unknown-variant.spec.ts
import { test, expect } from '../fixtures/test';
import { visibleTerminal } from '../fixtures/terminal';

/** Finding 3 + Finding 1: this is the eb006b9 shape. A DemuxEvent variant the
 * client has never been taught must not end the session, and must never reach
 * the socket. Red until Phase 1 cuts the escalation edge and Phase 2 makes the
 * validators forward-compatible. */
test('an unknown stream variant does not disconnect the client', async ({ page, doom }) => {
  await doom.withFault({ kind: 'unknown-variant' });
  await page.keyboard.press('Control+Shift+t');
  const terminal = visibleTerminal(page);
  await expect(terminal).toContainText(/[$#]/);
  await terminal.click();
  await page.keyboard.type('echo DOOM_VARIANT_OK');
  await page.keyboard.press('Enter');

  const snapshot = await doom.snapshot();
  expect(snapshot.connection.status, 'the socket must survive an unknown variant').toBe('ready');
  expect(snapshot.counters.unknownVariants, 'the skipped variant must be counted').toBeGreaterThan(0);
  expect(snapshot.counters.attachmentsFaulted, 'no attachment may fault').toBe(0);
});
```

- [ ] **Step 2: Run it and record the red**

Run: `npm run test:e2e -- e2e/faults/unknown-variant.spec.ts`
Expected: **FAIL.** `snapshot.connection.status` is `disconnected` (the parse threw, the attachment failed, `onFailure` restarted the socket) and `counters.unknownVariants` is `0` (nothing counts what it cannot recognise). Capture the exact output — it goes in the baseline document in Step 6.

- [ ] **Step 3: Write the pane-isolation spec for Finding 1**

```ts
// e2e/faults/pane-isolation.spec.ts
import { test, expect } from '../fixtures/test';
import { palette, visibleTerminal } from '../fixtures/terminal';

/** Finding 1, stated as the canonical assertion: pane B still echoes after
 * pane A has faulted. Nothing weaker would have caught this class of bug. */
test('a faulted pane does not stop its sibling', async ({ page, doom }) => {
  await page.keyboard.press('Control+Shift+t');
  await expect(visibleTerminal(page)).toContainText(/[$#]/);
  // Splitting is a palette action, not a chord: keymap.ts binds no Ctrl+Shift+D.
  await palette(page, 'Split Right');
  await expect(page.getByTestId('raw-terminal').filter({ visible: true })).toHaveCount(2);
  const sibling = visibleTerminal(page);
  await expect(sibling).toContainText(/[$#]/);

  await doom.withFault({ kind: 'unknown-variant' });

  await sibling.click();
  await page.keyboard.type('echo DOOM_SIBLING_ALIVE');
  await page.keyboard.press('Enter');
  await expect(sibling, 'a sibling pane must keep taking input').toContainText('DOOM_SIBLING_ALIVE');

  const snapshot = await doom.snapshot();
  const faulted = snapshot.bindings.filter(binding => binding.attachment === 'failed');
  expect(faulted.length, 'at most one pane may fault').toBeLessThanOrEqual(1);
});
```

- [ ] **Step 4: Write the remaining three specs**

```ts
// e2e/faults/malformed-frame.spec.ts
import { test, expect } from '../fixtures/test';

/** Finding 4: a single bad frame is not evidence that the peer is
 * incompatible, and `incompatible` today has no edge out of it. */
test('a malformed frame drops the frame, not the connection', async ({ page, doom }) => {
  await doom.withFault({ kind: 'malformed-frame', afterEvent: 'Negotiated' });
  await expect.poll(async () => (await doom.snapshot()).counters.framesDropped).toBeGreaterThan(0);
  await expect.poll(async () => (await doom.snapshot()).connection.status,
    { message: 'the socket must reconnect rather than die incompatible' }).toBe('ready');
});
```

```ts
// e2e/faults/create-offline.spec.ts
import { test, expect } from '../fixtures/test';

/** Finding 7: an 'unsent' intent has no deadline and never settles, so
 * Ctrl+Shift+T silently does nothing. Creation must either happen or say why. */
test('creating a session with no daemon reports a refusal', async ({ page, stack, doom }) => {
  await stack.restartDaemon();     // leaves a window with no daemon listening
  await page.keyboard.press('Control+Shift+t');
  await expect.poll(async () => {
    const snapshot = await doom.snapshot();
    return snapshot.bindings.some(binding => binding.refusal !== null)
      || snapshot.counters.createsFailed > 0;
  }, { message: 'an unsent creation must surface, never hang silently', timeout: 20_000 }).toBe(true);
});
```

```ts
// e2e/faults/render-throw.spec.ts
import { test, expect } from '../fixtures/test';
import { visibleTerminal } from '../fixtures/terminal';

/** Finding 5: React 19 unmounts the whole tree on an uncaught render error and
 * there is no boundary anywhere in src/. One bad pane must not blank the app. */
test('a render throw in one pane leaves the rest of the app mounted', async ({ page }) => {
  await page.keyboard.press('Control+Shift+t');
  await expect(visibleTerminal(page)).toContainText(/[$#]/);
  await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="pane-leaf"]');
    pane?.dispatchEvent(new CustomEvent('doom:test-render-throw', { bubbles: true }));
  });
  // StatusPlate has no testid; it is a labelled role="group" (StatusPlate.tsx:84).
  await expect(
    page.getByRole('group', { name: /Status plate/ }),
    'the status plate must survive a pane fault',
  ).toBeVisible();
});
```

> Note for the implementer: `render-throw.spec.ts` needs a throwing hook that Phase 1 adds alongside the error boundary. Until then it fails because nothing listens for `doom:test-render-throw`, so the pane never throws and the assertion passes vacuously. **A vacuous pass is worse than a red**, so add this assertion first and confirm it fails:
>
> ```ts
>   // Guard: prove the fault actually fired before trusting the survival check.
>   await expect(page.getByTestId('pane-error'), 'the pane must have faulted').toBeVisible();
> ```
>
> With no boundary and no hook, `pane-error` never appears and the spec is correctly red. Do not add the hook in this phase.

- [ ] **Step 5: Run the fault suite and confirm every spec is red for the stated reason**

Run: `npm run test:e2e -- e2e/faults`
Expected: **5 FAIL.** Read each failure and confirm it fails for the reason the spec's comment names, not for a fixture bug. A fault spec that fails because a locator is wrong proves nothing.

- [ ] **Step 6: Record the baseline**

Write `docs/superpowers/plans/2026-09-17-phase-0-baseline.md` containing the verbatim output of Step 5, one section per spec, each annotated with the Finding it demonstrates. This is the document Phase 1 is measured against.

- [ ] **Step 7: Commit**

```bash
git add e2e/faults docs/superpowers/plans/2026-09-17-phase-0-baseline.md
git commit -m "test(e2e): red fault specs documenting Findings 1-9

These fail on purpose. Each injects one fault and asserts containment --
that the blast radius is one unit. Against today's code the blast radius
is the application, which is the defect. Phase 1 turns them green."
```

---

### Task 8: The diagnostics overlay

The human-facing half of the substrate, reading the same snapshot the tests read.

**Files:**
- Create: `src/components/DiagnosticsOverlay.tsx`
- Test: `src/components/DiagnosticsOverlay.test.tsx`
- Modify: `src/core/keymap.ts` (add the chord), `src/App.tsx` (render it)

**Interfaces:**
- Consumes: `DoomSnapshot` from `./ptyClient`; `diagnostics` from `./diagnostics`.
- Produces: `DiagnosticsOverlay: React.FC<{ snapshot: DoomSnapshot; onClose(): void }>`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/DiagnosticsOverlay.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiagnosticsOverlay } from './DiagnosticsOverlay';
import type { DoomSnapshot } from '../core/ptyClient';

const snapshot: DoomSnapshot = {
  connection: { status: 'ready', message: null, daemonEpoch: 'a'.repeat(32) },
  bindings: [
    { id: 'node-1', incarnation: 'b'.repeat(32), attachment: 'ready', refusal: null, createStatus: null },
    { id: 'node-2', incarnation: null, attachment: null, refusal: 'Create failed', createStatus: 'failed' },
  ],
  entries: [{ at: 0, kind: 'refusal', name: 'input', sessionId: 'node-2', requestId: null, reason: 'Create failed' }],
  counters: { framesDropped: 0, unknownEvents: 0, unknownVariants: 3, reconnects: 1,
    createsAttempted: 2, createsFailed: 1, attachmentsFaulted: 0 },
};

describe('DiagnosticsOverlay', () => {
  it('names every binding and its attachment state', () => {
    render(<DiagnosticsOverlay snapshot={snapshot} onClose={() => {}} />);
    expect(screen.getByText('node-1')).toBeTruthy();
    expect(screen.getByText('node-2')).toBeTruthy();
    expect(screen.getByText('Create failed')).toBeTruthy();
  });

  it('renders an unmeasured attachment as -- and never as idle or 0', () => {
    render(<DiagnosticsOverlay snapshot={snapshot} onClose={() => {}} />);
    const row = screen.getByTestId('diagnostics-binding-node-2');
    expect(row.textContent).toContain('--');
    expect(row.textContent).not.toContain('idle');
  });

  it('shows counters that are non-zero', () => {
    render(<DiagnosticsOverlay snapshot={snapshot} onClose={() => {}} />);
    expect(screen.getByText(/unknownVariants/)).toBeTruthy();
    expect(screen.getByText(/\b3\b/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/DiagnosticsOverlay.test.tsx`
Expected: FAIL — cannot resolve `./DiagnosticsOverlay`.

- [ ] **Step 3: Implement the overlay**

```tsx
// src/components/DiagnosticsOverlay.tsx
import React from 'react';
import type { DoomSnapshot } from '../core/ptyClient';

/** Transient, per Axiom 2: no persistent chrome. Reads the same snapshot the
 * e2e suite reads, so a human and a test never disagree about what happened. */

/** Axiom 3: an unmeasured field is `--`, never coerced to 0, idle or ok. */
const shown = (value: string | null): string => value ?? '--';

const STATE_COLOR: Record<string, string> = {
  ready: 'var(--st-pass)',
  failed: 'var(--st-fail)', incompatible: 'var(--st-fail)', missing: 'var(--st-fail)',
  attaching: 'var(--st-wait)', 'catching-up': 'var(--st-wait)', 'awaiting-ready': 'var(--st-wait)',
  disconnected: 'var(--st-idle)', closed: 'var(--st-idle)',
};
const color = (status: string | null): string => (status && STATE_COLOR[status]) || 'var(--st-idle)';

export const DiagnosticsOverlay: React.FC<{ snapshot: DoomSnapshot; onClose(): void }> = ({ snapshot, onClose }) => (
  <div
    role="dialog"
    aria-label="Diagnostics"
    data-testid="diagnostics-overlay"
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    onClick={onClose}
  >
    <div
      className="w-[46rem] max-h-[80vh] overflow-auto p-3 font-mono text-[11px]"
      style={{ background: 'var(--ground)', boxShadow: 'var(--bevel-up)', color: 'var(--ink)' }}
      onClick={event => event.stopPropagation()}
    >
      <div className="mb-2" style={{ color: color(snapshot.connection.status) }}>
        ▪ CONNECTION {snapshot.connection.status.toUpperCase()} · EPOCH {shown(snapshot.connection.daemonEpoch)}
        {snapshot.connection.message ? ` · ${snapshot.connection.message}` : ''}
      </div>

      <div className="mb-2 p-2" style={{ boxShadow: 'var(--bevel-dn)' }}>
        {snapshot.bindings.length === 0 && <div>-- no sessions</div>}
        {snapshot.bindings.map(binding => (
          <div key={binding.id} data-testid={`diagnostics-binding-${binding.id}`} className="flex gap-3">
            <span className="w-32 shrink-0">{binding.id}</span>
            <span className="w-28 shrink-0" style={{ color: color(binding.attachment) }}>
              {shown(binding.attachment)}
            </span>
            <span className="w-20 shrink-0">{shown(binding.createStatus)}</span>
            <span style={{ color: binding.refusal ? 'var(--st-fail)' : undefined }}>{shown(binding.refusal)}</span>
          </div>
        ))}
      </div>

      <div className="mb-2 flex flex-wrap gap-x-4">
        {Object.entries(snapshot.counters).map(([name, value]) => (
          <span key={name} style={{ color: value > 0 ? 'var(--st-live)' : 'var(--st-idle)' }}>
            {name} {value}
          </span>
        ))}
      </div>

      <div className="p-2" style={{ boxShadow: 'var(--bevel-dn)' }}>
        {snapshot.entries.slice(-40).reverse().map((entry, index) => (
          <div key={`${entry.at}-${index}`} className="flex gap-3">
            <span className="w-10 shrink-0" style={{ color: 'var(--st-idle)' }}>{entry.kind[0].toUpperCase()}</span>
            <span className="w-52 shrink-0">{entry.name}</span>
            <span className="w-32 shrink-0">{shown(entry.sessionId)}</span>
            <span>{shown(entry.reason)}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);
```

No `rounded-*` class, no blurred shadow, no icon import — the glyph is a literal `▪`. `bg-black/60` is a flat scrim, not a blur.

- [ ] **Step 4: Bind the chord**

`Ctrl+Shift+D` is **free** — verified against `src/core/keymap.ts`, which binds `k p a z t w o m c y e v f`, the arrows, space, digits and `{` `}`, and binds no split chord at all (splitting is the `Split Right` / `Split Down` palette action). Add it beside the other view-local chords:

```ts
  {
    id: 'toggle-diagnostics',
    title: 'Toggle Diagnostics Overlay',
    chords: [{ key: 'd', ctrl: true, shift: true }],
  },
```

Never bind an unadorned `Ctrl+[A-Z]`: those belong to the child process.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/components/DiagnosticsOverlay.test.tsx src/core/keymap.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Verify the material invariants**

Run: `npm test`
Expected: PASS — `src/styles/material.test.js` and `FrontendVisualIntegrity.test.tsx` enforce zero radius, hard bevels and AA contrast on the new surface.

- [ ] **Step 7: Commit**

```bash
git add src/components/DiagnosticsOverlay.tsx src/components/DiagnosticsOverlay.test.tsx src/core/keymap.ts src/App.tsx
git commit -m "feat(diagnostics): transient overlay over the window.__doom snapshot"
```

---

### Task 9: Correlation ids end to end

Spec A2. A refusal visible in the UI must map to a daemon log line without guesswork. The daemon uses the `log` crate (`log::info!`/`log::warn!`), not `tracing` spans — `RUST_LOG=info` is already set by the e2e env.

**Files:**
- Modify: `src/core/ptyClient.ts` (`request()` at `:321`, `rejectRequests()` at `:341`)
- Modify: `backend/src/recovery.rs` (the request dispatch that reads `request_id`)
- Test: `src/core/diagnostics.correlation.test.ts`
- Create: `e2e/faults/correlation.spec.ts`

**Interfaces:**
- Consumes: `diagnostics` from Task 1; `DaemonHandle.log()` from Task 5.
- Produces: ledger entries whose `requestId` is the `request_id` the daemon saw, and a daemon log line of the form `request <request_id> <Action> refused: <reason>`.

- [ ] **Step 1: Write the failing client test**

```ts
// src/core/diagnostics.correlation.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PtyClient } from './ptyClient';
import type { RecoverySocket } from './recoveryConnection';
import { diagnostics } from './diagnostics';

function offlineSocket(): RecoverySocket {
  return { readyState: 0, bufferedAmount: 0, onopen: null, onclose: null,
    onerror: null, onmessage: null, send() {}, close() {} };
}

describe('request correlation', () => {
  beforeEach(() => diagnostics.clear());

  it('stamps a refused request with the id the daemon would have seen', async () => {
    const client = new PtyClient({ socket: offlineSocket });
    await client.listSessions().catch(() => undefined);
    const correlated = diagnostics.snapshot().entries.filter(entry => entry.requestId !== null);
    expect(correlated.length).toBeGreaterThan(0);
    expect(correlated[0].requestId).toMatch(/^request-\d+$/);
    expect(correlated[0].reason).toContain('not sent');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/diagnostics.correlation.test.ts`
Expected: FAIL — `expected 0 to be greater than 0`; nothing stamps a request id yet.

- [ ] **Step 3: Stamp the id on the client**

In `request()`, record the outcome with its id:

```ts
      const outcome = this.connection.send(action, { ...payload, request_id: requestId });
      if (outcome !== 'sent') {
        this.requests.delete(requestId); clearTimeout(timer);
        const reason = outcome === 'unknown' ? action + ' delivery is unknown' : action + ' was refused; nothing was sent';
        diagnostics.record({ kind: 'refusal', name: 'request:' + action, sessionId: sessionId ?? null,
          requestId, reason });
        reject(new Error(reason));
      }
```

and in the timeout callback:

```ts
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        const reason = action + ' timed out' + (mutating ? '; delivery is unknown. Check before retrying.' : '');
        diagnostics.record({ kind: 'refusal', name: 'request:' + action, sessionId: sessionId ?? null,
          requestId, reason });
        reject(new Error(reason));
      }, timeout);
```

- [ ] **Step 4: Emit the matching daemon line**

In `backend/src/recovery.rs`, at the point where a request is dispatched and refused, log the id the client sent. The message shape matters — the e2e spec greps for it:

```rust
log::info!("request {} {} refused: {}", request_id, action, reason);
```

- [ ] **Step 5: Write the end-to-end correlation spec**

```ts
// e2e/faults/correlation.spec.ts
import { test, expect } from '../fixtures/test';

/** Spec A2: a refusal the user can see must be findable in the daemon log by
 * its id alone. This is what turns "input was refused" into a diagnosis. */
test('a client refusal id appears in the daemon log', async ({ page, stack, doom }) => {
  await page.keyboard.press('Control+Shift+t');
  await expect.poll(async () => (await doom.snapshot()).bindings.length).toBeGreaterThan(0);
  await stack.restartDaemon();
  await page.keyboard.press('Control+Shift+t');

  const refusal = await expect.poll(async () => {
    const snapshot = await doom.snapshot();
    return snapshot.entries.find(entry => entry.kind === 'refusal' && entry.requestId !== null) ?? null;
  }, { message: 'a refusal must carry a correlation id', timeout: 20_000 }).not.toBeNull();
  expect(refusal).toBeTruthy();
});
```

- [ ] **Step 6: Run both**

Run: `npx vitest run src/core/diagnostics.correlation.test.ts && npm run test:e2e -- e2e/faults/correlation.spec.ts`
Expected: the unit test PASSES. The e2e spec may be **red** — it depends on Phase 1 making an offline creation surface a refusal at all (Finding 7). If it is red, record it in the baseline with the other four and note that Phase 1 turns it green.

- [ ] **Step 7: Commit**

```bash
git add src/core/ptyClient.ts backend/src/recovery.rs src/core/diagnostics.correlation.test.ts e2e/faults/correlation.spec.ts
git commit -m "feat(diagnostics): correlate client refusals with daemon log lines"
```

---

### Task 10: Phase gate

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Run the full existing gate**

Run: `npm run agent:verify`
Expected: PASS. Phase 0 changed no behavior, so every pre-existing suite must be green. A regression here means an instrumentation call site did more than observe.

- [ ] **Step 2: Confirm the fault suite is still red for the right reasons**

Run: `npm run test:e2e -- e2e/faults`
Expected: FAIL, matching `2026-09-17-phase-0-baseline.md` exactly — the five specs from Task 7 plus `correlation.spec.ts` from Task 9 if it landed red. If a spec has started passing, the baseline is wrong or the spec is not testing what it claims.

- [ ] **Step 3: Add the happy-path e2e to the gate**

`e2e/faults` is deliberately excluded until Phase 1 turns it green.

```json
    "test:e2e": "playwright test",
    "test:e2e:happy": "playwright test e2e/happy",
    "agent:verify": "npm run typecheck && npm test && npm run build && npm run hud:check && npm run cargo:check && npm run cargo:test && npm run check:tauri && npm run test:e2e:happy",
```

- [ ] **Step 4: Run the new gate**

Run: `npm run agent:verify`
Expected: PASS, now including the 7 isolated happy-path specs.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(ci): gate the happy-path e2e suite in agent:verify"
```

---

## Phase 0 exit criteria

- `window.__doom()` returns connection status, every binding's attachment state and refusal reason, a bounded event ring, and seven counters.
- A production build contains no fault-injection code (Task 4, Step 5).
- Any e2e scenario runs alone: `npm run test:e2e -- e2e/happy/<name>.spec.ts`.
- Every fault spec fails for the reason its comment names — not for a fixture bug — recorded verbatim in `2026-09-17-phase-0-baseline.md`.
- A client refusal carries a `requestId` that matches a daemon log line.
- `npm run agent:verify` passes and now includes the happy-path e2e suite.
- No runtime behavior changed. Every pre-existing suite is green.
