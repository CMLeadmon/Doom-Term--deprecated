# Sequenced Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task, inline. The user explicitly prohibits subagents and has authorized work on main. Checkboxes record verified implementation, not intentions.

**Goal:** Implement safe attachment to surviving processes, exact warm stream continuation, and explicitly discontinuous bounded cold recovery without replaying input.

**Architecture:** A shared PTY journal owns ordered records and bounded retention. Authenticated connection-scoped ownership gates mutations; cursor delivery replaces callback rebinding. The frontend advances its cursor only after parsing and keeps recovered archives outside the live parser.

**Tech Stack:** Rust, parking_lot, serde, Tokio WebSocket transport, TypeScript, React, @xterm/headless, real tmux and Playwright fixtures.

**Spec:** `docs/superpowers/specs/2026-09-09-sequenced-recovery-design.md` (approved by “Implement the written contract”).

**Verified state:** [`2026-09-15-recovery-handoff.md`](2026-09-15-recovery-handoff.md)
records the last independently re-run gate plus corrections to notes below that
did not survive re-running. Trust that file over any summary in this one.

## Global constraints

- Inline on main; no subagents or worktrees. Preserve unrelated changes and use only disposable fixture daemons/private tmux sockets.
- Protocol version 2 after authentication; no legacy mutation/discovery fallback.
- Four separate identities: session_id, 128-bit incarnation, 128-bit stream_epoch, 128-bit attachment_id. Sequence numbers are validated decimal-string u64 counters.
- Journal: 8 MiB / 8,192 records per session; 64 MiB daemon-wide; 64 KiB per record/control accumulator. Evict entire oldest records; no skipped cursor gaps.
- Serialized outbound: 4 MiB per connection / 32 MiB globally. Slow consumers lose their connection, not their process.
- Heartbeat every 10 seconds; liveness deadline 30 seconds. Parser drain deadline five seconds. Four concurrent attachments maximum.
- Closed tombstones: five minutes / 256 entries, charged to journal budget. History: 5,000 lines / 8 MiB; helper deadline two seconds; bootstrap deadline ten seconds.
- No offline mutation queue, automatic retry, command rerun, cached-mode paste admission, implicit replacement, or archive-as-checkpoint.
- Preserve the paste contract, terminal pass-through, unknown telemetry, four materials, and existing persistent-chrome restriction.

## Task 1 — Restore a truthful verification baseline

**Files:** `crates/doom-term-pty/src/tmux.rs`, `tools/build-tmux-sidecar.mjs`, `.github/workflows/ci.yml`, `README.md`, `docs/BETA_READINESS.md`.

**Interfaces:** `version_supported(&str) -> bool` determines whether create can use durable tmux; no change to child-side paste admission.

- [x] Reproduce the remote paste refusal and trace the missing format to upstream tmux 3.7 (3.6a has no `bracket_paste_flag`).
- [x] RED: older versions must not be advertised as supporting the required adapter:

  ```rust
  for old in ["tmux 3.3", "tmux 3.4", "tmux 3.5a", "tmux 3.6b"] {
      assert!(!version_supported(old));
  }
  assert!(version_supported("tmux 3.7c"));
  ```

- [x] Set the adapter/sidecar floor to 3.7; install checksum-pinned 3.7c in CI. Document the compatibility change. Attach-only enforcement follows in Task 3.
- [x] Run `cargo test --locked -p doom-term-pty`, sidecar rejection tests, and inspect the next CI result. Baseline commits: `90f5f85`, `4144db9`; CI 34482935923 passes all stages. Sidecar regression also fails under an intentional restoration of the old floor.

## Task 2 — Bounded ordered journal and parser faults

**Files:** create `crates/doom-term-pty/src/stream.rs`, `crates/doom-term-pty/src/stream/tests.rs`; modify `src/lib.rs`, `src/demuxer.rs`, `src/session.rs` in that crate.

**Interfaces:** `Identity` validates/generates opaque 128-bit hex values; `Sequence` serializes validated u64 decimal strings. `JournalHub::open(StreamMetadata) -> StreamJournal`; `append(StreamPayload) -> Result<Sequence, StreamError>`; `snapshot() -> StreamSnapshot`; `read_after(Sequence) -> Result<Option<StreamRecord>, StreamError>`; `wait_for_change(Sequence, Duration)`. `StreamPayload` carries Event, Resize, Closed, and Fault; records carry source monotonic microseconds. The hub enforces global oldest-first retention; dropping the final journal handle releases retained data.

