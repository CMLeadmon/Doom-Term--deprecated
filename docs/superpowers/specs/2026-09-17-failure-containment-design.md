# Failure Containment and the Removal of Recovery: Design

**Status**: Design, 2026-09-17
**Branch**: `fix/failure-containment`
**Execution plans**: written after this document is approved — one per phase,
`../plans/2026-09-17-diagnostics-substrate.md`,
`../plans/2026-09-17-failure-containment.md`,
`../plans/2026-09-17-recovery-removal.md`.

**Supersedes**: [`2026-09-09-sequenced-recovery-design.md`](2026-09-09-sequenced-recovery-design.md)
and [`../plans/2026-09-10-sequenced-recovery.md`](../plans/2026-09-10-sequenced-recovery.md).
Those documents remain as history; the subsystem they specify is deleted here.

---

## The question

The reported symptom is that Doom Term "commonly fails to create new terminals
or receive input," and that one bad state takes the whole application with it.

That is not a collection of bugs. It is one architectural decision, observed
from several angles.

The repository's philosophy is **fail closed and never lie** — Axiom 3, *never
invent telemetry*, and the refusal to queue, replay, or assume delivery
anywhere in the paste and input contracts. That philosophy is correct and this
document does not weaken it.

The defect is that the philosophy is applied at **the wrong granularity**. The
unit that fails is the entire application, and several of the states it fails
into are *absorbing* — there is no edge out of them. A pane's stream parser
disagreeing about a sequence number takes down the socket that every other pane
shares. A daemon event the client has not been taught closes the connection
permanently, with no retry and no affordance. A single failed `Create` poisons
one pane's input path for the remainder of the process lifetime.

So: keep fail-closed, shrink the failure domain, and make every refusal
attributable. Then delete the subsystem that generates most of the failures in
the first place.

---

## What is actually true today

Ten findings, read out of the code rather than out of the architecture.

### Finding 1. One pane's fault restarts every pane's socket

`src/core/ptyClient.ts:240` is the whole of it:

```ts
onFailure: reason => this.connection.restart(reason),
```

`SessionAttachment.fail()` (`src/core/sessionAttachment.ts:71`) is reached from
**20 `throw` sites** inside the attachment state machine, every one of them
funnelled through the `catch { this.fail(); return true; }` at
`sessionAttachment.ts:161`. `fail()` calls `onFailure`, which calls
`RecoveryConnection.restart()`, which disconnects the one shared socket and
resets every binding in the client.

There is one socket and one failure domain. Pane A asserting that a record
arrived outside its captured phase disconnects pane B, pane C, and every
in-flight request the application had outstanding.

`ptyClient.ts:305` is the same edge again, reached from a different direction:

```ts
void binding.attachment.attach('attach-' + this.nextRequestId++)
  .catch(() => this.connection.restart('Attachment failed; no input was replayed'));
```

### Finding 2. Nearly all of those 20 assertions exist only to serve recovery

Of the 20 `throw` sites, the substantial majority are continuity bookkeeping for
resume and rebuild — `'Duplicate attach result'`, `'Missing warm parser'`,
`'Rebuild requires a fresh durable stream'`, `'Cut precedes requested cursor'`,
`'Record before stream begin'`, `'Record outside its captured phase'`,
`'Record identity changed'`, `'Invalid captured cut'`, `'Unacknowledged
readiness'`, `'Unexpected history'`.

None of them describe a terminal that cannot work. They describe a *screen
reconstruction* that cannot be proven exact. The state machine then treats an
unprovable reconstruction the way it would treat a dead process.

**The bloat and the fragility are the same object.** This is the single most
important finding in this document, and it is why removal and remediation are
one project rather than two.

### Finding 3. Every validator is a closed world, and the innermost one is fatal

`src/core/streamProtocol.ts` validates three nested levels, and each ends the
same way:

```ts
case 'RemoteEnrichment': …
case 'StreamFault':      …
default: return invalid();     // :109  — event variant
default: return invalid();     // :119  — record payload type
default: return invalid();     // :67   — fault reason
```

