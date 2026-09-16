# Windows Support: Execution Plan

**Design**: [`../specs/2026-09-16-windows-support-design.md`](../specs/2026-09-16-windows-support-design.md)
**Target release**: `v0.2.0`, pre-release
**Started**: 2026-09-16

Stages are ordered so each one is independently verifiable and independently
revertable. Stage N does not depend on Stage N+1 landing.

---

## Stage 0 — Correct the record

No code. The documentation currently states four things the source contradicts,
and planning on top of them would propagate the errors.

| File | Change |
| :--- | :--- |
| `.github/workflows/release.yml:19` | Delete "Windows has never compiled here". Replace with what run `35125159582` proved. |
| `.github/workflows/release.yml` | `tolerated: false` for Windows. A job that has succeeded should not be allowed to fail silently. |
| `README.md` Platform Support | Remove the keyboard pass-through row — it is unconditional per Axiom 1 and was never a Windows gap. Correct the "no witness at all" claim. |

**Verify**: `git diff` reviewed by hand; no build impact.

---

## Stage 1 — `foreground` for Windows *(the keystone)*

**New**: `crates/doom-term-pty/src/foreground/windows.rs`
**Edit**: `crates/doom-term-pty/src/foreground.rs` → thin `cfg` dispatch over
the existing `/proc` functions, which keep their current behaviour byte for
byte on Linux and their current "file absent → `None`" behaviour on macOS.
**Edit**: `crates/doom-term-pty/Cargo.toml` → `[target.'cfg(windows)'.dependencies] windows-sys` with the `Win32_System_Diagnostics_ToolHelp`, `Win32_System_Threading` and `Win32_Foundation` features.

| Function | Windows implementation |
| :--- | :--- |
| `identify(pid)` | `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` → `GetProcessTimes` → creation `FILETIME` as the `start_ticks` nonce |
| `foreground_identity(shell_pid)` | `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` → collect descendants by `th32ParentProcessID` → latest creation time wins → no descendants means the shell itself |
| `foreground_command(shell_pid)` | `QueryFullProcessImageNameW` → file stem → lowercase (D2) |
| `foreground_cwd(shell_pid)` | `None`. Windows has no cheap per-process cwd; OSC 7 from Stage 5 supplies it instead |
| `open_files(_)` | `Vec::new()`, as macOS already does (D3 / `--` table) |
| `classify_agent`, `detect_worktree` | Unchanged. Already portable. |
| `detect_isolation()` | `"host"` |

**Tests** (`#[cfg(windows)]`, run in CI on `windows-latest`):
- the current process is its own `identify()`, and `start_ticks` is stable across two calls
- a spawned `cmd /c timeout` child is found as the foreground of its parent
- a killed child's pid does not resolve to a live identity with the same nonce
- `classify_agent(foreground_command(...))` resolves a renamed `claude.exe` fixture

**Verify**: `cargo check --target x86_64-pc-windows-msvc -p doom-term-pty`
locally (already exits 0 today, so a regression is unambiguous), then
`cargo test` on the Stage 9 Windows runner.

---

## Stage 2 — Job Object process-tree kill

**New**: `crates/doom-term-pty/src/job.rs` (`cfg(windows)`)
**Edit**: `session.rs` — create the job, assign immediately after
`pair.slave.spawn_command(cmd)` at line 489, store the handle on `PtySession`,
and route the `#[cfg(not(unix))]` arms of `kill()` (line 898) and
`retire_adapter_before()` (line 932) through `TerminateJobObject`.

`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` per D5. The assignment race is documented
in the code, not hidden.

**Test**: spawn a shell, have it spawn a grandchild, `kill()`, assert the
grandchild is gone. This is the test that currently fails on Windows and is the
whole point of the stage.

---

## Stage 3 — `run_bounded` for Windows

**Edit**: `crates/doom-term-pty/src/process_io.rs` — replace the
`cfg(not(unix))` `bail!` with a real implementation: a reader thread per pipe,
a deadline on the join, output capped at `HelperLimits::output_bytes`, and the
Stage 2 job for cleanup.

Restores the git branch indicator (`metadata.rs:52`). Does **not** enable tmux —
`resolve_tmux` still finds no binary and `durability_detail` still says so.

