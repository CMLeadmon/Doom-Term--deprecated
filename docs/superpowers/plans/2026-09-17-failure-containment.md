# Failure Containment Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink Doom Term's failure domain from the entire application to the individual pane and transport layer, cut all three escalation edges, eliminate four absorbing states, introduce per-pane render isolation, and ensure every refusal is attributable — turning Phase 0's red fault specs green.

**Architecture:** Four strict failure domains with downward-only fault propagation (Invariant F1: Containment). A render fault is isolated to a pane's React subtree; an attachment fault isolates to `SessionAttachment` and retries without dropping the shared socket; transport disconnects retry under exponential backoff; and process crashes reattach to surviving tmux panes. Zero states are permanently absorbing (Invariant F2). Every refusal carries its unit, reason, and correlation ID (Invariant F3), queryable via `window.__doom`.

**Tech Stack:** TypeScript, React 19, Vite 6, Vitest 3 (jsdom), Playwright 1.63 (Chromium), Tokio backend, tmux.

**Spec:** [`../specs/2026-09-17-failure-containment-design.md`](../specs/2026-09-17-failure-containment-design.md)
**Preceding Plan:** [`2026-09-17-diagnostics-substrate.md`](2026-09-17-diagnostics-substrate.md) (Phase 0)

---

## Diagnostic Baseline & Screen Snip Evidence

Live diagnostic runs of the browser suite (`npm run test:ui`) and backend test harness (`cargo test`) confirmed the exact failure modes identified in the design specification:

1. **Attachment Starvation & Input Lockout (`failure.png` & `cold-recovery-editor.png`):**
   - **Observation:** In `test-frontend-ui.mjs:609`, subsequent commands failed to enter the terminal after rapid session creation and cold recovery.
   - **Visual Evidence (`cold-recovery-editor.png`):** Status plate WAITING queue displayed `WAITING 4` with the red `WAIT` badge. The terminal banner displayed:
     `"Terminal is not accepting input yet; that keystroke was not sent."`
   - **Visual Evidence (`failure.png`):** Status plate advanced to `WAITING 5`. When the test typed `rows=$(stty size); rows=...`, the terminal only accepted `rows=$(stty size);` before refusing further input, causing Playwright expect timeout on `REDRAW_HIDDEN`.
   - **Root Cause Confirmed:** `ptyClient.ts:303` strictly throttles attachment concurrency at `this.attaching.size < 4`. Because `catching-up` and `awaiting-ready` are not terminal states, four stalled or slow attachments permanently lock the queue, preventing any new terminal pane in the entire application from attaching (Finding 8).

2. **Poisoned Input Readiness & Permanent Refusal:**
   - **Root Cause Confirmed:** `ptyClient.ts:381` consults `binding.reason` before checking live attachment state. Once set by a transient creation or attachment failure, `binding.reason` is never cleared, creating an absorbing dead state (Finding 6).

3. **Escalation Edges in Transport:**
   - `ptyClient.ts:240` triggers `this.connection.restart(reason)` whenever a single attachment enters `fail()`. A protocol disagreement in one pane severs the WebSocket for all active sessions (Finding 1).
   - `ptyClient.ts:305` triggers `this.connection.restart(...)` if `attach()` rejects, escalating a pane-level failure to a whole-app restart.

4. **Absorbing Non-Zero Exit Code in System Alert (`App.tsx:37`, `App.tsx:200`):**
   - `isSessionFailed` treats any non-zero exit code (`grep` finding no matches, test failure, `false`) as an application error. Clicking the health chip is permanently hijacked to jump to that pane instead of offering a reconnect affordance to the daemon (Finding 9).

---

## Global Constraints

- **Preserve the Four Axioms:**
  1. Plain `Ctrl` keys remain unconditionally pass-through to child processes.
  2. The Status Plate is the only persistent chrome. Error views and refusal banners must be recessed within the pane or transient.
  3. Never invent telemetry. An unknown state or unmeasured refusal renders as `--`.
  4. Four materials only: Plate, Recess (`#14120f`), 1px Bevels (`--bevel-up`, `--bevel-dn`), and Ink. Zero border radius (`border-radius: 0`) and zero blurred drop shadows.
- **Fail-Closed Preserved:** Input is never queued, replayed, or assumed delivered. If delivery cannot be guaranteed, it is refused with an attributable reason.
- **Downward Fault Propagation Only:** Pane faults never restart the socket. Render errors never unmount sibling panes.

---

## Implementation Tasks

### Task 1: Per-Pane React Error Boundary (B1)

Isolate render faults to the individual pane leaf. If a malformed row or rendering error throws during React reconciliation, render the error in that pane's recessed area with an attributable error message and a retry button, leaving all sibling panes and the status plate intact.

**Files:**
- Create: `src/components/PaneErrorBoundary.tsx`
- Create: `src/components/PaneErrorBoundary.test.tsx`
- Modify: `src/components/RawTerminalView.tsx` or `src/App.tsx` (wrap each pane)

