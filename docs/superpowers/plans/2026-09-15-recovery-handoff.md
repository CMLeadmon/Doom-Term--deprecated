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

> **Caution — the host result goes stale-green.** `check:tauri` shells out to
> `cargo check --manifest-path src-tauri/Cargo.toml`, and the toolbox shares the
> home directory, so once a toolbox run populates
> `src-tauri/target/*/build/libdbus-sys-*/output` the host reuses that cached
> build-script result and never re-probes for `dbus-1`. The host then prints
> `tauri shell: checked` — observed on 2026-09-15, in the same tree that had
> printed ENVIRONMENT BLOCK an hour earlier. Treat a host pass as "the code
> compiles", never as "this machine has the packages". The toolbox run is the
> authoritative one.

### Verified 2026-09-15 (Claude, at working tree on top of `de3edec`)

| Gate | Result |
| :--- | :--- |
| `npm run typecheck` | pass |
| `npm test` | 601 Vitest (66 files) + Node tests, 0 fail |
| `npm run build` | pass |
| `npm run hud:check` | pixel-exact against `docs/design/reference/plate-480@1x.png` |
| `cargo check` | pass |
| `cargo test` | 0 failed. doom-term-pty 82 + attachment 10; backend 103 passed, 3 ignored |
| `npm run check:tauri` (host) | ENVIRONMENT BLOCK — missing `dbus-1` (see caution above) |
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

**Task 3 closed.** Deleted the three `#[cfg(any())]` blocks in
`backend/src/main.rs` (legacy `ClientMessage`, `handle_client_msg`, legacy
`mod tests`) — 749 lines, file 1266 → 514. No wire behaviour changed; the public
listener already bypassed them.

Before deleting, audited what the disabled tests actually covered, because
blanket-deleting them would have dropped coverage of *live* code. Restored into
`security_tests.rs`:

- `defaults_to_loopback_so_the_bundled_daemon_is_not_a_network_shell`
- `ipv6_loopback_is_a_valid_socket_address`
- `a_non_loopback_doom_host_is_refused_before_it_can_bind` (new — `loopback_host`
  had no test at all, despite guarding `DOOM_HOST` against remote binding)

Each was proven to fail against a deliberately broken `listen_addr` default
before being kept. The remaining legacy tests encode pre-v2 semantics that were
deliberately replaced (e.g. directory-fallback hook attribution, now forbidden
by `an_unattributed_hook_cannot_describe_a_pane`), so they were not carried
over. Backend suite 103 → 106 passing.

Also verified the deletion of `backend/src/paste_tests.rs` was a real migration,
not coverage loss: `PasteResult` request_id/session_id correlation, the
no-secret-echo property and multiline refusal are all still asserted, in
`recovery_tests.rs`, `protocol.rs` and `crates/doom-term-pty/tests/paste.rs`.

**Task 4 closed except its joint-publish box.** Boxes 1-4 verified by re-running
their named tests; box 5 stays open because it also requires publishing together
with frontend Task 6.

Two genuine coverage gaps were found and closed, both proven load-bearing by
breaking the production code and watching the new test catch it:

- `recovery_concurrent_creates_reserve_one_id_and_a_failed_create_releases_it`.
  The `catalog.creating` reservation had *no* coverage — the existing
  duplicate-create test sent its second request after the first had replied, so
  it was rejected by the finished sessions map and never reached the
  reservation. With the `creating` check removed, all four racing creates win
  and four real shells are spawned over one id.
- `recovery_an_evicted_resume_cursor_is_an_explicit_gap_not_a_silent_skip`.
  The journal reported `StreamError::Gap`, but nothing asserted what the daemon
  did with it. With the check removed the daemon answers `outcome: "resume"` for
  a cursor whose records are gone, handing the frontend a transcript with a hole
  in it and no way to know. This is spec gate 4's "explicit gaps".

Both are deterministic (12/12 and 10/10). Full `agent:verify` exits 0.