- [x] Add journal regression coverage for boundaries, independent epochs, future/gapped cursors, whole-record eviction, global oldest eviction, closed/fault streams, sequence overflow, malformed decimal values, and wakeups. Initial integration failed for the missing stream API; production-size count/byte/global boundaries are covered:

  ```rust
  let journal = hub.open(metadata()).unwrap();
  for _ in 0..600 { journal.append(output("x")).unwrap(); }
  assert_eq!(journal.snapshot().high_water, Sequence::new(600));
  assert_eq!(journal.read_after(Sequence::new(0)).unwrap().unwrap().sequence, Sequence::new(1));
  ```

- [x] Implement the journal, accounting, source timestamps and cursor API; assert limits with small injected limits and production-size fixtures. No socket I/O or callback runs under its lock.
- [x] RED: split unterminated CSI/OSC beyond 64 KiB produced zero faults. Implemented sticky demux fault; the regression now requires one fault and no fabricated tail. Real child remains alive, input/resize is refused, and fault survives legacy replay.
- [x] Replace the session's 500-event ring with its journal; sequence reader events, alternate-screen polls, successful resizes and closure through one observation lock. Legacy callback compatibility remains until Task 4 cuts transport over; this is not protocol v2.
- [x] Run focused journal/demux and real PTY tests; review lock order and drop accounting. Full local checks and browser regression smoke pass; see the readiness ledger for evidence and remaining limits.

## Task 3 — Exact durable identity and attach-only adapter lifecycle

**Files:** `crates/doom-term-pty/src/tmux.rs`, `src/tmux/durable.rs`, `src/session.rs`, `src/process_io.rs`; create `tests/attachment.rs` in that crate.

**Interfaces:** `PtySession::create(...)` creates only. `PtySession::attach_durable(id, incarnation, cols, rows)` carries no shell/cwd; resolves exact numeric pane and validates Doom-owned pane metadata. `TmuxHandle::capture_archive()` returns typed bounded capture metadata/data, not live events. `retire_adapter()` stops/reaps only owned display client/readers. Incarnation survives adapter recreation; stream epoch does not.

- [x] RED: create twice conflicts; attach missing never creates; prefix neighbors never match; pane recreation invalidates old identity:

  ```rust
  let original_pid = first.shell_pid().unwrap();
  assert!(create_same_id().is_err());
  let attached = attach_exact(first.incarnation()).unwrap();
  assert_eq!(attached.shell_pid(), Some(original_pid));
  assert!(attach_missing().is_err());
  ```

- [x] Remove `new-session -A`; create detached pane with random pane-scoped identity and open normal attach-only client, validating in tmux's command queue. Explicit legacy recovery assigns metadata to the resolved current pane only.
  - New create/attach APIs now stamp persistent incarnation plus root pid, resolve a numeric pane, and validate identity in the command queue. Explicit legacy adoption checks the observed pane/pid and refuses overwriting an identity.
  - Closed 2026-09-15. `new-session -A` is gone from the create path; `tmux.rs` builds `new-session -d -c … -s … -x … -y …`. Legacy `Spawn`/rebind is no longer merely disabled: `ClientMessage`, `handle_client_msg` and the legacy `mod tests` were sitting behind `#[cfg(any())]` in `backend/src/main.rs` and are now deleted outright (749 lines; the file went 1266 → 514). The public listener already went straight to `RecoveryServer::accept`, so no wire behaviour changed.
  - Deleting that module would have silently dropped live-code coverage, so three tests were first restored into the compiled `security_tests.rs`: the two `listen_addr` bind-default tests, plus new `loopback_host` coverage that never existed. Each was proven to fail against a deliberately broken default (`0.0.0.0:1421`) before being kept. The legacy module's other tests encode pre-v2 semantics that were intentionally replaced — directory-fallback hook attribution, for instance, is now forbidden by `an_unattributed_hook_cannot_describe_a_pane` — so they were not carried over. Backend suite 103 → 106 passing.
