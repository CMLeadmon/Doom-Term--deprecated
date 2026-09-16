# Windows Support: Design

**Status**: Design, 2026-09-16
**Execution plan**: [`../plans/2026-09-16-windows-support.md`](../plans/2026-09-16-windows-support.md)

---

## The question

`v0.1.0` shipped a Windows build. It is published, it installs, and it runs a
terminal. It is not an agentic terminal manager: the agent well never lights,
the branch indicator is dark, CONTEXT % and USAGE % read `--` forever, and
closing a pane leaves the agent running where nobody can reach it.

This document decides what "working on Windows" means, and on what evidence.

---

## What is actually true today

Four claims in our own documentation are wrong. They were written from the
architecture rather than from the code, and the code disagrees.

**1. "Windows has never compiled here"** — `release.yml:19`.

False since the first smoke run. `v0.1.0` carries
`Doom.Term_0.1.0_x64-setup.exe` and `Doom.Term_0.1.0_x64_en-US.msi`, and run
`35125159582` succeeded on all four targets. The comment predates the evidence
and was never revisited. Windows *builds*; what it lacks is function.

**2. "Keyboard pass-through by foreground process ❌"** — `README.md`.

False, and it was already false when written. `src/types/sessionTree.ts:64-78`
records the day it stopped being true:

> The block editor is gone and every session is pass-through, so the question no
> longer exists. The field survives because the plate draws this agent's mark.

`keyToBytes` is unconditional. `agentKey` reaches exactly one consumer in
`RawTerminalView.tsx` — `markingAgent()` at line 312, feeding gutter turn-marks.
Axiom 1 holds on Windows today, unchanged and unaided.

**3. "Windows has neither witness, so there is no foreground answer at all."**

Overstated. Windows has no process *group*, which is what `tpgid` reports — but
it has a process *tree*, and the most recently spawned descendant of the shell
is the standard answer. This is not a novel technique: it is what WezTerm does,
documented plainly in `pane:get_foreground_process_info()`. It is a different
witness, not the absence of one.

**4. "Child-checked paste is unsupported on this platform."**

Half true, for the wrong reason. `run_bounded`'s `cfg(not(unix))` stub blocks
the *tmux* paste path. Windows never takes that path — it takes the direct-PTY
path, which authorizes from the child's own observed DECSET 2004. Whether that
works depends on ConPTY's VT fidelity, not on the stub.

### What the stub actually costs

`process_io.rs:143` is the single most expensive line on Windows, and its reach
is wider than tmux:

```rust
#[cfg(not(unix))]
pub fn run_bounded(...) -> Result<Vec<u8>> {
    anyhow::bail!("Bounded tmux helpers are unsupported on this platform")
}
```

It is named for tmux but it is the crate's only bounded subprocess runner.
`metadata.rs:52` runs `git rev-parse --abbrev-ref HEAD` through it. So the
branch indicator is dark on Windows for a reason that has nothing to do with
git, tmux, or Windows — it is collateral from a stub's name.

`available_tmux()` also calls it to run `tmux -V`. So tmux is unreachable on
Windows *by construction*, before any question of whether a `tmux.exe` exists.

### The leak

Verified in the vendored dependency, not inferred.
`portable-pty-0.8.1/src/win/psuedocon.rs:142` spawns with:

```rust
EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
```

No Job Object. No `CREATE_NEW_PROCESS_GROUP`. A grep for `JobObject` across the
whole crate returns nothing. `win/mod.rs:43` kills with `TerminateProcess` on a
single handle.

`session.rs:862-864` already states the principle for the tmux case:

> a leak the user cannot see or reach. Closing a tab has to close the session.

On Windows we are creating exactly that leak, in the direct path, today. Close a
pane running `claude.exe` and the shell dies while the agent keeps running,
holding its API session, with no terminal and no way back to it.

---

## The keystone

Five features that look independent all terminate at one function:

```
foreground_identity(shell_pid)
  ├─→ foreground_command → classify_agent  → agent well, mugshot, turn-marks
  ├─→ metadata.rs:93-98                    → routes CONTEXT % to the right vendor
  ├─→ hint.rs:101  `let process = process?;`
  │        └─→ Claude + Codex transcript attribution
  └─→ main.rs:298-299                      → gates the Claude USAGE % poll
```

`hint::transcript_for` is the one that surprised us. Hook attribution is not
independent of process detection — the hint is re-validated against the live
`ProcessIdentity` specifically to defeat process substitution:

```rust
let process = process?;
...
if hint.at.elapsed() > HINT_TTL || hint.process != process {
    return None;
}
```