`invalid()` throws. A throw at `:109` propagates out of `parseStreamRecord`,
into `SessionAttachment.record()`, into the `catch { this.fail(); }` at
`sessionAttachment.ts:161`, into `onFailure`, into `connection.restart()`.

**This is not hypothetical.** It is `eb006b9`, the most recent commit on `main`,
whose own message reads:

> DemuxEvent gained a RemoteEnrichment variant and the daemon emits it on every
> remote prompt. The client's v2 stream validator had no case for it and fell
> through to `default: invalid()`, which throws. sessionAttachment's parse threw,
> the attachment failed, the connection tore down, and every in-flight write
> rejected with "Connection disconnected; delivery is unknown."

> It reproduced only for someone who had installed the remote snippet — which is
> to say, only for someone actually using the feature.

The fix added `case 'RemoteEnrichment'` and a contract test for it. The closed
world remains. **The next `DemuxEvent` variant added on the Rust side destroys
every session on any client that has not been taught it**, and the failure
surfaces as a lost connection rather than as an unknown event — which is why it
reads as "one snafu killed the whole application."

The distinction the code does not draw, and needs to: *I do not recognize this
variant* is not the same fact as *this variant is malformed*. The first is
forward compatibility. Only the second is corruption.

### Finding 4. An unknown frame is fatal, permanently

A second, independent path to the same outcome, at the transport rather than the
parser. `src/core/recoveryConnection.ts:131`:

```ts
else this.disconnect('incompatible',
  'Invalid or incompatible recovery protocol; update both shells together', false);
```

The third argument is `retry`. It is `false`. `disconnect` schedules a reconnect
timer only when `retry` is set (`recoveryConnection.ts:85`), so this transition
has no edge out of it. The socket is dead for the lifetime of the page.

It is reached by: a frame that is not a string, a frame over 4 MiB, a frame that
is not JSON, a frame whose `event` is not a string, **and any event name that
arrives while the connection is not yet `ready`** (`recoveryConnection.ts:175`).

Where Finding 3 kills the session and reconnects, this one kills the socket and
stays dead. Both present to the user as the application ceasing to work; only
one of them has an edge out.

### Finding 5. There is no React error boundary anywhere

A search of `src/` for `ErrorBoundary`, `componentDidCatch`,
`getDerivedStateFromError`, `window.onerror`, and `unhandledrejection` returns
**nothing**.

React 19 unmounts the entire tree on an uncaught render error. One pane
rendering one bad row blanks the window — status plate, every other pane, and
all of the layout — with no message. This is the most literal form of "one
invalid state causes the entire application to fail," and it is unrelated to the
PTY layer entirely.

### Finding 6. A failed `Create` poisons that pane's input forever

`ptyClient.ts:298` sets `binding.reason` when a creation intent fails.
`inputReadiness()` at `ptyClient.ts:379` consults it first:

```ts
inputReadiness(id: string): string | null {
  const binding = this.bindings.get(id);
  if (binding?.reason) return binding.reason;
```

Nothing ever clears `binding.reason`. Every subsequent `writeToSession`,
`submitCommandToSession`, `sendSignalToSession`, and `pasteToSession` for that
pane returns the original failure string, regardless of what the attachment
later achieves. The pane can reach `ready` and still refuse every keystroke.

### Finding 7. A creation intent that is never sent never settles

`createSession` registers an intent at status `'unsent'` and calls
`pumpBindings()`, which returns immediately when the connection is not ready.
There is no timer on an unsent intent and no rejection path for one.

Combined with Finding 4: once the socket is permanently `incompatible`,
`Ctrl+Shift+T` allocates a pane, sets an intent, and silently does nothing —
forever, with no error, no toast, and a promise that never settles. This is
precisely the reported "fails to create new terminals."

### Finding 8. Four stuck attachments starve every later one

`ptyClient.ts:303` gates attachment on `this.attaching.size < 4`, and
`ptyClient.ts:238` is the only place an id leaves that set:

```ts
if (terminalStates.has(state.status)) { this.attaching.delete(id); this.pumpBindings(); }
```

`catching-up` and `awaiting-ready` are not in `terminalStates`
(`ptyClient.ts:62`). An attachment that reaches `catching-up` and then stops
advancing — a stalled stream, a daemon that never sends `StreamCaughtUp` — holds
its slot indefinitely. Four such panes and no further pane in the application
can ever attach.

### Finding 9. The only manual reconnect in the application is unreachable

`src/App.tsx:200` is the sole caller of `ptyClient.connect()` outside the
constructor:

```ts
const failedNode = workspaceNodes.find(isSessionFailed);
if (failedNode) { /* jump to it */ }
else if (!ptyClient.getIsConnected()) { ptyClient.connect(); ... }
```

And `isSessionFailed` (`App.tsx:37`) is:

```ts
const isSessionFailed = (n: SessionNode) =>
  n.agentState === 'errored' || (n.lastExitCode != null && n.lastExitCode !== 0);
```

A non-zero exit code is an ordinary event in a terminal. A `grep` that matched
nothing, a failing test run, a `false` — any of these makes the health chip jump
to that pane instead of reconnecting. After the first non-zero exit in any pane,
the user's only route back from a dead socket is reloading the application.

### Finding 10. The browser suite is one sequential script that never visits a fault

`tools/test-frontend-ui.mjs` is 643 lines, a single `main()`, one browser page,
one daemon, twelve scenarios in fixed order. A failure in scenario three means
scenarios four through twelve never execute. No scenario can be run alone.

It is not in `npm run agent:verify` — only `npm test`, `typecheck`, `build`,
`hud:check`, `cargo:check`, `cargo:test`, and `check:tauri` are.

And it is entirely happy-path. It kills and restarts the daemon (a deliberate
process fault, scenario eleven), but it never sends a malformed frame, never
sends an unknown event, never stalls a socket, never fails a `Create`, and never
faults one pane to observe whether another survives.

**Every defect in Findings 1 through 9 lives on a code path that no browser test
has ever executed.** That is the debugging architecture problem, and it is why
this document sequences observability before repair.

`eb006b9`'s own post-mortem reaches the same conclusion from the inside:

> Three test layers missed it because each stopped at its own boundary: the
> demuxer test asserted the event is produced, the backend test drove a real
> frame through a real PTY and checked telemetry, and no test ever carried the
> resulting RECORD across the [client boundary].

Three green suites, one production outage, and the gap between them is exactly
the seam this document's fault specs are built to cover.

---

## The invariants

Three, in priority order. Every decision below is a consequence of these.

**F1 — Containment.** A fault's blast radius is the smallest unit that owns the
faulty thing. Faults propagate downward (a dead socket disables its panes) and
never upward (a dead pane never touches the socket).

**F2 — No absorbing states.** No state is permanently unrecoverable without a
user-visible affordance. Every terminal state either retries under backoff or
renders an action that leaves it.

**F3 — Attributable refusal.** Fail-closed is preserved. Every refusal names the
unit that refused, the reason, and a correlation id — legible to a human in the
application and readable by a test as structured data.

F3 is the *addition* to the existing philosophy. Doom Term already refuses
correctly; what it does not do is say who refused, or why, in a form anything
can act on.

---

## Track A — The diagnostics substrate

This is the centerpiece. It ships first, changes no behavior, and is what makes
Tracks B, C and D verifiable at all.

### A1. One state ledger

A single read-only accessor, `window.__doom`, exposing:

- connection status, plus a bounded history of transitions with their reasons
- every binding: id, incarnation, attachment status, refusal reason, create
  intent status
- a bounded ring of protocol events: name, direction, session id, correlation
  id, timestamp
- counters: frames dropped, unknown events ignored, reconnects, creates
  attempted, creates failed, attachments faulted

**The ring stores no payload bytes.** Event names and identities only. Terminal
contents never enter diagnostics — the same rule `recoveryConnection.ts` already
states for its own error paths, and the reason `ConsumerFault` deliberately
carries no cause.