- [x] Generalize bounded helper I/O with declared byte cap/deadline; capture up to 5,000 lines / 8 MiB with dimensions/truncation. Keep captures out of the live stream and parser.
  - The real missing-prefix regression initially queried/captured/killed its neighbor; it now leaves that neighbor untouched. Identified adapters use numeric identity-fenced targets and typed separate archives. Frontend archive transfer/presentation is still Task 6.
- [x] Verify real shell and alternate-screen repaint, saved editor file, history provenance, cancellation and no accumulated tmux clients across repeated adapter replacement. Seven real isolated adapter tests pass, including server restart with numeric-id reuse and a stalled bootstrap that reaps only its client. Browser recovery comparison remains Task 7, not certified by these Rust fixtures.

## Task 4 — Negotiated transport, ownership and bounded delivery

**Files:** create `backend/src/protocol.rs`, `backend/src/attachments.rs`, `backend/src/outbound.rs`, `backend/src/recovery_tests.rs`; modify `backend/src/main.rs`, `security_tests.rs`, `paste_tests.rs`, `telemetry_tests.rs`.

**Interfaces:** `Create { request_id, id, cols, rows, cwd, shell }`; `Attach { request_id, id, incarnation, resume }`; `StreamApplied { id, incarnation, attachment_id, sequence }`. `Ownership::authorize(socket_id, incarnation, attachment_id, requires_ready)` is rechecked at mutation execution. All mutation envelopes carry incarnation/attachment_id. `StreamBegin`, `StreamRecord`, `StreamCaughtUp`, `AttachmentReady` implement the exact cut exchange. Typed outcomes follow the spec verbatim.

- [x] RED using real authenticated WebSockets: legacy Spawn/Write and pre-negotiation discovery do not execute; second socket gets busy; disconnect releases only its own lease; stale token and future acknowledgements cannot enable input:

  ```rust
  send(&mut second, attach_request(&created)).await;
  assert_eq!(receive_outcome(&mut second).await, "busy");
  send(&mut first, applied_future_cut()).await;
  assert!(!fixture.received_child_input());
  ```

  - Initially staged behind `RecoveryServer::accept`; as of 2026-09-15 the public listener and frontend both use v2. Recovery socket fixtures now exercise the public HTTP/WebSocket router. This wire integration is not the completed browser recovery contract.

- [x] Reserve create ids before spawn and release only matching reservations. Retain closed incarnation tombstones; stale close callbacks cannot remove a replacement.
  - Closed 2026-09-15. The reservation existed but had no coverage: the only duplicate-create test sent its second request *after* the first had replied, so it was rejected by the finished sessions map and never reached `catalog.creating`. Added `recovery_concurrent_creates_reserve_one_id_and_a_failed_create_releases_it` — four sockets race one id with every request in flight before any reply is read. Proven load-bearing: with the `creating` check removed, all four creates win and four real shells are spawned over one id. The same test covers reservation release, since a failed create that leaked its reservation would poison the id permanently. Tombstone retention and stale-close-vs-replacement were already covered by `tombstones.rs` and `recovery_closed_outcome_is_retained_without_retaining_or_removing_a_replacement_pty`.
- [x] Authenticate, advertise/negotiate v2 and daemon epoch, then allow discovery/attach. Pump one cursor incrementally through captured cut; offered-cut acknowledgement alone grants readiness. Remove rebind/replay and unbounded PTY delivery.
  - Closed 2026-09-15 on re-run evidence: `recovery_authentication_precedes_protocol_advertisement_and_discovery` for ordering, `recovery_create_attach_and_exact_cut_fence_real_child_input_between_two_controllers` for the cut exchange. Legacy rebind/replay is now deleted rather than disabled (see Task 3).
- [x] Account serialized bytes through socket-send completion; overflow disconnects with reason; no socket I/O under journal/ownership locks. Add heartbeat/liveness expiry and cleanup.
  - Closed 2026-09-15 on re-run evidence: `outbound.rs` covers charge-through-send, per-connection overflow and the global cap with release on drop; `recovery::pump_tests::a_slow_consumer_overflows_at_the_production_cap_without_stopping_the_child` covers a live slow consumer; `recovery_transport_pings_and_expires_a_peer_that_stops_responding` covers heartbeat and the 30-second expiry.