So a Windows port cannot route around foreground detection by leaning on hooks.
Equally: implementing foreground detection lights all five at once. This is one
keystone, not five ports.

---

## Decisions

### D1 — Foreground detection is a process-tree walk, not a group query

`ProcessIdentity { pid, start_ticks }` needs no change. Windows supplies an
exact analogue of `start_ticks`: the process creation `FILETIME` from
`GetProcessTimes`, a 64-bit count that is monotonic, unique per spawn, and
therefore defeats PID reuse the same way. Windows recycles PIDs aggressively,
so this guard matters *more* there than on Linux, not less.

`foreground_identity(shell_pid)` snapshots the process table with
`CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)`, walks `th32ParentProcessID` to
collect the descendants of `shell_pid`, and returns the descendant with the
latest creation time. No descendants means the shell itself is in the
foreground, which mirrors what `tpgid` reports on Linux.

**Dependency**: `windows-sys`, gated `[target.'cfg(windows)'.dependencies]`.
It is already in `Cargo.lock` at 0.61.2 via Tauri, so it costs no new
compilation on the Windows target and nothing at all on Linux or macOS.

**Rejected — `sysinfo`**: gives the tree, the names, the start times *and*
command lines in safe code, and is excellent. But it refreshes a `System`
struct on a 2-second telemetry poll across every pane, it is a genuinely new
dependency on all three platforms, and we need roughly four Win32 calls. Kept
in reserve for D3.

**Rejected — `GetConsoleProcessList`**: returns processes attached to a
console, not which one owns it, and Microsoft's own documentation marks it "not
recommended" with no virtual-terminal equivalent.

### D2 — Agent classification normalizes in the Windows layer, never in `classify_agent`

`classify_agent` matches exact strings: `"claude"`, `"codex"`, `"gemini"`. On
Windows the image name is `claude.exe`. The `.exe` strip and the case-fold
belong in `foreground/windows.rs`, so that `classify_agent` stays byte-identical
on Linux and keeps its property that an unknown binary is not an agent.

`QueryFullProcessImageNameW` → file stem → lowercase → `classify_agent`.

### D3 — Node-shimmed agents stay `--`, and we say so

Claude Code ships a native `claude.exe` on Windows and Codex ships `codex.exe`,
so the two agents that carry telemetry resolve by name. Agents installed as npm
shims appear as `node.exe`, which is not an agent and must not light the well.

Reading `node.exe`'s argv means `NtQueryInformationProcess` plus
`ReadProcessMemory` against the PEB — semi-documented, ~80 lines of unsafe, and
a different struct layout for WOW64. That is a real feature with a real cost,
and Axiom 3 already gives the correct behaviour without it: unknown renders
`--`. Deferred to a tracked issue, not smuggled in.

### D4 — `run_bounded` gets a real Windows implementation

Not a tmux concession — it is the crate's bounded subprocess primitive and the
branch indicator depends on it. The Unix version uses `fcntl(O_NONBLOCK)` to
pump both pipes from one thread. Windows anonymous pipes have no equivalent, so
the Windows version uses a reader thread per pipe with a deadline on the join,
and the Job Object from D5 for cleanup.

This restores the git branch on Windows. It does not enable tmux, which still
has no binary to find; `resolve_tmux` will keep returning `None` and
`durability_detail` will keep saying so honestly.

### D5 — Closing a pane kills a Job Object, not a handle

`CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigned immediately
after spawn; `kill()` calls `TerminateJobObject`. This is the Windows analogue
of `killpg` and closes the orphaned-agent leak.

`KILL_ON_JOB_CLOSE` is deliberate: if the daemon dies, its handles close, the
job closes, and the tree dies with it. That is the honest behaviour on a
platform with no durable substrate — an agent outliving the only thing that
could show it to you is a leak, not durability.

**Known race**: a child spawned between `CreateProcessW` and
`AssignProcessToJobObject` escapes the job. The window is microseconds and a
shell does not spawn that fast, but it is real and will be documented in the
code rather than papered over. Nested jobs (Windows 8+) make assignment safe
even if the process is already in a job.

The clean fix is upstream — `portable-pty` should accept a job handle at spawn.
Worth a PR; not worth blocking on.

### D6 — Bundle Microsoft's ConPTY rather than inherit the user's

`portable-pty` already prefers a sideloaded implementation —
`psuedocon.rs:54`:

```rust
if let Ok(sideloaded) = ConPtyFuncs::open(Path::new("conpty.dll")) {
    sideloaded
} else {
    kernel
}
```

Dropping `conpty.dll` and `OpenConsole.exe` beside `doom-term-server.exe` pins
VT behaviour to a known version instead of whatever the user's Windows build
ships. This matters for paste: ConPTY re-emits VT rather than passing it
through, and forwarding unhandled sequences verbatim only arrived with the 1.22
rewrite (`microsoft/terminal#17741`). Without the bundle, whether a child's
`ESC[?2004h` ever reaches our demuxer depends on the user's OS build.

