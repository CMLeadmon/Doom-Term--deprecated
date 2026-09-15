# Sequenced Recovery — Session Handoff Log

> **Purpose:** running record of *verified* state for the
> [sequenced recovery plan](2026-09-10-sequenced-recovery.md), so any agent
> (codex, Claude, agy) can resume without re-deriving it.
> **Rule for this file:** record only what was observed by running a command.
> Claims copied from another agent's summary are labelled as such and are not
> evidence. Unknown stays `--`, never `0`.

## How to resume

1. Read the plan's checkboxes — they are the task list.
2. Run the baseline gate below and confirm it still matches before editing.
3. Append a dated entry to *Session log* when you finish a unit of work.

## Baseline gate

```bash
npm run agent:verify          # typecheck, test, build, hud:check, cargo check/test, check:tauri
toolbox run -c doom-tauri bash -lc 'cd "$PWD" && npm run check:tauri'
```

`check:tauri` reports **ENVIRONMENT BLOCK** on the host (no glib/gtk/dbus-1/
webkit2gtk) and makes `agent:verify` exit `2`. That is not a failure. The
`doom-tauri` toolbox container has the packages; run it there for real evidence.

### Verified 2026-09-15 (Claude, at working tree on top of `de3edec`)

| Gate | Result |
| :--- | :--- |
| `npm run typecheck` | pass |
| `npm test` | 601 Vitest (66 files) + Node tests, 0 fail |
| `npm run build` | pass |
| `npm run hud:check` | pixel-exact against `docs/design/reference/plate-480@1x.png` |
| `cargo check` | pass |
| `cargo test` | 0 failed. doom-term-pty 82 + attachment 10; backend 103 passed, 3 ignored |
| `npm run check:tauri` (host) | ENVIRONMENT BLOCK — missing `dbus-1` |
| `npm run check:tauri` (doom-tauri toolbox) | `tauri shell: checked` |

The 3 ignored tests are live-account only and are intended to stay ignored:
`usage/codex.rs` (reads real `~/.codex/sessions`), `usage/context.rs` (reads real
`~/.claude/projects`), `usage/service.rs`.

**Not covered by any gate above:** the eleven spec gates in
`docs/superpowers/specs/2026-09-09-sequenced-recovery-design.md` still require
real-browser recovery fixtures (Task 7). Nothing headless certifies recovery.

## Corrections to earlier in-plan notes

The plan's Task 4 notes carried summaries that did not hold when re-run:

1. **"104 PTY / 112 backend tests ... pass" (note dated 2026-09-15) was not true
   at that working tree.** `cargo test` exited `101` with one backend failure,
   `recovery_tests::recovery_retains_a_natural_durable_pane_exit_as_unknown_status`.
   Because the gate aborts on first failure, `check:tauri` had never run at all.
   Re-verify before trusting a count in a note.

2. **That test was flaky, not simply broken: 5 failures in 12 runs (~40%).**
   Root cause: it created a durable session with `/bin/false`, whose root exits
   in milliseconds. `PtySession::open_durable_adapter` only returns `Ok` if it
   confirms `has_display_client` *while* `session.is_alive()`; when the pane won
   the race the call `bail!`s. The failure then surfaced four layers away as
   `Incompatible: Negotiated protocol v2 is required`, because `CreateResult`
   emits `"incarnation": null` on error and `Client::Attach.incarnation` is a
   required `Identity`, so the Attach frame failed to deserialize and fell into
   the dispatcher's catch-all arm.
   Fixed by giving the root a sentinel script that outlives creation and exits
   on demand — the pattern already used by
   `recovery_retains_a_real_exit_even_if_a_rendering_fault_preceded_it`. The test
   is now 15/15 deterministic and asserts create succeeded before continuing, so
   a regression reports itself instead of masquerading as a protocol error.
   This matters beyond the one test: the plan requires durable-exit coverage
   *"distinct from losing its display client"*, and the `/bin/false` version was
   non-deterministically exercising exactly the case it had to exclude.

3. **Legacy code is disabled, not removed.** `backend/src/main.rs` has three
   `#[cfg(any())]` gates — an always-false cfg, so the code never compiles:
   line 55 (`ClientMessage` enum, incl. `Spawn`), line 583 (`handle_client_msg`),
   line 928 (the entire legacy `mod tests`, ~337 lines). `cargo test` is
   therefore green partly because those tests do not run. The public listener
   itself is genuinely v2-only (`main.rs:580` goes straight to
   `RecoveryServer::accept`), and `new-session -A` is already gone from the
   create path (`tmux.rs:216`+ builds `new-session -d -c … -s … -x … -y …`).
   Finishing Task 3's last box and Task 4's "remove rebind/replay" is now
   mostly *deleting* this dead code rather than writing new code.

## Open findings not yet acted on

- `backend/src/recovery.rs` `create()` maps every failure to
  `Err(_) => failure("failed-unknown")`, discarding the underlying error. That
  is what made finding (2) hard to diagnose. Task 4 requires "typed outcomes
  follow the spec verbatim", so this likely needs a real typed cause.

## Session log

### 2026-09-15 — Claude (Opus 5), inline on `main`, no subagents

- Established the first independently verified baseline (table above); found it
  red, contrary to the in-plan note.
- Fixed the flaky durable-exit test (finding 2). Only test code changed;
  production behaviour was deliberately left alone, because spec gate 10 wants
  no false ready state when a process exits during attach.
- Recorded findings (1) and (3) above.
- Ran `check:tauri` in the `doom-tauri` toolbox, converting a standing
  environment block into real evidence for the first time.