- [x] Fence Write/Signal/Resize/Paste/Kill at execution; preserve correlated paste uncertainty and permit explicit lifecycle action without screen readiness.
  - Closed 2026-09-15 on re-run evidence: `recovery_paste_resize_signal_and_read_only_kill_keep_their_ownership_fences`, `recovery_lost_lease_during_paste_preparation_never_delivers_its_private_buffer` for correlated uncertainty, and `recovery_can_kill_an_owned_root_after_it_closes_its_terminal_descriptors` for lifecycle action without screen readiness.
- [x] Run real two-controller, attach-race, concurrent-create, stale-close, overflow, auth, paste, and tombstone tests. Commit with matching frontend Task 6 (never publish incompatible shells separately).
  - Every named category now exists and passes, concurrent-create included. Also added `recovery_an_evicted_resume_cursor_is_an_explicit_gap_not_a_silent_skip` for spec gate 4's "explicit gaps": the journal reported `StreamError::Gap` but nothing asserted the daemon's response, and with that check removed the daemon answers `resume` for a cursor whose records are gone — handing the frontend a transcript with a hole and no way to know.
  - Closed 2026-09-15 together with Task 6. Both shells are v2-only and ship in the same commit stream: the daemon advertises `{"version":2,"daemon_epoch":…}` and accepts only `Negotiate { version: 2 }` (`recovery.rs:617`/`656`), and the frontend refuses any payload whose `version !== 2` and validates the epoch as 32 hex characters (`recoveryConnection.ts:140`). There is no path on which one shell is published against an incompatible other.

**In-progress evidence (2026-09-12):** bounded serialized delivery retains charges through socket sends; exact-cut publication is atomic with queue admission. Real transport heartbeat/30-second expiry and oversized-frame refusal pass. Reading is separate from ordered command execution, so a blocked child write cannot retain a dead socket's lease or replay a queued Kill. Five-minute/256-entry tombstones retain observed exits, including an exit after a rendering fault; losing a tmux display client is not a pane exit. Cold attach discovers exact durable identity, uses observed geometry, retires the old client, opens a new epoch and transfers a separately identified/chunked archive. Ordinary tmux bytes and resizes now use identity-checked command queues; direct kill uses the owned unreaped Child. Paste rechecks socket ownership after private-buffer preparation and removes a stale buffer without delivering it. Full checks: 103 PTY tests, 107 backend tests (3 live-account tests ignored), 503 Vitest / 102 Node tests, typecheck, production build, exact HUD and native all-target compilation pass.

**Still required before cutover:** remaining v2 metadata/hook/worktree/explicit-legacy-recovery integration; concurrent/lost-create and live overflow/gap stress coverage; frontend ownership/incarnation persistence and all-workspace attachment; removal of legacy Spawn/rebind and held/replayed input; real browser contract gates. Normal durable pane exit observation also needs explicit coverage distinct from losing its display client. These are open requirements, not waived by the passing staged tests.

**Public integration update (2026-09-15):** metadata/worktree commands now require
negotiation, run through bounded-admission workers and use correlated outcomes.
Bounded directory results expose incompleteness; telemetry is incarnation-fenced.
Hook retention has stable event ids and an atomic snapshot/live handoff; the
frontend restores hook state without replaying ask counters or notifications.
The public legacy WebSocket dispatcher is removed. Remaining legacy daemon
command handlers are test-only; PTY Spawn/rebind removal, explicit legacy recovery,
stress cases and real-browser contract gates are still required. Fresh verification:
104 PTY / 112 backend tests, 578 Vitest / 102 Node tests, typecheck and native
all-target compilation pass. Three live-account tests remain intentionally ignored.

**Correction (2026-09-15, Claude):** the counts in the paragraph above did not
hold when re-run. `cargo test` exited `101` on
`recovery_tests::recovery_retains_a_natural_durable_pane_exit_as_unknown_status`,
a ~40% flaky test (5 failures in 12 runs), so `check:tauri` never ran either.
The test is fixed and now 15/15 deterministic; the full gate is green with
`check:tauri` passing inside the `doom-tauri` toolbox. Legacy `ClientMessage`,
`handle_client_msg` and the legacy `mod tests` are not removed but disabled
behind `#[cfg(any())]` in `backend/src/main.rs`, so they never compile and their
tests never run. See the handoff log for evidence.