Also rename the stub's error text: it is not a "tmux helper", it is the bounded
subprocess runner, and the misleading name is what hid the git-branch casualty.

**Tests**: port the existing `cfg(all(test, unix))` module in `process_io.rs` to
a Windows equivalent — timeout kills, output cap truncates, exit status
propagates, no zombie left behind.

---

## Stage 4 — Path and environment correctness

**New**: one `pty::home_dir()` helper — `HOME`, then `USERPROFILE`, then `None`.
Replaces the bare `std::env::var("HOME")` at:

- `session.rs:39, 69, 73, 138, 174-175`
- `backend/src/usage/credentials.rs:12`
- `backend/src/main.rs:190` (`provision_cli_tools`, today a silent no-op on Windows)
- `backend/src/metadata.rs:41`
- `src-tauri/src/commands.rs:32`

**Edit**: `session.rs::augment_path` — `std::env::split_paths` / `join_paths`
and `Path::join` instead of `':'` and `format!("{}/.local/bin", home)`.
It is already a pure function taking its environment as arguments, so this is
directly testable on both platforms.

**Edit**: `metadata.rs:50` — `HOSTNAME`, then `COMPUTERNAME`, then `localhost`.

**Tests**: `augment_path` with a Windows-shaped `PATH`; `home_dir()` precedence.
Both pure, both run everywhere.

---

## Stage 5 — PowerShell shell integration

**Edit**: `crates/doom-term-pty/src/shell_integration.rs` — recognize
`powershell` / `pwsh`, emit a `prompt` function override producing OSC 133
A/B/C/D with `$LASTEXITCODE`, and OSC 7 with the current location.

Load-bearing per D7: OSC 7 is how `current_dir` reaches `metadata.rs:37`, and
`hint::transcript_for` is keyed on cwd.

**Tests**: generated-script assertions in the existing style (the file already
tests its bash/zsh output as text), plus a `shell_name()` case for
`pwsh.exe` / `powershell.exe`.

---

## Stage 6 — Bundle Microsoft's ConPTY

**New**: `tools/build-conpty-sidecar.mjs` — fetch the
`Microsoft.Windows.Console.ConPTY` NuGet package, verify against a pinned
SHA256, extract `conpty.dll` + `OpenConsole.exe` for the target architecture,
place beside the daemon binary. No-ops off Windows, exactly as
`build-tmux-sidecar.mjs` no-ops without `DOOM_TMUX_BINARY`.

**Edit**: `package.json` `sidecar` chain; `tauri.conf.json` bundle resources;
`THIRD-PARTY-NOTICES.md` (MIT).

**Also fix while here**: `tools/build-tmux-sidecar.mjs:61` names its output from
`hostTriple()` and ignores `TAURI_ENV_TARGET_TRIPLE`, unlike
`build-sidecar.mjs`. Latent cross-compile bug; the new script must not repeat
it, and the old one should stop doing it.

**Verify**: checksum match in CI; `list_files` on the built bundle shows both
files beside `doom-term-server.exe`. Whether the sideload actually changes VT
behaviour is a runtime fact — see "Honest limits".

---

## Stage 7 — Windows notifications

**Edit**: `src-tauri/src/commands.rs:73-82` — `send_desktop_notification`
currently has a `#[cfg(target_os = "linux")]` body and returns `Ok(())`
everywhere else, so on Windows and macOS it silently succeeds at nothing.

Adopt `tauri-plugin-notification` (official, cross-platform) rather than
hand-rolling WinRT toasts. Fixes macOS in the same change.

---

## Stage 8 — Daemon outlives the window on Windows

**Edit**: `src-tauri/src/lib.rs:46-52` — skip `daemon::stop()` on Windows.
`daemon.rs:45-52` already attaches to a live daemon rather than spawning a
second one, so reopening the app rejoins its sessions.

**Edit**: `backend/src/main.rs` — idle self-exit after a grace period with zero
sessions and zero connected clients, so this never leaves an invisible process
running forever.

**Edit**: the Windows `durability_detail` reason string — "survives closing the
app, not a daemon restart", surfaced by the existing `SessionModeNotice.tsx`.