Microsoft publishes the pair on NuGet under MIT — the same pair Windows
Terminal and WezTerm bundle. Zero Rust changes; a packaging step, a pinned
checksum, and a `THIRD-PARTY-NOTICES.md` entry.

If it still does not arrive, paste stays unknown and multiline is refused.
Axiom 3 makes the failure safe rather than silent.

### D7 — PowerShell gets shell integration, which is also how Windows learns its own directory

`shell_integration.rs` recognizes `bash` and `zsh`; everything else takes the
`_ => {}` arm. On Windows that means no OSC 133, so no block model, no exit
codes, no turn marks.

It also means no OSC 7 — and OSC 7 is how `current_dir` reaches
`metadata.rs:37`. The chain is `observed` (needs `/proc` or tmux: both absent)
→ the client's copy (needs OSC 7) → `HOME` (not a Windows variable) → `"/"`.
Without integration, Windows telemetry is keyed on a directory that is wrong,
and `hint::transcript_for` is keyed on `(agent, cwd, session_id)`.

So a PowerShell `prompt` override emitting OSC 133 A/B/C/D and OSC 7 is not
polish. It is load-bearing for attribution.

### D8 — Durable sessions remain absent, and are reported, not simulated

tmux's gift is that the shell is nobody's child of ours. Reproducing it on
Windows needs a per-session holder process over named pipes, re-implementing
`durable.rs`'s incarnation/root-pid identity algebra on a different transport.
That is its own spec.

What ships instead: the daemon outlives the app window on Windows, so sessions
survive closing and reopening Doom Term. `daemon.rs:45-52` already attaches to a
live daemon rather than spawning a second one, so the machinery exists. The
daemon self-exits after an idle period with no sessions and no clients, so this
buys durability without leaving an invisible process forever.

The difference — survives an app restart, does not survive a daemon restart —
is exactly what `durability_detail` and `SessionModeNotice.tsx` already exist
to say. Windows gets a Windows-shaped reason string, not a blank.

---

## What stays `--`, and why

Per Axiom 3 these are answers, not gaps to be filled with zeroes.

| Reading | Windows | Why |
| :--- | :--- | :--- |
| Codex CONTEXT % / rate without a hook | `--` | `open_files` reads `/proc/<pid>/fd`. The Windows equivalent is `NtQuerySystemInformation(SystemExtendedHandleInformation)`, which needs a worker thread to survive `NtQueryObject` deadlocking on synchronous file handles. macOS has had this same gap since launch and ships. With a Codex hook, attribution works. |
| Any npm-shimmed agent | `--` | D3 |
| Isolation, in a Windows container | `"host"` | `/run/.containerenv` has no Windows analogue. Reporting `host` when we cannot tell is the same epistemic position Linux takes when the file is absent. |
| Durable-across-daemon-restart | reported unavailable | D8 |

---

## Verification, and its limits

**Verifiable from this machine**: `cargo check --target x86_64-pc-windows-msvc
-p doom-term-pty` already exits 0 here, so the PTY crate's Windows code
compiles locally in seconds. The backend needs MSVC `lib.exe` for `ring` and
does not cross-check without `cargo-xwin`.

**Verifiable in CI**: a `windows-latest` job in `ci.yml` running typecheck,
build, `hud:check`, `cargo check`, `cargo test`, and the portable half of the
Node suite. That is real evidence and it runs on every push.

**Not verifiable by either**: whether `claude.exe` actually appears as a
descendant of PowerShell rather than behind a launcher; whether the bundled
ConPTY forwards `ESC[?2004h` end to end; whether the PowerShell hook fires
inside Claude Code's real hook runner. These are runtime facts about software
we do not control, on an OS we cannot run here.

Two consequences, both deliberate. Every claim that CI can prove gets a test,
so the Windows column of the README is backed by something. Every claim it
cannot gets written as provisional in `docs/BETA_READINESS.md` until someone
runs it on Windows hardware — not promoted to a ✅ because the design says it
should work. That is the same standard `BETA_READINESS.md` already holds
everything else to.