The ledger is *derived observation*. It reads state that already exists and owns
none of its own. A second source of truth would be a new class of bug.

This is what converts a test from asserting "the terminal has no text" to
asserting "pane B's attachment is `ready` and its refusal reason is null while
pane A is `failed`." Causes, not pixels.

### A2. Correlation ids end to end

`request_id` already exists on every request. Carry it into the daemon's
`tracing` spans and back out on every refusal, so a refusal visible in the UI
maps to a daemon log line without guesswork.

### A3. A transient diagnostics overlay

`Ctrl+Shift+D`, rendering the A1 ledger. Transient, per Axiom 2 — no persistent
chrome. Four materials, five state colors, `--` for anything unmeasured, per
Axiom 3 and 4.

Human and test read the same source of truth.

### A4. The fault-injection seam

`PtyClient`'s constructor already accepts `options.socket`; `getInstance()`
ignores it. Widen that into the deliberate test seam, on three axes:

| Axis | Mechanism | Faults |
|---|---|---|
| Client | injected socket factory | unknown event name, **unknown stream-event variant** (the `eb006b9` shape), malformed frame, oversized frame, silent stall, mid-stream close |
| Daemon | `DOOM_FAULT=…`, debug builds only | forced `Create` failure, attach refusal, delayed reply, dropped response |
| Process | kill/restart the daemon | already implemented in the existing harness |

The daemon seam must be `#[cfg(debug_assertions)]` or equivalent. It is never
compiled into a release binary.

---

## Track B — Containment

Four failure domains with one-way edges, replacing the current single domain.

| Domain | Owns | On fault |
|---|---|---|
| Render | one pane's React subtree | paint that pane's recess with the reason and a retry; siblings keep rendering |
| Pane | `SessionAttachment` | disconnect and reattach *this* attachment only |
| Transport | the socket | backoff reconnect; only a version mismatch is fatal |
| Daemon | the process | supervisor restarts; panes reattach to their tmux panes |

### B1. Per-pane error boundary

Wraps each pane leaf. Renders the failure in the recess with the reason and a
retry control. Addresses Finding 5.

### B2. Cut the three escalation edges

- `ptyClient.ts:240` — `onFailure` stops calling `connection.restart`. An
  attachment fault disconnects and re-attaches that attachment.
- `ptyClient.ts:305` — a rejected `attach()` marks that binding retryable, not
  the socket dead.
- `sessionAttachment.ts:86` — a single refused `send` no longer calls `fail()`.
  A refusal is reported to the caller as a refusal; it is not a state
  transition.

Addresses Findings 1 and 3 — `eb006b9`'s outage needed both the closed-world
enum *and* this edge. Cutting the edge downgrades that entire class of bug from
"the application died" to "one pane reattached."

### B3. Remove the absorbing states

- `binding.reason` is cleared on any subsequent successful transition, and is
  never consulted ahead of live attachment state (Finding 6).
- An `'unsent'` create intent gets a deadline and a rejection, so
  `Ctrl+Shift+T` either creates a terminal or says why it did not (Finding 7).
- `attaching` slots are released on a deadline, not only on a terminal status,
  so a stalled pane cannot starve the application (Finding 8).
- The health chip offers reconnect whenever the socket is not ready, ahead of
  the failed-session jump, and stops treating a non-zero exit code as a system
  fault (Finding 9).

### B4. Every refusal is attributable

Refusal reasons carry their unit and correlation id into the A1 ledger, so the
overlay and the test suite can both name the cause.

---

## Track C — A forward-compatible protocol

The governing distinction, from Finding 3: **an unrecognized variant is not a
malformed one.** The first is a client that is older than its daemon. Only the
second is corruption.

That rule is applied at all three validation depths, because the one that
actually caused an outage was the innermost:

| Depth | Site | Today | Rule |
|---|---|---|---|
| Frame | `recoveryConnection.ts:131` | permanent `incompatible` | drop, count, socket intact |
| Event name | `recoveryConnection.ts:175` | permanent `incompatible` | ignore, count |
| Record payload | `streamProtocol.ts:119` | `invalid()` → session death | skip the record, count |
| Event variant | `streamProtocol.ts:109` | `invalid()` → session death | skip the record, count |
| Fault reason | `streamProtocol.ts:67` | `invalid()` → session death | treat as an unknown fault reason |

**Only an explicit protocol version mismatch remains fatal** — and it is
surfaced with a retry, never silent and never permanent (F2).

Strictness is preserved everywhere it carries meaning. An `Output` whose `data`
is not a string is still invalid, and still refused; the record is dropped and
the pane says so. What the client stops asserting is that it knows the complete
set of variants the daemon may emit — a claim it was never in a position to make,
since the daemon ships independently of it.

A skipped record is a visible event, not a silent one: it increments a counter in
the A1 ledger and names the unrecognized variant, so a daemon that has outgrown
its client is diagnosable in one glance at the overlay rather than by bisecting
a Rust enum.

The 30-second liveness restart (`recoveryConnection.ts:70`) is retained: an
unresponsive daemon is a real fault, and restarting the socket is the correctly
scoped response to it.

Addresses Findings 3 and 4.

---

## Track D — Removing recovery

Tier 1 (reconstruction) and Tier 2 (discovery and adoption) are deleted. Tier 3,
the durable tmux substrate, is **kept**.

### What that leaves

A reconnect becomes: reattach to the tmux pane, let tmux repaint. Processes
still survive a daemon restart, because that is tmux's job and tmux was already
doing it. What goes is the ceremony of proving that a reconstructed screen is
byte-exact.

Attach collapses to a single outcome — `attached`, or a refusal. No
`AttachKind`, no resume cursor, no cut sequence, no catch-up/live phase
distinction, no `StreamApplied` barrier. Most of the 20 assertions in Finding 1
have nothing left to assert.

### Deleted

**Frontend** — `sessionRecovery.ts`, `recoveredArchive.ts`,
`recoveryPlacement.ts`, `archivePresentation.ts`, `RecoveredHistory.tsx`,
`SessionSnapshotNotice.tsx`, `test/recoveryFixture.ts`, and their tests
(`recoveredArchive.test.ts`, `archivePresentation.test.ts`,
`RecoveredHistory.test.tsx`, `SessionSnapshotNotice.test.tsx`,
`ptyClient.recovery.test.ts`). Within surviving files: the `AttachKind`
machinery, resume cursors, cut sequences, phase assertions, `StreamApplied`,
history budgets, `recoverLegacy`, `listSessions`, and the snapshot/waiting
bindings in `useWorkspaceSet.ts`.

**Backend** — `recovery/legacy.rs`, `recovery/history.rs`, `tombstones.rs`, the
resume and rebuild paths in `recovery.rs` and `recovery/attach.rs`, and the
portions of `recovery_tests.rs` (1,646 lines) that cover them.

**Crate** — stream-journal *replay*: sequence cursors and the ring buffer as a
replay source. A live broadcast is retained.

**Browser suite** — the "warm socket recovery" and "cold daemon restart
preserves history" scenarios (`test-frontend-ui.mjs:357`, `:573`, `:584`).

Order of operations: delete the frontend consumers first, then the protocol
events they used, then the backend producers. A deletion that starts at the
daemon leaves the client asserting on events that stopped arriving — which,
before Track C lands, is itself a permanent disconnect.

### What is NOT removed — the naming trap

**`RecoveryConnection` and `backend/src/recovery.rs` are not the recovery
feature. They are the only transport between the UI and the daemon.** Deleting
them deletes the terminal.

`src/core/rowWindow.ts` is viewport virtualization. It matches a search for
"recover" solely because of the word "recovers" in a comment about scrolling.

`src/core/presentationCache.ts` is shared: `workspacePresentation.ts` and
`usePtyEvents.ts` use `boundCachedLines` for the live persisted snapshot. Only
its `ARCHIVE_*` limits and archive callers go.

