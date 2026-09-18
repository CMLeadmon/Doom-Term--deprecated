# Recovery Removal & Protocol Hardening Implementation Plan (Phases 2 & 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish forward-compatible protocol validation (Phase 2 / Track C) so that unknown daemon events or record payloads never crash sessions, and delete fragile screen reconstruction bookkeeping (Tiers 1 & 2) while retaining the durable tmux substrate (Phase 3 / Track D). Permanently rename `RecoveryConnection` to `DaemonConnection` to prevent architectural confusion.

**Tech Stack:** TypeScript, React 19, Vite 6, Vitest 3, Playwright 1.63, Rust (`doom-term-pty` crate, Tokio daemon), tmux.

**Spec:** [`../specs/2026-09-17-failure-containment-design.md`](../specs/2026-09-17-failure-containment-design.md)
**Preceding Plans:**
- [`2026-09-17-diagnostics-substrate.md`](2026-09-17-diagnostics-substrate.md) (Phase 0)
- [`2026-09-17-failure-containment.md`](2026-09-17-failure-containment.md) (Phase 1)

---

## Overview & Architecture

### Phase 2: Track C — Forward-Compatible Protocol
The core rule is: **an unrecognized variant is not a malformed one.** The first indicates a client older than its daemon; only the second represents protocol corruption.
Validation depths:
1. **Frame Level (`recoveryConnection.ts:131`):** Drop malformed frame, record in ledger counters, keep socket intact (only true protocol version mismatch is fatal).
2. **Event Name Level (`recoveryConnection.ts:175`):** Ignore unknown event, increment `unknownEvents` counter.
3. **Record Payload Level (`streamProtocol.ts:119`):** Skip unknown payload, count in ledger, do not destroy session.
4. **Event Variant Level (`streamProtocol.ts:109`):** Prevent recurrences of `eb006b9` by skipping unhandled `DemuxEvent` variants instead of falling into `invalid()`.
5. **Fault Reason Level (`streamProtocol.ts:67`):** Coerce unknown fault reason to `'unknown'`.

### Phase 3: Track D — Recovery Removal
Delete Tiers 1 and 2 (reconstruction, discovery, history journals, legacy recovery). Retain Tier 3 (tmux processes survive; reconnect rebinds to the tmux pane and requests repaint).
- **Deleted Frontend:** `sessionRecovery.ts`, `recoveredArchive.ts`, `recoveryPlacement.ts`, `archivePresentation.ts`, `RecoveredHistory.tsx`, `SessionSnapshotNotice.tsx`, `test/recoveryFixture.ts`, and associated unit tests.
- **Deleted Backend:** `recovery/legacy.rs`, `recovery/history.rs`, `tombstones.rs`, and journal replay mechanisms.
- **Renamed Transport:**
  - `src/core/recoveryConnection.ts` → `src/core/daemonConnection.ts`
  - `RecoveryConnection` → `DaemonConnection`
  - `backend/src/recovery.rs` → `backend/src/gateway.rs`
  - `RecoveryServer` → `Gateway`

---

## Phase 2 Implementation Tasks (Track C)

### Task 1: Forward-Compatible Stream Protocol Validation
- [x] **Step 1:** Write unit test for `streamProtocol.ts` verifying that unknown `DemuxEvent` variants and record payloads are gracefully skipped rather than throwing `invalid()`.
- [x] **Step 2:** Modify `streamProtocol.ts` to return `{ kind: 'unknown', variant: string }` instead of calling `invalid()`.
- [x] **Step 3:** Update `SessionAttachment` to record unknown variants in `diagnostics` and continue stream processing.
- [x] **Step 4:** Verify tests pass and commit.

### Task 2: Non-Fatal Transport Frame Handling
- [x] **Step 1:** Write unit tests for `recoveryConnection.ts` asserting that an unparseable JSON frame or unrecognized event does not set status to `incompatible` or disable retry.
- [x] **Step 2:** Modify `recoveryConnection.ts` message dispatcher: record dropped frames and unknown events in `diagnostics`, keeping connection live.
- [x] **Step 3:** Verify tests pass and commit.

---

## Phase 3 Implementation Tasks (Track D)

### Task 3: Transport Renaming (Prevent Naming Trap)
- [x] **Step 1:** Rename `src/core/recoveryConnection.ts` to `src/core/daemonConnection.ts` and rename exported class to `DaemonConnection`.
- [x] **Step 2:** Update all frontend call sites (`ptyClient.ts`, etc.).
- [x] **Step 3:** Rename `backend/src/recovery.rs` to `backend/src/gateway.rs` and struct `RecoveryServer` to `Gateway`.
- [x] **Step 4:** Run `cargo check` and `npm run typecheck` to verify rename integrity. Commit.

### Task 4: Removal of Legacy Recovery Subsystems
- [x] **Step 1:** Remove frontend recovery consumers: `RecoveredHistory.tsx`, `SessionSnapshotNotice.tsx`, `recoveredArchive.ts`, and obsolete tests.
- [x] **Step 2:** Simplify `SessionAttachment`: remove `AttachKind`, resume cursors, cut sequence checks, and 20 reconstruction `throw` sites.
- [x] **Step 3:** Remove backend journal replay, `recovery/legacy.rs`, `tombstones.rs`, and outdated history tests.
- [x] **Step 4:** Verify `cargo test` and `npm test` remain green. Commit.

### Task 5: Gate Integration & Final Verification
- [x] **Step 1:** Integrate `test:e2e` into unified `agent:verify`.
- [x] **Step 2:** Run `npm run agent:verify` and confirm all suites pass cleanly.