**Interfaces:**
- Consumes: `React.Component`, children, `sessionId: string`, `onReset?: () => void`
- Produces: `PaneErrorBoundary` component rendering fallback UI on caught exceptions.
- Fallback UI: Material recess background (`#14120f`), `--bevel-dn`, zero radius, `--st-fail` red indicator, error message, and a `RETRY RENDER` button.

- [x] **Step 1: Write failing component test**

```tsx
// src/components/PaneErrorBoundary.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React, { useState } from 'react';
import { PaneErrorBoundary } from './PaneErrorBoundary';

const FaultyChild: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) throw new Error('Simulated render explosion');
  return <div data-testid="pane-content">Terminal Active</div>;
};

describe('PaneErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <PaneErrorBoundary sessionId="test-pane">
        <FaultyChild shouldThrow={false} />
      </PaneErrorBoundary>
    );
    expect(screen.getByTestId('pane-content')).toBeDefined();
  });

  it('catches render error and displays pane-isolated failure banner', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <PaneErrorBoundary sessionId="test-pane">
        <FaultyChild shouldThrow={true} />
      </PaneErrorBoundary>
    );
    expect(screen.queryByTestId('pane-content')).toBeNull();
    expect(screen.getByText(/Simulated render explosion/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /RETRY/i })).toBeDefined();
    spy.mockRestore();
  });

  it('resets state when retry is clicked', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Wrapper = () => {
      const [fail, setFail] = useState(true);
      return (
        <PaneErrorBoundary sessionId="test-pane" onReset={() => setFail(false)}>
          <FaultyChild shouldThrow={fail} />
        </PaneErrorBoundary>
      );
    };
    render(<Wrapper />);
    expect(screen.getByRole('button', { name: /RETRY/i })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /RETRY/i }));
    expect(screen.getByTestId('pane-content')).toBeDefined();
    spy.mockRestore();
  });
});
```

- [x] **Step 2: Verify test fails**
- [x] **Step 3: Implement `PaneErrorBoundary`**
- [x] **Step 4: Wrap terminal pane component in `PaneErrorBoundary`**
- [x] **Step 5: Run tests and commit**

---

### Task 2: Sever Escalation Edge 1 — Attachment Fault Isolation (B2)

Eliminate `ptyClient.ts:240`: an attachment fault must reattach *that* attachment only, rather than invoking `this.connection.restart(reason)`.

**Files:**
- Modify: `src/core/ptyClient.ts`
- Modify: `src/core/sessionAttachment.ts`
- Test: `src/core/ptyClient.containment.test.ts`

- [x] **Step 1: Write unit test demonstrating socket survival when an attachment faults**
- [x] **Step 2: Modify `ptyClient.ts` to disconnect and re-attach the faulted binding without restarting `this.connection`**
- [x] **Step 3: Update `SessionAttachment` to report failure state to binding without escalating to transport**
- [x] **Step 4: Verify test passes and commit**

---

### Task 3: Sever Escalation Edge 2 — Attach Rejection Isolation (B2)

Eliminate `ptyClient.ts:305`: a rejected `attach()` promise must mark the specific binding as retryable with backoff, never calling `this.connection.restart(...)`.

**Files:**
- Modify: `src/core/ptyClient.ts`
- Test: `src/core/ptyClient.containment.test.ts`

- [x] **Step 1: Write unit test asserting that an `attach()` promise rejection leaves sibling attachments and the transport connection intact**
- [x] **Step 2: Replace `this.connection.restart` call in `attach().catch(...)` with localized binding failure and retry backoff scheduling**
- [x] **Step 3: Run unit tests to confirm passing**
- [x] **Step 4: Commit**

---

### Task 4: Sever Escalation Edge 3 — Send Refusal Non-Escalation (B2)

Modify `sessionAttachment.ts:86`: a single refused `send` should return `false` and inform the caller of the refusal, rather than invoking `this.fail()` and resetting the entire attachment lifecycle.

**Files:**
- Modify: `src/core/sessionAttachment.ts`
- Test: `src/core/sessionAttachment.test.ts`

- [x] **Step 1: Write test verifying that a transient `send()` failure returns false and does not trigger `this.fail()`**
- [x] **Step 2: Update `SessionAttachment.send()` to record the refusal without transitioning status to `failed`**
- [x] **Step 3: Verify tests pass and commit**

---

### Task 5: Eliminate Absorbing State 1 — Clear `binding.reason` on Transition (B3)

Prevent permanent input lockout (Finding 6). `binding.reason` must be cleared whenever a binding transitions toward attachment, and `inputReadiness()` must check live attachment readiness ahead of historical failure strings.

**Files:**
- Modify: `src/core/ptyClient.ts` (`inputReadiness` and state transitions)
- Test: `src/core/ptyClient.inputReadiness.test.ts`