This is the stage most likely to be deferred if the idle-exit logic turns out to
interact badly with reconnect timing. It is last among the functional stages for
that reason.

---

## Stage 9 — Windows CI

**Edit**: `.github/workflows/ci.yml` → matrix over `ubuntu-latest` and
`windows-latest`. Linux keeps the full gate (tmux 3.7 build, bubblewrap,
Playwright). Windows runs the portable subset: `typecheck`, `build`,
`hud:check`, `cargo check`, `cargo test`, and the Node suite minus its POSIX
fixtures.

**Blockers to clear first** — these fail the moment Windows runs `cargo test`:

- `crates/doom-term-pty/tests/stream_journal.rs:119,159,216` — hardcodes
  `/bin/false`, `/bin/cat`, `#!/bin/sh` in tests that are **not** `cfg(unix)`-gated
- `crates/doom-term-pty/src/session.rs:93` — `#[cfg(all(test, unix))] mod tests;`
  hides pure-function tests (`augment_path`, `anchor_candidates`) that have no
  OS dependency at all
- `tools/agent-hooks/*.test.mjs`, `tools/check-tauri.test.mjs` — POSIX shell,
  `chmod`, `symlink` fixtures. `build-tmux-sidecar.test.mjs:8` already shows the
  house pattern: `{ skip: process.platform === 'win32' }`
- `tools/tauri-check-result.mjs:16-22` — `ENVIRONMENT_MARKERS` are pkg-config
  English. On Windows a missing MSVC linker or WebView2 SDK reads as a hard
  `fail`, which is exactly the false signal `check-tauri.mjs` exists to prevent

**Add**: `rustfmt.toml`, `cargo fmt --check`, `cargo clippy -D warnings`, and an
`.editorconfig`. None exist today and `docs/BETA_READINESS.md` records rustfmt
being applied by hand.

---

## Stage 10 — Release hygiene

| Item | Detail |
| :--- | :--- |
| `CHANGELOG.md` | Keep a Changelog format; `v0.1.0` reconstructed from history, `v0.2.0` written as we go |
| `docs/BUILDING.md` | Per-platform prerequisites; the `cargo-xwin` cross-build path; why `src-tauri` is excluded from `default-members` |
| `docs/RELEASING.md` | tag → matrix → assets, and how to verify provenance. Today this exists only as YAML comments |
| `release.yml` | SHA256SUMS asset; `actions/attest-build-provenance`; `releaseBody` from the changelog; pin action SHAs |
| `.github/` | `ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`, `dependabot.yml` |
| Tracking issues | Codex handle enumeration (D3/`--` table); npm-shim argv reading (D3); Windows durable substrate (D8); `portable-pty` job-handle PR (D5) |

Unsigned, with checksums and Sigstore-backed provenance, and the SmartScreen
prompt described plainly in the README. SignPath Foundation's free OSS
programme applied for in parallel; it does not gate this release.

---

## Stage 11 — Release `v0.2.0`

Version bumped in lockstep: `package.json`, `src-tauri/tauri.conf.json`,
`crates/doom-term-pty/Cargo.toml`, `backend/Cargo.toml`, `src-tauri/Cargo.toml`.

1. `npm run agent:verify` green on Linux
2. `ci.yml` green on both runners
3. `workflow_dispatch` smoke run, all four targets, **no tag** — the same
   discipline that caught the empty-artifact path and the dead `macos-13`
   runner before `v0.1.0`
4. Tag `v0.2.0`, publish as pre-release
5. Verify: assets present, `gh attestation verify` passes, checksums match

---

## Honest limits

Three claims cannot be proven from this machine or from CI, and will be written
as provisional in `docs/BETA_READINESS.md` rather than promoted to ✅:

1. that `claude.exe` appears as a descendant of PowerShell rather than behind a
   launcher that breaks the parent chain
2. that the bundled ConPTY forwards a child's `ESC[?2004h` to our demuxer
3. that the PowerShell hook fires correctly inside Claude Code's real hook runner

Each needs someone at a Windows machine. The README table will distinguish
"tested in CI" from "implemented, not yet confirmed on hardware", because
shipping a ✅ that means "the design says so" is the failure mode this whole
document exists to correct.