## Task 5 — Applied frontend cursors and explicit screen lifetime

**Files:** `src/core/terminalScreen.ts`, `xtermScreen.ts`, `emulatorRegistry.ts`; create `src/core/streamProtocol.ts`, `streamApplication.ts` and their tests.

**Interfaces:** `TerminalScreen.writeAndWait(data): Promise<void>` and `drain(): Promise<void>` resolve at parse completion, reject on disposal/deadline. `StreamApplication.apply(record)` orders parse, resize, semantic callbacks and cursor advancement; compares validated bigint sequences. `StreamApplication.resumeCursor()` drains before returning matching epoch/cursor.

- [x] RED with real xterm: cursor cannot advance at receipt; SGR/Unicode/split escape and queued parser work survive warm reconnect; duplicates have no output/effects; forward jumps stop application:

  ```ts
  const applying = stream.apply(record('1', '\x1b[31m三'));
  expect(stream.appliedSequence).toBe('0');
  await applying;
  expect(stream.appliedSequence).toBe('1');
  await expect(stream.apply(record('3', 'never'))).rejects.toThrow();
  ```

- [x] Add parser completion/drain/disposal handling independent from animation-frame painting. Five new real-xterm tests pass; reset contamination was reproduced and fixed by replacing the parser. Warm-reconnect selection and recorded initial-size replay still require the stream application/transport work below.
  - Foundation CI exposed late SessionMode erasing startup output. Real-parser regressions reproduce it. Legacy reset is now before the Spawn request, never on metadata receipt; this bridge is not exact v2 recovery.
- [x] Serialize resize confirmations and semantic events; suppress duplicate/catch-up activity effects; carry source clock identity/time and invalidate derived metrics across gaps.
  - `StreamApplication` keeps exact bigint cursors, applies state before acknowledgement, and freezes on gaps, faults, identity changes, parser failure or disposal. Warm continuation preserves the same parser; explicit registry replacement creates a cold screen at recorded dimensions. A 600-record continuation matches uninterrupted rendered spans, wrapping and cursor while preserving earlier history and marks.
  - The reconnect drain deadline covers the whole queued barrier, not each write separately. Pending application is capped at 4 MiB / 8,192 entries. Regression tests caught late semantic acknowledgement against a disposed screen, activity after projection-triggered disposal, and record accounting that omitted its identity envelope; all fail closed now.
- [x] Run focused Vitest with real parser including timeout/disposal and reset isolation. Forty focused tests and all 502 Vitest / 102 Node tests pass, as do typecheck, production build and exact HUD comparison. This layer does not change the live wire protocol; selection of resume versus cold reconstruction and input readiness remain Tasks 4+6.

## Task 6 — Frontend handshake, no mutation replay, all-workspace recovery

**Files:** `src/core/ptyClient.ts`, `commandDelivery.ts`, `holdBuffer.ts`, `sessionRecovery.ts`, `sessionStore.ts`; `src/hooks/usePtyEvents.ts`, `useWorkspaceSet.ts`; `src/components/RawTerminalView.tsx`, `StatusPlate.tsx`; `src/types/terminal.ts`; associated tests.

**Interfaces:** PtyClient attachment state owns negotiated daemon epoch, incarnation, token, applied cursor and readiness. Create is explicit/correlated then attaches. Restore discovers and attaches known exact incarnations with concurrency four; it never sends Spawn or a stored command. `inputReadiness(id)` returns a transient accessible refusal reason.

- [x] RED: offline/catch-up typing and echo-held keys are never delivered later; stale async clipboard reads fail; missing/replaced nodes stay snapshots; parked/background nodes attach before focus:

  ```ts
  client.write('offline text', id);
  await reconnectAndAttach(client);
  expect(childInput).not.toContain('offline text');
  expect(createRequestsAfterReconnect).toHaveLength(0);
  ```