- [x] **Step 1: Write test showing that a session which previously had `binding.reason` set can clear it and accept input once attached**
- [x] **Step 2: Modify `inputReadiness(id)` in `src/core/ptyClient.ts`:**
  - If `binding.attachment?.state.status === 'ready'`, return `null` (allow input), even if `binding.reason` was previously set.
  - Clear `binding.reason` upon successful state transitions.
- [x] **Step 3: Verify tests pass and commit**

---

### Task 6: Eliminate Absorbing State 2 — Bounded Unsent Create Intents (B3)

Address Finding 7: an `'unsent'` create intent must have an explicit timeout (5000ms). If the connection does not become ready to transmit the creation within the deadline, reject the intent and inform the user via toast/overlay rather than leaving an unresolved promise forever.

**Files:**
- Modify: `src/core/ptyClient.ts`
- Test: `src/core/ptyClient.createIntent.test.ts`

- [x] **Step 1: Write test verifying that an unsent create intent rejects with a descriptive error after deadline expiry**
- [x] **Step 2: Implement timer on `CreateIntent` in `ptyClient.ts`**
- [x] **Step 3: Ensure rejection cleans up the intent from `this.creating` and notifies diagnostics**
- [x] **Step 4: Verify test passes and commit**

---

### Task 7: Eliminate Absorbing State 3 — Attachment Concurrency Leases & Anti-Starvation (B3)

Address Finding 8 (`cold-recovery-editor.png` / `WAITING 4` starvation):
- Add a deadline (10s) to attachments in `this.attaching`.
- If an attachment remains in `catching-up` or `awaiting-ready` beyond the lease deadline, release its concurrency slot from `this.attaching` so that subsequent sessions can attach.
- Trigger `pumpBindings()` when slots are freed.

**Files:**
- Modify: `src/core/ptyClient.ts`
- Test: `src/core/ptyClient.attachmentQueue.test.ts`

- [x] **Step 1: Write test with 4 stalled attachments and verify a 5th attachment is admitted once lease deadline expires**
- [x] **Step 2: Implement attachment lease expiration and pump scheduling in `ptyClient.ts`**
- [x] **Step 3: Verify unit test passes and commit**

---

### Task 8: Eliminate Absorbing State 4 — Health Chip Reconnect Decoupling (B3)

Address Finding 9: Decouple process exit code from daemon health in `src/App.tsx`.
- Normal non-zero exit codes must not hijack the health chip.
- When `!ptyClient.getIsConnected()`, the health chip must ALWAYS prioritize reconnecting to the daemon.

**Files:**
- Modify: `src/App.tsx` (`isSessionFailed` and `handleInspectSystemAlert`)
- Test: `src/components/StatusPlate.health.test.tsx`

- [x] **Step 1: Write test verifying clicking the health chip reconnects the socket even if a pane has `lastExitCode !== 0`**
- [x] **Step 2: Modify `handleInspectSystemAlert` in `src/App.tsx` to check `!ptyClient.getIsConnected()` first**
- [x] **Step 3: Refine `isSessionFailed` to distinguish application process errors from shell non-zero exits**
- [x] **Step 4: Verify tests pass and commit**

---

### Task 9: Attributable Refusal & Diagnostics Correlation (B4)

Ensure every input refusal and state fault provides structured attribution:
- Calling unit (`'render'`, `'attachment'`, `'transport'`, `'client'`)
- Reason string
- Request / correlation ID

**Files:**
- Modify: `src/core/ptyClient.ts`
- Modify: `src/core/diagnostics.ts`
- Test: `src/core/diagnostics.refusal.test.ts`

- [x] **Step 1: Write test asserting refusal events appear in `window.__doom` ledger with complete attribution**
- [x] **Step 2: Update `refused()` and `inputReadiness()` to record refusals in `diagnostics`**
- [x] **Step 3: Verify tests pass and commit**

---

### Task 10: Turn Phase 0 Red Fault Specs Green (Verification Gate)

Execute the five Playwright fault specs established in Phase 0:
1. `fault-unknown-variant.spec.ts`
2. `fault-render-throw.spec.ts`
3. `fault-failed-create.spec.ts`
4. `fault-stalled-attach.spec.ts`
5. `fault-malformed-frame.spec.ts`

- [x] **Step 1: Run each fault spec individually with Playwright**
- [x] **Step 2: Assert containment invariant: Pane B remains responsive and echoes keystrokes while Pane A faults**
- [x] **Step 3: Capture full passing screenshots to confirm intact visual chrome**
- [x] **Step 4: Commit passing test runs**

---

### Task 11: Unified Regression Verification

Run the full verification suite:
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run hud:check`
- `cargo check`
- `cargo test`
- `npm run check:tauri`
- `npm run test:ui` (confirm `failure.png` starvation issue is resolved)