**Task 7 reviewed; recovery is NOT certified.** All five boxes stay open. The
eleven-gate checklist lives in the plan under Task 7 — read it before doing
anything else here.

Headline: the browser suite (`npm run test:ui`) exits 1. It is the only thing
that can certify recovery, and it does not pass.

One blocking defect, diagnosed and reproduced three times:

> `RecoveryConnection.receive` calls `options.onMessage(...)` inside
> `socket.onmessage`'s `try`, so a `SessionAttachment` protocol assertion
> (`Record outside its captured phase`, `Unacknowledged readiness`,
> `Record identity changed`) lands in the catch that calls
> `disconnect('incompatible', …, false)`. Retry is `false`, so a recoverable
> attachment fault permanently marks the daemon incompatible.

Symptom: after a second disconnect coinciding with a viewport resize, output
keeps flowing and the screen looks healthy, but every keystroke is refused with
`Connection disconnected or not negotiated; input was not sent`. The refusal is
a self-clearing toast, so within a second or two the terminal simply looks live
and is not. That is the false ready state gate 10 forbids.

**Not fixed, deliberately.** Splitting that catch changes a safety contract:
malformed frames genuinely are incompatible and must not retry, while a consumer
exception should drop and restart only that attachment. Which exceptions land on
which side is the owner's call. Whoever picks this up should start there.

Second, independent problem: the warm-recovery cell comparison is flaky on its
own (one failure in three runs), so gates 1-3 cannot be claimed until it is
stabilised. Because the suite aborts on the first hard failure, gates 5, 7 and 9
and the whole cold-daemon-restart leg have never executed at all.

Method note for whoever continues: the browser harness aborts `main()` on the
first hard assertion, so a single broken scenario hides every later one. When
chasing a failure, instrument in place — the refusal toast is a plain `<div>`
with no `role`, so a `[role="status"]` probe silently finds nothing. Screenshots
land in a `mktemp -d` directory named in the log; `failure.png` is written on
abort and is worth opening.

### Update — blocking defect fixed, browser suite reached full green once

The `incompatible`-misclassification described above is **fixed**. The consumer
boundary is isolated behind a `ConsumerFault` marker in `recoveryConnection.ts`:
a consumer fault restarts and reconnects, while malformed frames and
unnegotiated events still fail closed with no retry. Two guard tests hold both
sides of that line.

The browser harness also now retypes a line instead of sending it once. Input is
deliberately never queued or replayed, so a keystroke typed during a reconnect is
dropped by contract; retyping is what a user does, and it proves the terminal
comes back rather than going quietly read-only.

With both changes, `npm run test:ui` reached `EXIT=0` with every scenario
passing, including `cold daemon restart preserves exact editor/root, separates
history, refuses offline input, and saves the file` — gates 5, 7, 9 and 11's
browser leg, none of which had ever executed before, because the harness aborts
on the first hard assertion and one broken scenario hid eight later ones.

Also fixed the PTY-side twin of the durable-exit flake
(`session::tests::a_natural_durable_pane_exit_is_observed_as_process_closure`),
which used `/bin/false` and eventually lost the same handshake race. 12/12 now.

**The one remaining blocker is the warm-recovery cell-comparison flake**
(roughly half of runs). Do not start from scratch on it — the useful facts are:

- Both sides render 510 rows. In a *passing* run both are missing exactly
  `CELL_458`, `CELL_459`, `CELL_460`. The assertion compares warm against
  control, so anything wrong in both is invisible to it.
- Failing runs are the ones where the two sides drop *different* cells.
- Not scrollback: `xtermScreen` keeps 5,000 lines; the fixture emits ~1,030.

Next step: make the fixture append each cell to a file as well as stdout, and
diff that file against the rendered rows. That separates "the child never wrote
it" from "we wrote it and the pipeline lost it". If it is the latter, a terminal
dropping ~3 lines in 510 under 5 ms output is a rendering defect in its own
right, well beyond a flaky test.