- [x] Replace legacy message switch with protocol/application modules; remove pendingWrites; cancel deliveries/discard holds on disconnect, epoch or ownership change. Do not replay uncertain creates/pastes/initial commands.
  - Verified 2026-09-15: no `restoreBindings` and no `Spawn` action remain in frontend production code, and the surviving `pendingWrites` identifier is xterm's parser counter, with `sessionStore.test.ts` asserting it is never persisted. Non-replay is held by `never queues typing or resends an accepted create after its reply is lost`, `does not retry legacy identification whose reply was lost` and `fences paste correlation to both ids and rejects uncertainty on disconnection without retry`; obsolete-socket cancellation by `ignores all callbacks from an obsolete socket, including close after the replacement is ready`.
- [x] Apply caught-up cut then await AttachmentReady; coalesce desired sizes without offline reflow. Preserve session names, slots, tree, parked state and cached snapshots.
  - Verified 2026-09-15 by `acknowledges the captured cut even when later live records are already queued`, `coalesces offline desired geometry without resizing the parser until an ordered record`, and `cold replays at recorded geometry and gates input on parse-applied acknowledgement plus daemon readiness`. Preservation is held by the `useWorkspaceSet` and `sessionRecovery` suites, including `preserves a conflicting cached pane as a separately addressable snapshot when recovering its replacement`.
- [x] Restore command/hook state without clocks/counters/notifications replay; unknown timing/marks remain unknown. Add recovery state to existing status/transient surfaces only.
  - Verified 2026-09-15 by the `streamProjection` suite: `restores observed counters and duration without fabricating wall-clock timestamps or replaying a notification`, `notifies a genuinely new live completion using stable source identity, not a reconstructed counter`, and `clears unprovable prior-stream measurements and marks closure without counting another command`. The surface rule holds too: `RecoveredHistory` renders conditionally inside `RawTerminalView`, so it is in-pane content rather than new persistent chrome.
- [x] Present bounded archive outside live emulator with provenance/discontinuity and transfer-completeness state. A failed live rebuild is read-only; history failure alone is explicit but may allow live use.
  - Verified 2026-09-15. `RecoveredHistory` states its own provenance rather than implying continuity — "DISCONTINUOUS · POTENTIALLY OVERLAPPING / INCOMPLETE" and "LIVE VIEW STARTS BELOW · NO PRECISE SEAM IS CLAIMED" — and uses only Four-Materials surfaces and canonical state colours. Completeness is held by `only exposes a complete archive after exact byte, line, ordinal and capture completion` and `ignores stale attachments and marks a disconnected partial transfer incomplete`; read-only-on-failed-rebuild by `keeps an unreconstructable process read-only but permits explicit lifecycle control`.
- [x] Run routing, input, workspace, cache/archive and clipboard suites; publish with Task 4 only after version compatibility checks pass.
  - Ran 2026-09-15: 13 files / 150 tests across routing, input, workspace, cache/archive and clipboard, all passing, plus the version-compatibility check recorded on Task 4's last box.
  - **These boxes record the frontend contract, not the recovery certification.** Every gate above is headless. Nothing here certifies the eleven spec gates, which need the real-browser work in Task 7.

## Task 7 — Contract verification and readiness ledger

**Files:** `tools/test-frontend-ui.mjs`, a dedicated `tools/test-recovery-ui.mjs` if needed, `package.json`, CI, `docs/BETA_READINESS.md`, spec status.

- [ ] Add real browser fixtures with disposable authenticated daemons and private tmux: socket disconnect, daemon restart, exact process identity, >500 events, split escapes/Unicode/SGR, pending parse, deferred resize, warm scroll position, cold shell/editor and saved files. Compare exact rendered cells/scrollback against uninterrupted control.
- [ ] Exercise production-size retention/global/outbound limits and slow consumers; assert process continues while attachment reports gap/overflow. Verify no replayed input or restarted command.
- [ ] Verify multiple workspaces/parked sessions, daemon-only recovery choices, second controller, missing/replaced process, lost paste/create result, archive failure, auth/version refusal and helper deadlines.
- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, `npm run hud:check`, `cargo check --locked`, `cargo test --locked`, native all-target check in the available container, and production-CSP browser smoke/recovery. Inspect screenshots and record exact artifacts/environment blocks.
- [ ] Review every spec gate against evidence. Mark implemented only when all eleven gates pass; otherwise retain an explicit incomplete checklist. Commit/push and inspect CI. Do not mark the broader beta-readiness goal complete solely because recovery passes.

