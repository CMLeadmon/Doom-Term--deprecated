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

## [0.3.0] — 2026-09-17

Doom Term learns that the machine its daemon runs on is not always the machine
the work is on. Everything it reported — host, branch, agent, directory — was
computed locally and unconditionally, so an SSH session was described in terms
of the laptop it was opened from. It now reports what the far end says, and
`--` for whatever the far end did not say.

The terminal's viewport also stops tracking the reader by scroll pixel, which
is what made scrolling sticky, history jumble, and a full buffer crawl away
under anyone reading it.

Observed on a Windows build connected to a Linux development machine.

### Added

- **Remote enrichment over the existing PTY.** A shell on the far end reports
  its own host, user, shell, directory and branch once per prompt, and the
  status plate draws those instead of this machine's. The frame is iTerm2's
  documented `SetUserVar`, not a private escape sequence, so the same snippet
  is inert in iTerm2, kitty and WezTerm — they set a variable they ignore —
  rather than printing in every terminal that is not Doom Term.
  `node tools/agent-hooks/install.mjs --remote` installs it on a host you are
  already connected to, additively and reversibly, with the same
  `doom-term-hook` tagging the agent hooks use.
- **A window titlebar in the four materials**, replacing the OS chrome, with
  the agent marks folded into it and `−` `□` `×` drawn as Unicode glyphs. This
  amends Axiom 2 in the open: the Status Plate remains the only persistent
  *application* chrome, and window management gets a strip. It removes one
  piece of floating chrome — the old agents indicator sat over the terminal
  and never had an exception.
- **Smooth scrolling.** The wheel drives an eased, frame-rate-independent
  scroll that honours `prefers-reduced-motion`. There was previously none of
  any kind.
- **Row virtualization.** Only the visible rows plus overscan are in the DOM.
  The whole 5000-line buffer used to be, reconciled on every frame of a
  streaming agent and on every keystroke, before an echo could paint.

### Fixed

- **A remote's shell bootstrap printed itself on connect.** The demuxer modelled
  OSC and CSI and nothing else, so `ESC P` fell through to a catch-all that
  emitted the introducer as text and returned to ground — printing every byte
  of the payload. A machine whose `~/.bashrc` carries Warp's snippet rendered
  its JSON hook on screen at every connect. DCS, SOS, PM and APC are now
  consumed to their terminator. BEL does not terminate them: that leniency has
  only ever applied to OSC, and honouring it let one byte of payload close a
  string early — including the BEL Doom Term's own shell integration puts
  inside its tmux passthrough envelope at every prompt.
- **Scrollback jumbled, and a detached reader drifted.** Line ids were the
  absolute buffer index and shifted every time scrollback trimmed, so React
  re-associated rows with different content. The compensation meant to defend
  against this had never executed: `getLines()` always starts at buffer index
  0, so the trimmed delta was always `0 - 0`, and its unit test passed only by
  feeding a shape `getLines()` cannot produce. Lines are now numbered
  absolutely, counted from the buffer's own trim event.
- **The reader was pinned by scroll pixel, not by line**, which is why
  scrolling back through a running agent fought you and why the viewport
  stuck to the bottom.
- **`CONTEXT %`, `USAGE %`, `BRANCH` and `ENV` described the wrong machine**
  over SSH. A field the remote did not report is now unknown rather than
  answered locally.
- **A keystroke typed before a session finished attaching was discarded
  silently.** It is reported instead. No queue and no replay: bytes held now
  would land in whatever the child is doing by the time it is ready.
- **Scrollback search moved the viewport nowhere** once rows were windowed.
- **An `agy` session drew Antigravity's mark in the shell's tan**, because the
  colour table had no entry for the binary name even though the mark table did.

### Known limitations

- **Predictive local echo is not enabled.** The policy module ships and is
  tested, but it is not wired to the view. Review found that a prompt which
  deliberately does not echo — `sudo`, `ssh`, `passwd`, a git credential
  prompt — produces no output at all, so nothing ever reconciles the
  prediction away and the typed password would be painted on screen. The
  honest signal for "this prompt does not echo" is the PTY's termios `ECHO`
  bit, which the daemon does not yet report. Input latency is still
  substantially improved by row virtualization.

- **The sticky first character is not closed.** One of its two causes — input
  discarded before attachment — is fixed. The other is that the demuxer answers
  every `CSI 6n` cursor-position probe with the origin, whatever the cursor is
  doing, so an agent laying out its composer from that reply erases a cell the
  caret is not in. Removing the fabricated answer alone would be worse: nothing
  else can answer, and the asker would sit on a five-second timeout. Both halves
  must land together.
- **The instrumented `ssh` launch has no caller.** Its arguments cannot reach
  session creation yet, so remote enrichment is reached through the rc-file
  route above rather than automatically.
- **Window resize and Snap Layouts on Windows are unverified.** Tauri loses
  resize with `decorations: false` even when `resizable` is true
  (tauri-apps/tauri#8519); `tauri-plugin-decorum` is registered to keep both,
  and it compiles, but nothing here has confirmed it behaves on a real Windows
  desktop.
- **Context and rate limits stay `--` across a transport.** Both are read from
  an agent's transcript, and the transcript is on the other machine.
- **Remote isolation is reported from the local machine.** `CTNR`/`TREE`/`HOST`
  describe the daemon's own container and worktree state; the enrichment frame
  carries no isolation field. For a remote session the ENV cell shows the host
  instead, so the wrong value is not displayed — but a frame that reports other
  fields without a host would fall back to the local answer.
- **An enrichment frame is accepted from any PTY output**, not only from a
  session known to be an SSH one — as OSC 7 and OSC 133 already are, in every
  terminal. Displaying a file containing the sequence will therefore relabel a
  local pane, until the next prompt expires it.
- Trim counting reads a private `@xterm/headless` interface. It is guarded: if
  that interface changes, line numbers degrade to buffer indices rather than
  going silently wrong.

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