To ensure this trap cannot recur, the rename is part of the cut and is not
optional:

- `src/core/recoveryConnection.ts` → `src/core/daemonConnection.ts`,
  `RecoveryConnection` → `DaemonConnection`
- `backend/src/recovery.rs` → `backend/src/gateway.rs`,
  `RecoveryServer` → `Gateway`

After this change, a future agent instructed to "remove recovery" finds nothing
named recovery that is load-bearing.

---

## Test architecture

```
vitest      unit/        state machines in isolation
vitest      component/   error boundary, refusal rendering
playwright  e2e/         real Chromium + real daemon + real tmux
              fixtures/  daemon (port 0, isolated TMUX_TMPDIR), page, faults
              happy/     one scenario per spec: create, input, split, close
              faults/    one spec per injected fault
```

A real `playwright.config.ts` with per-spec fixtures replaces the single
sequential script, so any scenario runs alone and scenarios run in parallel.
Daemon isolation (`DOOM_PORT=0`, private `TMUX_TMPDIR`, `-L doom-term`) is
already correct in the existing harness and is preserved verbatim — no test ever
touches the user's daemon or tmux server.

**Every fault spec asserts containment, not survival.** The canonical assertion
is *pane B still echoes a keystroke after pane A has faulted*. Nothing weaker
would have caught Finding 1.

Division of tools, reconciling the two:

- **Chrome DevTools MCP** — the live diagnosis loop, driven against
  `npm run dev`. Reads `window.__doom`, the console, and network traffic while a
  human watches. This is where a novel failure is understood.
- **Playwright** — the committed regression gate. Every fault understood through
  MCP becomes a spec here. MCP cannot run unattended, so it cannot be the gate.

Per the existing memory on driving this app: scope every DOM query to the
visible pane, and close duplicate browser tabs before live testing — two tabs
share `localStorage` and manufacture phantom session bugs.

---

## Sequencing

Observability, then containment, then deletion. The order is the argument.

| Phase | Content | Exit condition |
|---|---|---|
| **0** | Track A. Ledger, harness split, fault seam. No behavior change. | Fault specs land **red**, documenting Findings 1–9 as executable evidence. |
| **1** | Track B. Error boundary, cut escalation edges, kill absorbing states. | Phase 0's red specs go green. |
| **2** | Track C. Skip unrecognized variants, drop malformed, version-only fatal. | A daemon variant the client has never heard of provably cannot end a session, at any of the five validator depths. |
| **3** | Track D. Delete recovery, rename the transport. | `agent:verify` green with the subsystem gone. |
| **4** | Gate. `test:e2e` into `agent:verify`. | One command covers the fault paths. |

Phases 1 and 2 fix the reported symptoms. Phase 3 removes the bloat. Phase 0 is
what makes any of it verifiable — deleting first means debugging blind, and a
green suite that never executed a fault path is exactly the state the project is
in today.

Phase 0 landing red is deliberate. A failing test that names a real defect is
the project's most valuable artifact right now; it is the difference between
believing the architecture is wrong and being able to prove it.

---

## Non-goals

- **Session recovery is not replaced with a lighter version.** It is removed.
  Processes survive because tmux keeps them; screens are repainted because tmux
  repaints them. Nothing reconstructs a screen from a journal.
- **The four axioms are unchanged.** Zero radius, hard bevels, five state
  colors, integer cell metrics, no icon libraries, no invented telemetry. The
  diagnostics overlay renders unknown values as `--` like every other surface.
- **Fail-closed is not relaxed for input.** No queuing, no replay, no retried
  paste, no assumed delivery. Unknown delivery is still reported as unknown.
  Track C relaxes exactly one thing: the client's claim to know every variant
  the daemon might emit. Every assertion about the variants it *does* consume
  survives intact.
- **Windows and remote/SSH behavior are out of scope**, and are the subject of
  [`2026-09-17-remote-and-render-design.md`](2026-09-17-remote-and-render-design.md).
  The containment work must not regress it; it does not extend it.