### Eleven-gate review, 2026-09-15 (Claude)

**Recovery is NOT certified.** The spec requires an explicit incomplete checklist
whenever a gate does not pass; this is it. Every Task 7 box stays open.

| # | Gate | Status | Evidence |
| :-- | :--- | :--- | :--- |
| 1 | Disconnect, same root, no gaps/dupes, cells match control | **FLAKY** | Browser scenario passed 2 of 3 runs. A pass rate is not a pass. |
| 2 | SGR/cursor/Unicode/split escape, resize during disconnect | **FLAKY** | Same scenario. Screenshot confirms `STYLE_中文` surviving in red and `CURSOR_XBCD` placed correctly. |
| 3 | >500 events, earlier history/marks/cursor/scroll preserved | **FLAKY** | Same scenario; asserts the detached scroll anchor survives. |
| 4 | Force byte/count/global limits and a slow consumer; explicit gaps | **PARTIAL** | Rust passes: journal byte/count/global tests, `a_slow_consumer_overflows_at_the_production_cap_without_stopping_the_child`, and the new `recovery_an_evicted_resume_cursor_is_an_explicit_gap_not_a_silent_skip`. "No raw-tail reset" is structurally true now that legacy replay is deleted, but is not directly asserted. Never exercised in a browser. |
| 5 | Cold reconstruction matches control; cold daemon recovery keeps the exact pane and never reruns its command | **NOT VERIFIED** | The browser scenario exists but has never run: the suite aborts earlier (see below). |
| 6 | Pane/server recreation; old tokens, input, callbacks and cursors cannot affect the replacement; prefix neighbours never targeted | **PASS (Rust)** | `old_identity_refuses_respawned_pane_and_restarted_server_even_if_numeric_id_is_reused`, `missing_prefix_targets_never_query_capture_or_kill_a_neighbor`. |
| 7 | Offline/catch-up typing, interrupted echo, lost paste result | **PARTIAL** | Frontend suites pass. The browser leg is blocked. |
| 8 | Replay completion/permission state twice; idempotence and unknown values | **PASS (unit)** | The `streamProjection` suite. |
| 9 | Multiple workspaces/parked panes; second controller refused without stealing | **PARTIAL** | Unit and Rust pass; the browser leg is blocked. |
| 10 | Auth failure, incompatible daemon, helper timeout, exit during attach, missing history never fabricate ready/success | **FAIL** | See the blocking defect below: the UI presents a live-looking terminal that silently refuses all input. |
| 11 | Full toolchain plus production-CSP browser smoke | **FAIL** | `agent:verify` exits 0 and `check:tauri` passes in the `doom-tauri` toolbox, but `npm run test:ui` exits 1. |

**Blocking defect — a stream assertion is misclassified as permanent daemon
incompatibility.** `RecoveryConnection.receive` ends by calling
`options.onMessage(...)`, which runs the whole consumer chain — `ptyClient`
through to `SessionAttachment.accept` — *inside* `socket.onmessage`'s `try`.
`SessionAttachment` throws for ordinary stream-state assertions
(`Record outside its captured phase`, `Unacknowledged readiness`,
`Record identity changed`). That catch calls
`disconnect('incompatible', …, false)` — **retry `false`, permanent**. So a
recoverable attachment fault is recorded as "update both shells together" and
the client never reconnects.

Observed three times in the browser: after a second disconnect that coincides
with a viewport resize, output keeps rendering (`RESIZE_AFTER` arrives and the
screenshot looks healthy) while every keystroke is refused with
`Connection disconnected or not negotiated; input was not sent`. The refusal is
a toast that clears itself, so the terminal then looks live and simply is not.
That is the false ready state gate 10 exists to forbid, and it aborts the
browser suite before gates 5, 7, 9 and the cold-restart leg ever run.

The fix is a design decision, not a typo: malformed frames are genuinely
incompatible and must not retry, but a consumer exception is an attachment
fault that should drop and restart that attachment. Those two must stop sharing
one catch. Deliberately left for the owner to direct, because it changes a
safety contract.

**Also outstanding:** the warm-recovery cell comparison is itself flaky (it
failed one run in three), so gates 1-3 need that stabilised before they can be
claimed. `push` and CI inspection are not done.
