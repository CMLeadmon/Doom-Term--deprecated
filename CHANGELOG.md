# Changelog

All notable changes to Doom Term are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Readings that the operating system cannot supply are listed as unavailable
rather than quietly defaulted. That is [Axiom 3](CLAUDE.md) — an unknown metric
renders `--`, never `0`, `0%` or `idle` — and it applies to these notes too: a
capability is listed as working only where it is tested, and as unconfirmed
where it is not.

## [Unreleased]

## [0.2.0] — 2026-09-17

Windows becomes a supported platform rather than a published degraded build,
with a CI runner behind the claim.

### Added

- **A foreground witness on Windows.** Windows has no foreground process
  *group*, so there is no `tpgid` to read. It has a process *tree*, and the
  most recently spawned descendant of the shell is the witness every Windows
  terminal emulator uses. `GetProcessTimes`' creation `FILETIME` carries the
  PID-reuse nonce exactly as `/proc` start ticks do — and matters more on
  Windows, which recycles PIDs harder. This single function is what lights the
  agent well, the mugshot, gutter turn marks, CONTEXT % vendor routing and the
  USAGE % poll gate.
- **PowerShell shell integration**, emitting OSC 133 command boundaries and
  OSC 7. On Linux and macOS that adds the block model to a terminal that
  already knows its directory; on Windows it is also the *only* way the daemon
  learns where a pane is, because `hint::transcript_for` is keyed on the
  working directory and Windows has no `/proc` to read one from.
- **A PowerShell agent hook** (`doom-term-hook.ps1`), so Claude's
  `transcript_path` reaches the daemon on Windows and CONTEXT % has something to
  read. The POSIX hook needs `sh`, GNU `timeout` and `curl`, none of which a
  stock Windows has — and Claude Code's native Windows build no longer requires
  Git for Windows, so installing the `.sh` there wrote a config entry that could
  never fire. Same bounded-critical-path contract: one 1.8s budget covering both
  the stdin read and the POST, a 64 KiB cap, and exit 0 whatever happens. The
  installer and the daemon's own provisioning both pick the hook the platform
  can run.
- **Windows CI.** The portable gate (Node, Vitest, frontend build, pixel-exact
  HUD), plus `cargo check --all-targets` for the whole workspace and the full
  `doom-term-pty` suite — 113 tests on a real Windows runner, including a
  ConPTY test that drives a live pseudoconsole end to end.
- **Desktop notifications on Windows and macOS**, via
  `tauri-plugin-notification`.
- **The daemon outlives the app window on Windows**, so closing Doom Term and
  reopening it finds the agent still working. Bounded by an idle grace period,
  after which the daemon exits and its job objects end the process trees —
  today's behaviour deferred, not abandoned.
- **Format and lint gates in CI**: `cargo fmt --check`, and `clippy -D warnings`
  as a ratchet over the lints that predate its adoption.
- `CHANGELOG.md`, [`docs/BUILDING.md`](docs/BUILDING.md),
  [`docs/RELEASING.md`](docs/RELEASING.md), issue and pull-request templates,
  `.editorconfig`, and Dependabot for Actions, npm and Cargo.
- Release assets now ship a `SHA256SUMS` file and
  [build provenance attestations](docs/RELEASING.md#verifying-a-release),
  verifiable with `gh attestation verify`.

### Fixed

- **Closing a pane no longer orphans the agent it was running.** `portable-pty`
  spawns with no job object and kills a single handle with `TerminateProcess`,
  so the shell died while `claude.exe` kept running — no terminal, no window,
  no way back to it, still holding its API session. A job object is the process
  group Windows does not have.
- **The git branch indicator was dark on Windows** for reasons unrelated to
  git. `run_bounded` was named for tmux and stubbed off-Unix, which hid that it
  is the crate's only bounded subprocess runner; `metadata.rs` pipes
  `git rev-parse` through it.
- **A helper that spawned anything and exited hung the caller forever.** EOF on
  a pipe needs every write handle closed, and a descendant that inherited stdout
  keeps the write end open after the helper is gone. Since the branch indicator
  runs through this path every two seconds, a shell wrapper would have
  permanently hung the daemon's telemetry thread.
- **`PATH` was built with the wrong separator and the wrong slash on Windows**,
  producing `C:\Users\me/.local/bin` joined with `:` and handing it to every
  spawned shell. A missing value degrades; a malformed one corrupts.
- **`HOME` is not a Windows variable**, so every fallback built on it silently
  took its next branch: shells started in the daemon's directory, the Claude
  credentials file was never found, and CLI provisioning installed nothing.
- **OSC 7 carries a `file://` URI**, and nothing decoded a Windows path back out
  of it — so the daemon reported a path no Windows API would accept and
  transcript attribution could never match. UNC authorities and already-encoded
  percent signs survive the round trip.
- The PowerShell integration sourced `$PROFILE` explicitly, but PowerShell
  already loads all four profiles before running a `-File` script, so the
  user's profile ran twice.
- Desktop notifications returned success on Windows and macOS having done
  nothing at all.
- Tests that pinned platform-independent behaviour with POSIX fixtures, and
  path assertions written with a literal `/`, so they could never run on the
  platform they were protecting.
- `tools/tauri-check-result.mjs` could only answer pass or fail on Windows: its
  markers were pkg-config English, so a runner missing the MSVC toolchain read
  as "the crate does not compile".

### Changed

- The README platform table distinguishes *tested in CI* from *implemented, not
  yet confirmed on hardware*. Three Windows claims remain unconfirmed: that
  `claude.exe` appears as a descendant of PowerShell rather than behind a
  launcher, that bracketed paste survives ConPTY, and that the PowerShell hook
  fires inside Claude Code's own hook runner.
- Keyboard pass-through is no longer listed as a platform difference. It never
  was one: Axiom 1 is unconditional and `keyToBytes` consults nothing.

### Known limitations

- **Sessions do not survive a daemon restart on Windows.** tmux's gift is that
  the shell is nobody's child of ours; reproducing it needs a per-session holder
  process, which is its own design.
- **Codex CONTEXT % and rate read `--` on Windows without a hook.** Attributing
  a rollout file to a pane needs that process's open descriptors; macOS has
  shipped with the same gap since launch.
- **Agents installed as npm shims are not identified**, because the foreground
  process genuinely is `node.exe`. Naming the agent would mean reading another
  process's command line.
- **Microsoft's ConPTY is not bundled**, so VT fidelity follows the user's
  Windows build. On builds older than the 1.22 ConPTY rewrite a child's
  bracketed-paste request may not reach the terminal, in which case multiline
  paste is refused rather than delivered unverified.

## [0.1.0] — 2026-09-16

Initial pre-release: the terminal, binary split panes, scrollback, the status
plate, agent identification through `/proc` and tmux, child-checked paste,
durable tmux-backed sessions, and agent hooks for Claude Code and Codex.

Published for Linux (AppImage, deb, rpm), macOS (Apple Silicon and Intel) and
Windows (MSI and NSIS) — the Windows build being a terminal only, which is what
0.2.0 addresses.

[Unreleased]: https://github.com/CMLeadmon/Doom-Term/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/CMLeadmon/Doom-Term/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CMLeadmon/Doom-Term/releases/tag/v0.1.0
