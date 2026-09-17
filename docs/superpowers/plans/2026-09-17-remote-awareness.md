# Remote Awareness: Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the terminal answering about the wrong machine. Teach the demuxer the control strings it currently prints as text, carry enrichment from a remote shell in-band, and render `--` for anything the remote did not report.

**Architecture:** One new demuxer string-state closes the leak and opens the channel. A remote shell emits an iTerm2 `SetUserVar` frame each prompt; the daemon parses it into a `remote` block on `Telemetry`; the frontend prefers remote-origin fields and never falls back to local.

**Tech Stack:** Rust 2021 (`doom-term-pty`, `backend`), Tokio, serde, TypeScript 5.7.

**Spec:** [`../specs/2026-09-17-remote-and-render-design.md`](../specs/2026-09-17-remote-and-render-design.md) — Track B, plus Finding 6.

**Branch**: `feat/remote-enhancement`
**Started**: 2026-09-17

**This plan owns every change to `crates/doom-term-pty/` and `backend/`.** The
render plan ([`2026-09-17-render-pipeline.md`](2026-09-17-render-pipeline.md))
owns TypeScript in `src/components/` and `src/core/`. Stage 6 and Stage 7 below
touch `src/hooks/` and `src/hud/`, which the render plan does not.

---

## Global Constraints

**Axiom 3 governs this whole plan.** An unknown value renders `--`, never `0`,
`0%`, `idle`, or a value that is true of a different machine. Where the two
plans disagree about a field, `--` wins.

**Axiom 1:** plain `Ctrl` keys belong to the foreground child. Nothing here
binds a key.

**Verification — the whole gate:**
```bash
npm run agent:verify
```
Baseline measured 2026-09-17 on this branch: `npm run typecheck` clean,
`npm run hud:check` PASS at 0 mismatched px. **Stage 7 deliberately moves the
HUD baseline** and is the only stage permitted to.

**The telemetry suite is Linux-only.** `backend/src/main.rs:22-23` gates it
`#[cfg(all(test, target_os = "linux"))]`, so `cargo test` on macOS and Windows
runs zero telemetry tests. Every assertion added to
`backend/src/telemetry_tests.rs` is Linux-only coverage; say so in the commit
rather than believing CI proved it everywhere.

**`src-tauri` is not touched by this plan** and needs no toolbox.

---

## File Structure

| File | Responsibility |
| :--- | :--- |
| `crates/doom-term-pty/src/demuxer.rs` | Gains a string-sequence state (DCS/APC/PM/SOS) and the enrichment frame event. Stops fabricating a cursor position. |
| `crates/doom-term-pty/src/remote.rs` **(new)** | Parses one enrichment frame. Pure: bytes in, a validated struct or nothing out. |
| `crates/doom-term-pty/src/shell_integration.rs` | Gains the remote snippet and the `doom-ssh` launch form. |
| `backend/src/metadata.rs` | Learns that a session may be remote, and that local values do not substitute. |
| `backend/src/recovery.rs:684-713` | The real `GetTelemetry` dispatch, and the hand-injection point the enum does not describe. |
| `src/hooks/usePtyEvents.ts` | Applies the merge rule. |
| `src/hud/state.ts`, `src/hud/plate.js` | Render the remote host in the ENV cell. |

---

## Stage 1 — Control strings are consumed, never printed *(the keystone)*

**Files:**
- Modify: `crates/doom-term-pty/src/demuxer.rs:29-44` (state), `:275-303` (ESC dispatch), `:307` (ground)
- Test: inline `mod tests` at `crates/doom-term-pty/src/demuxer.rs:436`

**Interfaces:**
- Produces: nothing public changes. `DemuxEvent` is unchanged in this stage.

**The defect, exactly.** `demuxer.rs:291-298` is a catch-all: any ESC introducer
that is not `]` or `[` is pushed into `output_chunk` as two literal bytes, and
the state machine returns to ground — so every following byte of the body is
consumed as ordinary text at `:307`. There is no notion of a String Terminator.

- [ ] **Step 1: Write the failing test — the exact reported bytes**

Add to `demuxer.rs`'s inline `mod tests`:

```rust
    #[test]
    fn a_warp_bootstrap_frame_never_reaches_the_renderer() {
        // Observed on a remote whose ~/.bashrc carries Warp's auto-warpify
        // snippet. ESC P fell through the ESC catch-all, so the payload printed
        // from `$f` onward, character for character.
        let mut demuxer = StreamDemuxer::new();
        let input = b"before\x1bP$f{\"hook\": \"SourcedRcFileForWarp\", \"value\": { \"shell\": \"bash\" }}\x1b\\after";
        let events = demuxer.process_bytes(input);
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.clone()),
                _ => None,
            })
            .collect();
        assert!(!text.contains("SourcedRcFileForWarp"), "DCS payload reached the screen: {text:?}");
        assert!(!text.contains("$f"), "DCS payload reached the screen: {text:?}");
        assert_eq!(text, "beforeafter");
    }

    #[test]
    fn an_eight_bit_string_terminator_ends_a_control_string() {
        // Warp terminates with the single byte 0x9c, which is invalid UTF-8.
        // take_output's from_utf8_lossy would replace it with U+FFFD before any
        // consumer could resynchronise on it, so it must be recognised in the
        // byte loop, ahead of the splice.
        let mut demuxer = StreamDemuxer::new();
        let events = demuxer.process_bytes(b"a\x1bP$fpayload\x9cb");
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "ab");
    }

    #[test]
    fn apc_pm_and_sos_are_swallowed_like_dcs() {
        for (intro, eight_bit) in [(&b"\x1b_"[..], 0x9fu8), (&b"\x1b^"[..], 0x9e), (&b"\x1bX"[..], 0x98)] {
            let mut demuxer = StreamDemuxer::new();
            let mut input = b"x".to_vec();
            input.extend_from_slice(intro);
            input.extend_from_slice(b"secret");
            input.extend_from_slice(b"\x1b\\y");
            let text: String = demuxer
                .process_bytes(&input)
                .iter()
                .filter_map(|e| match e {
                    DemuxEvent::Output { data } => Some(data.clone()),
                    _ => None,
                })
                .collect();
            assert_eq!(text, "xy", "introducer {intro:?} leaked");
            let _ = eight_bit;
        }
    }

    #[test]
    fn a_control_string_split_across_two_reads_still_terminates() {
        // A PTY read ends on an arbitrary byte boundary (8192 bytes,
        // session.rs), so a frame routinely straddles two of them.
        let mut demuxer = StreamDemuxer::new();
        let first = demuxer.process_bytes(b"a\x1bP$fpay");
        let second = demuxer.process_bytes(b"load\x1b\\b");
        let text: String = first
            .iter()
            .chain(second.iter())
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "ab");
    }

    #[test]
    fn an_unterminated_control_string_faults_rather_than_growing_forever() {
        let mut demuxer = StreamDemuxer::new();
        let mut input = b"\x1bP".to_vec();
        input.extend(std::iter::repeat(b'x').take(crate::stream::MAX_RECORD_BYTES + 16));
        let events = demuxer.process_bytes(&input);
        assert!(events.iter().any(|e| matches!(
            e,
            DemuxEvent::StreamFault { reason: crate::stream::StreamFault::ControlTooLong }
        )));
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test -p doom-term-pty a_warp_bootstrap_frame`
Expected: FAIL — the assertion reports the payload in the output text.

- [ ] **Step 3: Implement the string state**

Add to the struct at `demuxer.rs:29-44`:

```rust
    /// An open DCS/APC/PM/SOS string, if any.
    ///
    /// The demuxer modelled OSC and CSI and nothing else, so `ESC P` fell into
    /// the ESC catch-all: the introducer was emitted as text and the state
    /// machine returned to ground, which printed every byte of the body. These
    /// carry no screen content by definition — the terminator is the only part
    /// that matters, and swallowing the rest is the whole job.
    in_string: bool,
    string_len: usize,
```

In the byte loop, ahead of the `in_osc` branch:

```rust
            if self.in_string {
                if self.string_len == MAX_CONTROL_LEN {
                    events.push(self.control_fault());
                    return events;
                }
                self.string_len += 1;
                // ST arrives two ways: 7-bit ESC \ and the single byte 0x9c.
                // BEL is accepted leniently, as it is for OSC.
                if b == 0x9c || b == 0x07 {
                    self.in_string = false;
                } else if b == 0x1b {
                    self.string_esc = true;
                } else if self.string_esc {
                    // ESC \ closes; ESC anything-else stays inside the string.
                    self.string_esc = false;
                    if b == b'\\' { self.in_string = false; }
                }
                i += 1;
                continue;
            }
```

...with `string_esc: bool` added beside `in_string`. In the `in_esc` dispatch at
`:275`, before the catch-all:

```rust
                // DCS, SOS, PM, APC. Nothing inside one is screen content.
                if matches!(b, b'P' | b'X' | b'^' | b'_') {
                    self.in_string = true;
                    self.string_esc = false;
                    self.string_len = 0;
                    i += 1;
                    continue;
                }
```

**Do NOT recognise the 8-bit introducers in ground state.** This plan
originally said to, and that was wrong: `0x80..=0xbf` is the UTF-8
*continuation* range and the C1 introducers live inside it, so `0x9f` is both
the APC introducer and the second byte of U+1F389 (`f0 9f 8e 89`). Claiming
them ate every four-byte emoji, and the existing
`a_four_byte_emoji_survives_a_split_at_every_interior_offset` failed on the
first run. xterm declines them in UTF-8 mode for the same reason.

Only the 7-bit `ESC P` / `ESC X` / `ESC ^` / `ESC _` forms introduce a string.
The 8-bit ST **is** honoured, but only inside an already-open string, where the
body is opaque bytes rather than decoded text — that is the terminator Warp
emits, and the `in_string` branch above already handles it.

`control_fault` (`:325`) must clear the new state alongside `osc_buf`/`csi_buf`:
`self.in_string = false; self.string_esc = false; self.string_len = 0;`

- [ ] **Step 4: Run them and watch them pass**

Run: `cargo test -p doom-term-pty`
Expected: PASS, including every pre-existing demuxer test. The tmux passthrough
wrapper `shell_integration.rs` generates is itself a DCS; confirm
`test_osc_133_demuxing` and the tmux-wrapped variants still pass.

- [ ] **Step 5: Commit**

```bash
git add crates/doom-term-pty/src/demuxer.rs
git commit -m "fix(pty): consume DCS, APC, PM and SOS instead of printing them

The demuxer modelled OSC and CSI and nothing else. ESC P hit the ESC
catch-all, which emits the introducer as text and returns to ground, so every
byte of the body printed as ordinary output. A remote whose bashrc carries
Warp's bootstrap therefore rendered

  \$f{\"hook\": \"SourcedRcFileForWarp\", ...}

on connect. The 0x9c terminator is honoured inside an open string; the 8-bit
introducers are declined, because in UTF-8 they are continuation bytes."
```

---

## Stage 2 — The demuxer stops inventing a cursor position

**Files:**
- Modify: `crates/doom-term-pty/src/demuxer.rs:123-126`
- Test: inline `mod tests`

`demuxer.rs:123-126` answers every `CSI 6n` with `\x1b[1;1R`. The comment is
candid — *"the demuxer does not model a cursor, so it reports the origin"* — and
that is a fabricated measurement returned to a program that asked for a real
one. It is Axiom 3 violated at the source, and the leading hypothesis for the
sticky first character: an agent that positions its composer from that reply
erases relative to a column the caret is not in.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_cursor_report_is_never_fabricated() {
        // The origin is not an approximation of the cursor. It is a different
        // number, and an agent that lays out its composer from it erases a cell
        // the caret is not in.
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"hello world");     // caret is at column 12
        demuxer.process_bytes(b"\x1b[6n");
        let reply = String::from_utf8(demuxer.take_responses()).unwrap();
        assert_ne!(reply, "\x1b[1;1R", "the demuxer invented a cursor position");
    }

    #[test]
    fn genuinely_static_probes_are_still_answered_immediately() {
        // Silence costs the asker five seconds. DSR 5 and the device
        // attributes are constants, so answering them is free and honest.
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"\x1b[5n\x1b[c");
        let reply = String::from_utf8(demuxer.take_responses()).unwrap();
        assert!(reply.contains("\x1b[0n"));
        assert!(reply.contains("\x1b[?1;2c"));
    }
```

- [ ] **Step 2: Run and watch the first fail**

Run: `cargo test -p doom-term-pty a_cursor_report_is_never_fabricated`
Expected: FAIL — the reply is exactly `\x1b[1;1R`.

- [ ] **Step 3: Implement — decline rather than lie**

Remove the `"6n"` arm from `csi_reply` (`:126`). A terminal that does not
answer DSR 6 is declining, which is a position it is entitled to take; a
terminal that answers wrongly is not.

```rust
            // DSR 6 — cursor position — is deliberately ABSENT.
            //
            // It used to be answered `\x1b[1;1R` unconditionally, on the
            // reasoning that an approximate answer costs a repaint and silence
            // costs five seconds. The origin is not an approximation: it is a
            // fabricated measurement handed to a program that asked for a real
            // one, which is Axiom 3 violated in the one place where the cost is
            // not a dash on a plate. The demuxer has no cursor to report, so it
            // reports nothing. Adding a cursor model here would duplicate the
            // one @xterm/headless already maintains on the client.
            "5n" => Some("\x1b[0n"),
```

- [ ] **Step 4: Run and watch both pass**

Run: `cargo test -p doom-term-pty`
Expected: PASS.

- [ ] **Step 5: Reproduce the sticky first character against a real agent**

This is the stage's real deliverable and it cannot be automated. With
`npm run dev` and a session SSH'd to a host running Claude Code or Codex:

1. Start the agent and type a single character the instant its composer appears.
2. Record whether the character is stuck, missing, or normal, ten times.
3. Repeat with `DOOM_TERM_NO_SHELL_INTEGRATION=1` set.

Write the outcome into
`docs/superpowers/specs/2026-09-17-remote-and-render-design.md` under Track A3,
replacing the hypothesis with the finding. **If the character still sticks with
this stage applied, hypothesis 2 is disproved and the render plan's Stage 7 is
the remaining candidate** — say so in the spec rather than leaving both open.

- [ ] **Step 6: Commit**

```bash
git add crates/doom-term-pty/src/demuxer.rs docs/superpowers/specs/2026-09-17-remote-and-render-design.md
git commit -m "fix(pty): decline DSR 6 rather than answering it with the origin

Every cursor-position probe was answered \x1b[1;1R whatever the caret was
doing. An agent that lays out its composer from that reply erases relative to
a column the caret is not in. DSR 5 and the device attributes are genuinely
static and still answer immediately."
```

---

## Stage 3 — The enrichment frame parser

**Files:**
- Create: `crates/doom-term-pty/src/remote.rs`
- Modify: `crates/doom-term-pty/src/lib.rs` — `mod remote;` and re-export
- Modify: `crates/doom-term-pty/src/demuxer.rs:404` — recognise the frame

**Interfaces:**
- Produces: `RemoteEnrichment { host, user, shell, cwd, branch, agent, busy }`,
  all `Option`; `parse_frame(b64: &str) -> Option<RemoteEnrichment>`;
  `DemuxEvent::RemoteEnrichment { data: RemoteEnrichment }`.

The wire form is iTerm2's documented `SetUserVar`, chosen over a private OSC
number so the same snippet is inert in iTerm2, kitty and WezTerm — they set a
variable they ignore — rather than printing garbage in every terminal but ours.

```
OSC 1337 ; SetUserVar = doomterm = <base64(json)> ST
```

- [ ] **Step 1: Write the failing tests**

Create the inline `mod tests` in `crates/doom-term-pty/src/remote.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn encode(json: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(json)
    }

    #[test]
    fn parses_a_well_formed_frame() {
        let frame = encode(r#"{"v":1,"host":"devbox","user":"cml","shell":"bash","branch":"main","agent":"claude","busy":true}"#);
        let got = parse_frame(&frame).expect("a v1 frame must parse");
        assert_eq!(got.host.as_deref(), Some("devbox"));
        assert_eq!(got.agent.as_deref(), Some("claude"));
        assert_eq!(got.busy, Some(true));
    }

    #[test]
    fn a_field_the_remote_omitted_is_none_not_a_default() {
        // None renders '--'. An empty string would render as a host named "".
        let got = parse_frame(&encode(r#"{"v":1,"host":"devbox"}"#)).unwrap();
        assert_eq!(got.branch, None);
        assert_eq!(got.busy, None);
    }

    #[test]
    fn rejects_an_unknown_schema_version_whole() {
        assert!(parse_frame(&encode(r#"{"v":2,"host":"devbox"}"#)).is_none());
        assert!(parse_frame(&encode(r#"{"host":"devbox"}"#)).is_none());
    }

    #[test]
    fn rejects_malformed_input_without_partially_applying_it() {
        assert!(parse_frame("not base64 at all !!!").is_none());
        assert!(parse_frame(&encode("{ not json")).is_none());
        assert!(parse_frame("").is_none());
    }

    #[test]
    fn refuses_an_oversized_frame() {
        let big = encode(&format!(r#"{{"v":1,"host":"{}"}}"#, "x".repeat(16 * 1024)));
        assert!(parse_frame(&big).is_none());
    }

    #[test]
    fn refuses_control_characters_in_a_reported_field() {
        // These values are drawn on the plate. A newline or an escape
        // introducer in one is a remote writing to our chrome.
        let got = parse_frame(&encode("{\"v\":1,\"host\":\"dev\\u001b[31mbox\"}"));
        assert!(got.is_none());
    }
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cargo test -p doom-term-pty remote::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `crates/doom-term-pty/src/remote.rs`:

```rust
//! Enrichment reported by a shell on the other end of a transport.
//!
//! Everything in `backend/src/metadata.rs` is computed from the machine the
//! daemon runs on. Over SSH that machine is not where the work is: the
//! hostname is the laptop's, `git -C` runs against a path that exists only on
//! the remote, and the foreground process is `ssh`. This module carries the
//! remote's own answers back in-band, on the same PTY the session already has.
//!
//! Every field is optional and an absent one stays absent. A local value is
//! never substituted: it is not a degraded version of the remote answer, it is
//! an answer about a different computer.

use serde::{Deserialize, Serialize};

/// The only schema this build understands. A frame from a newer remote is
/// discarded whole rather than read field by field.
const SCHEMA_VERSION: u32 = 1;

/// Frames are drawn on a 480px plate. Anything near this is not enrichment.
const MAX_FRAME_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteEnrichment {
    pub host: Option<String>,
    pub user: Option<String>,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    /// The remote's own foreground classification, by the same vocabulary
    /// `classify_agent` uses. Never widened to admit `ssh`.
    pub agent: Option<String>,
    pub busy: Option<bool>,
}

#[derive(Deserialize)]
struct Frame {
    v: u32,
    #[serde(default)] host: Option<String>,
    #[serde(default)] user: Option<String>,
    #[serde(default)] shell: Option<String>,
    #[serde(default)] cwd: Option<String>,
    #[serde(default)] branch: Option<String>,
    #[serde(default)] agent: Option<String>,
    #[serde(default)] busy: Option<bool>,
}

/// A field is admissible only if it cannot write to our chrome.
fn clean(value: Option<String>) -> Result<Option<String>, ()> {
    match value {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) if s.chars().any(|c| c.is_control()) => Err(()),
        Some(s) => Ok(Some(s)),
    }
}

/// One frame, or nothing. There is no partial apply: a frame we only half
/// understand would put half a remote's identity beside half of the local
/// machine's, which is worse than reporting neither.
pub fn parse_frame(b64: &str) -> Option<RemoteEnrichment> {
    use base64::Engine;
    if b64.is_empty() || b64.len() > MAX_FRAME_BYTES {
        return None;
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if raw.len() > MAX_FRAME_BYTES {
        return None;
    }
    let frame: Frame = serde_json::from_slice(&raw).ok()?;
    if frame.v != SCHEMA_VERSION {
        return None;
    }
    Some(RemoteEnrichment {
        host: clean(frame.host).ok()?,
        user: clean(frame.user).ok()?,
        shell: clean(frame.shell).ok()?,
        cwd: clean(frame.cwd).ok()?,
        branch: clean(frame.branch).ok()?,
        agent: clean(frame.agent).ok()?,
        busy: frame.busy,
    })
}
```

`base64` must be added to `crates/doom-term-pty/Cargo.toml` if absent; check
with `grep -n base64 crates/doom-term-pty/Cargo.toml` first.

- [ ] **Step 4: Recognise the frame in the demuxer**

`demuxer.rs:404` already branches on `1337;`. Extend it, keeping the existing
`AgentState` arm intact:

```rust
        if trimmed.starts_with("1337;") {
            let body = &trimmed[5..];
            if body.starts_with("AgentState=") {
                let state = body["AgentState=".len()..].trim().to_lowercase();
                return Some(DemuxEvent::AgentState { state });
            }
            if let Some(payload) = body.strip_prefix("SetUserVar=doomterm=") {
                // A frame we cannot parse is dropped silently. It has already
                // been kept off the screen by being an OSC record at all.
                return crate::remote::parse_frame(payload.trim())
                    .map(|data| DemuxEvent::RemoteEnrichment { data });
            }
        }
```

Add the variant to `DemuxEvent` (`demuxer.rs:3-16`):

```rust
    RemoteEnrichment { data: crate::remote::RemoteEnrichment },
```

- [ ] **Step 5: Run and watch them pass**

Run: `cargo test -p doom-term-pty`
Expected: PASS. `DemuxEvent` is `#[serde(tag = "type", content = "payload")]`,
so the new variant serialises as
`{"type":"RemoteEnrichment","payload":{"data":{...}}}` with no attribute needed.

- [ ] **Step 6: Commit**

```bash
git add crates/doom-term-pty/src/remote.rs crates/doom-term-pty/src/demuxer.rs \
        crates/doom-term-pty/src/lib.rs crates/doom-term-pty/Cargo.toml
git commit -m "feat(pty): parse a remote enrichment frame

iTerm2's documented SetUserVar rather than a private OSC number, so the same
snippet is inert in iTerm2, kitty and WezTerm instead of printing in them.
A malformed or oversized frame is discarded whole; there is no partial apply."
```

---

## Stage 4 — Telemetry carries the remote block

**Files:**
- Modify: `backend/src/main.rs:103-135` — the `Telemetry` variant
- Modify: `backend/src/metadata.rs:11-142`
- Modify: `backend/src/recovery.rs:684-713` — the dispatch **and** the
  hand-injection at `:704-709`
- Test: `backend/src/telemetry_tests.rs`

**The trap this stage exists to avoid.** `ServerMessage::Telemetry` does not
declare `incarnation`, yet the wire payload carries one:
`recovery.rs:704-709` does `serde_json::to_value(...)` and then assigns
`reply["data"]["incarnation"]` by hand. `ptyClient.ts:348-349` rejects any
telemetry whose incarnation does not match. **Adding a field to the enum alone
is not enough** — confirm the injection site still round-trips.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/telemetry_tests.rs`:

```rust
#[test]
fn a_remote_session_never_borrows_the_local_machines_answers() {
    // The daemon's hostname, branch and agent describe the laptop. For a
    // session whose shell is on another machine they are not a fallback, they
    // are an answer to a different question.
    let fixture = Fixture::new();
    let pane = fixture.pane("shell", "remote");
    fixture.set_remote(&pane, RemoteEnrichment {
        host: Some("devbox".into()),
        ..Default::default()
    });
    let ServerMessage::Telemetry { remote, git_branch, .. } =
        metadata::telemetry(None, Some(pane.clone()), fixture.session(&pane), &fixture.usage)
    else { panic!("missing telemetry response") };
    let remote = remote.expect("a remote session must report its remote block");
    assert_eq!(remote.host.as_deref(), Some("devbox"));
    assert_eq!(remote.branch, None, "the remote did not report a branch");
    assert_eq!(git_branch, None, "the local branch must not stand in for it");
}
```

`Fixture` (`telemetry_tests.rs:1-156`) needs `set_remote` and `session`
accessors; add them beside the existing `context()` helper at `:116-128`.

- [ ] **Step 2: Run and watch it fail**

Run: `cargo test -p doom-term-server a_remote_session_never_borrows`
Expected: FAIL — no `remote` field on the variant.

- [ ] **Step 3: Implement**

`main.rs`, inside `Telemetry`:

```rust
        /// What the shell on the other end of the transport reported, or None
        /// for a local session.
        ///
        /// Presence of this block changes how every sibling field is read: a
        /// remote session's unreported branch is `--`, never the daemon's own.
        remote: Option<doom_term_pty::remote::RemoteEnrichment>,
```

`metadata.rs` — the session carries the last frame it received, and every local
computation is skipped when one is present:

```rust
    let remote = session.as_ref().and_then(|s| s.remote_enrichment());

    // The daemon's own machine, and only ever for a local session. Over SSH
    // these describe the laptop the window is on, which is not where the work
    // is happening.
    let (username, hostname) = match &remote {
        Some(r) => (
            r.user.clone().unwrap_or_else(|| "unknown".into()),
            r.host.clone().unwrap_or_else(|| "unknown".into()),
        ),
        None => (local_username(), local_hostname()),
    };

    let git_branch = match &remote {
        // A shell snippet reports its own branch or reports nothing. Running
        // `git -C` here would ask the laptop about a path on the server.
        Some(r) => r.branch.clone(),
        None => run_git_branch(&current_dir),
    };

    let agent = match &remote {
        Some(r) => r.agent.as_deref().and_then(pty::classify_agent),
        None => session.as_ref()
            .and_then(|s| s.foreground_command())
            .and_then(|comm| pty::classify_agent(&comm)),
    };
```

Context and rate stay `None` whenever `remote.is_some()`: the transcript files
and `/proc/<pid>/fd` attribution live on the other machine.

```rust
    let (context, agent_rate) = if remote.is_some() {
        // A shell snippet cannot read a transcript's token accounting, and the
        // fd that settles attribution is on the remote. Unknown is '--'.
        (None, None)
    } else {
        match agent.as_ref().map(|a| a.key) { /* ...unchanged... */ }
    };
```

- [ ] **Step 4: Confirm the hand-injection still round-trips**

`recovery.rs:704-709` serialises then assigns `reply["data"]["incarnation"]`.
Add an assertion in the same test that the serialised value carries both:

```rust
    let mut reply = serde_json::to_value(&message).unwrap();
    reply["data"]["incarnation"] = serde_json::json!("abc");
    assert!(reply["data"]["remote"]["host"] == "devbox");
    assert!(reply["data"]["incarnation"] == "abc");
```

- [ ] **Step 5: Run and watch it pass**

Run: `cargo test -p doom-term-server && cargo check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main.rs backend/src/metadata.rs backend/src/recovery.rs \
        backend/src/telemetry_tests.rs
git commit -m "feat(backend): telemetry reports the remote, and stops substituting the local

Every field was computed from the daemon's own machine unconditionally:
\$HOSTNAME, a local git -C against a remote path, and a /proc foreground that
over SSH is the ssh process itself. A remote session now reports what the
remote said and '--' for everything it did not.

Note the incarnation field is injected after serialization in recovery.rs and
is not on the enum; both are asserted here.

Telemetry tests are cfg(target_os = \"linux\") — this is Linux-only coverage."
```

---

## Stage 5 — The remote snippet, and a launch that carries it

**Files:**
- Modify: `crates/doom-term-pty/src/shell_integration.rs`
- Test: inline `mod tests` at `shell_integration.rs:302`

**Auto-injection into a running session is rejected** — see the spec. Writing a
snippet to a child's stdin types it into whatever that child is doing, and the
OSC 133 gate that would make it safe is circular. Delivery is by *launch*.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn the_remote_snippet_guards_against_double_bootstrapping() {
        let script = remote_enrichment_snippet();
        assert!(script.contains("DOOM_TERM_BOOTSTRAPPED"));
        assert!(script.contains("SetUserVar=doomterm="));
    }

    #[test]
    fn the_remote_snippet_is_a_single_line_safe_to_pass_as_an_ssh_command() {
        let script = remote_enrichment_snippet();
        assert!(!script.contains('\n'), "a multi-line snippet cannot ride an ssh argv");
    }

    #[test]
    fn a_remote_launch_carries_the_snippet_and_leaves_plain_ssh_alone() {
        let launch = ssh_launch("ssh", &["devbox".into()]);
        assert!(launch.args.iter().any(|a| a.contains("DOOM_TERM_BOOTSTRAPPED")));
        assert!(launch.args.contains(&"devbox".to_string()));
    }
```

- [ ] **Step 2: Run and watch them fail**

Run: `cargo test -p doom-term-pty remote_snippet`
Expected: FAIL — functions do not exist.

- [ ] **Step 3: Implement**

Add to `shell_integration.rs`, following the existing `ShellLaunch` shape
(`:230-233`) so the tmux path consumes it as data exactly as it already does:

```rust
/// What a remote shell runs once per prompt to report itself.
///
/// Deliberately cheap: a prompt hook that shells out to anything slow is a
/// prompt hook the user will remove. `git` is the one subprocess, and it is
/// bounded by `--no-optional-locks` so a busy repository cannot stall a prompt.
pub fn remote_enrichment_snippet() -> String {
    // One line, because this rides an ssh argv.
    concat!(
        "if [ -z \"$DOOM_TERM_BOOTSTRAPPED\" ]; then export DOOM_TERM_BOOTSTRAPPED=1; ",
        "__doom_remote() { ",
        "b=$(git --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null); ",
        "printf '{\"v\":1,\"host\":\"%s\",\"user\":\"%s\",\"shell\":\"%s\",\"cwd\":\"%s\",\"branch\":\"%s\"}' ",
        "\"$(hostname -s)\" \"$USER\" \"$(basename \"$SHELL\")\" \"$PWD\" \"$b\" ",
        "| base64 | tr -d '\\n' ",
        "| { read v; printf '\\033]1337;SetUserVar=doomterm=%s\\007' \"$v\"; }; }; ",
        "PROMPT_COMMAND=\"__doom_remote${PROMPT_COMMAND:+; $PROMPT_COMMAND}\"; fi"
    ).to_string()
}

/// An `ssh` invocation that instruments the far end at login.
///
/// kitty's model: the bootstrap rides the connection it is bootstrapping, so
/// the remote shell is instrumented by construction rather than by typing into
/// whatever happens to be running.
pub fn ssh_launch(ssh: &str, user_args: &[String]) -> ShellLaunch {
    let mut launch = ShellLaunch { args: Vec::new(), env: Vec::new() };
    if std::env::var("DOOM_TERM_NO_SHELL_INTEGRATION").is_ok() {
        launch.args.extend_from_slice(user_args);
        return launch;
    }
    let _ = ssh;
    launch.args.push("-t".to_string());
    launch.args.extend_from_slice(user_args);
    launch.args.push(format!(
        "{} ; exec \"$SHELL\" -l",
        remote_enrichment_snippet()
    ));
    launch
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `cargo test -p doom-term-pty && cargo check`
Expected: PASS.

- [ ] **Step 5: Verify against a real remote**

Run `npm run dev`, open a session, and connect with the generated form. Confirm
the plate's host changes to the remote's short hostname and **nothing prints on
screen** — the frame is an OSC record and Stage 1 keeps it off the display.

- [ ] **Step 6: Commit**

```bash
git add crates/doom-term-pty/src/shell_integration.rs
git commit -m "feat(pty): instrument a remote shell at login

The bootstrap rides the connection it bootstraps, kitty's model. Injecting
into an already-running session is deliberately not implemented: it types
into whatever the child is doing, and the OSC 133 prompt gate that would make
it safe only arrives once the remote is already instrumented."
```

---

## Stage 6 — The frontend merge rule

**Files:**
- Modify: `src/types/terminal.ts:134-168` — `SystemTelemetryData.remote`
- Modify: `src/hooks/usePtyEvents.ts:273-315`
- Test: `src/hooks/usePtyEvents.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('renders a field the remote did not report as unknown, never the local value', () => {
    const next = applyTelemetry(previous, {
      session_id: 's1', username: 'cml', hostname: 'laptop',
      current_dir: '/home/cml', git_branch: 'main', isolation: 'host',
      agent_key: null, agent_name: null,
      remote: { host: 'devbox', branch: null, agent: 'claude', busy: true },
    });
    expect(next.branch).toBe('');      // '' renders '--'; 'main' is the laptop's
    expect(next.agent).toBe('claude');
    expect(next.remoteHost).toBe('devbox');
  });

  it('leaves a local session exactly as it was', () => {
    const next = applyTelemetry(previous, {
      session_id: 's1', username: 'cml', hostname: 'laptop',
      current_dir: '/home/cml', git_branch: 'main', isolation: 'host',
      agent_key: 'codex', agent_name: 'CODEX', remote: null,
    });
    expect(next.branch).toBe('main');
    expect(next.remoteHost).toBeUndefined();
  });
```

`applyTelemetry` is extracted as a pure function from the handler body at
`usePtyEvents.ts:295-313`, exported so it tests without a socket.
`src/test/setup.ts` already replaces `globalThis.WebSocket` with a stub that
throws on `send()`, so this must not reach one.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/hooks/usePtyEvents.test.ts`
Expected: FAIL — `applyTelemetry` is not exported.

- [ ] **Step 3: Implement**

Extract the handler body at `usePtyEvents.ts:295-313` into an exported pure
function, and add `remoteHost?: string` to `AppTelemetry` in `src/hud/state.ts`:

```ts
/**
 * One telemetry frame applied to the app's view of a session.
 *
 * Pure and exported so the merge rule tests without a socket: `src/test/setup.ts`
 * replaces `globalThis.WebSocket` with a stub that throws on `send()`, so
 * anything that reaches one fails loudly rather than passing quietly.
 *
 * THE RULE, and the whole point of this stage: when `remote` is present every
 * field reads from it, and a field the remote did not report is unknown. The
 * local value is not a degraded version of the remote answer — it is an answer
 * about a different computer, and Axiom 3 has no category for "true of
 * something else".
 */
export function applyTelemetry(previous: AppTelemetry, data: SystemTelemetryData): AppTelemetry {
  const remote = data.remote ?? null;
  return {
    ...previous,
    sessionId: data.session_id ?? undefined,
    cwd: remote ? (remote.cwd ?? '') : data.current_dir,
    // A directory that is not a repository has no branch, and neither does a
    // remote that did not report one. Do not invent either.
    branch: remote ? (remote.branch ?? '') : (data.git_branch ?? ''),
    isolation: data.isolation,
    agent: (remote ? remote.agent : data.agent_key) ?? 'shell',
    agentName: (remote ? remote.agent?.toUpperCase() : data.agent_name) ?? undefined,
    remoteHost: remote?.host ?? undefined,
    // Context, rate and model are transcript-derived, and the transcript is on
    // the machine the agent runs on. Across a transport they are unknown.
    rateUsed: remote ? undefined : (data.rate_used ?? undefined),
    contextUsed: remote ? undefined : (data.context_used ?? undefined),
    model: remote ? undefined : (data.agent_model ?? undefined),
    agentBusy: remote ? (remote.busy ?? previous.agentBusy) : previous.agentBusy,
  };
}
```

The handler at `:273` then becomes `setTelemetry((prev) => applyTelemetry(prev, data))`,
leaving the `setWorkspace` block above it (`:278-294`) unchanged.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/types/terminal.ts src/hooks/usePtyEvents.ts src/hooks/usePtyEvents.test.ts
git commit -m "fix(ui): a remote session never falls back to the local machine's answers"
```

---

## Stage 7 — The ENV cell names the remote *(moves the HUD baseline)*

**Files:**
- Modify: `src/hud/state.ts:90,115-134`
- Modify: `src/hud/plate.js:822-824`
- Regenerate: `docs/design/reference/plate-480@1x.png`, `@4x.png`
- Test: `src/hud/*.test.js` (runner: `node --test`, not vitest)

- [ ] **Step 1: Write the failing test**

`src/hud/state.test.js` — note this file is `.js` and runs under
`node --test "src/**/*.test.js"`, **not** vitest:

```js
test('a remote session names the remote in the ENV cell', () => {
  const state = toPlateState({ isolation: 'host', remoteHost: 'devbox' });
  assert.equal(state.modeIndicator, '@devbox');
  assert.equal(state.modeLabel, 'ENV');
});

test('a local session is unchanged', () => {
  assert.equal(toPlateState({ isolation: 'host' }).modeIndicator, 'HOST');
  assert.equal(toPlateState({ isolation: 'worktree' }).modeIndicator, 'TREE');
});

test('a remote that did not name itself is unknown, not HOST', () => {
  // HOST here would mean "the local host", which is the bug.
  assert.equal(toPlateState({ isolation: undefined, remote: true }).modeIndicator, '--');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test src/hud/state.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`state.ts:117` — the remote host displaces the isolation word, left-truncated
the way `branch` already is at `:141`:

```ts
  let modeText = app.isolation ? ENVIRONMENT[app.isolation] : '--';
  if (app.remoteHost) modeText = truncateLeft(`@${app.remoteHost}`.toUpperCase(), 8);
```

- [ ] **Step 4: Run and watch it pass**

Run: `node --test src/hud/state.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm the baseline fails, then move it deliberately**

Run: `npm run hud:check`
Expected: **FAIL** if and only if a rendered plate changed. The reference render
uses `DEFAULT_STATE`, which has no `remoteHost`, so a correct implementation
leaves it at 0 mismatched pixels. **If `hud:check` still passes, that is the
right outcome** — do not regenerate.

Only if it genuinely fails:
```bash
npm run hud:ref
git diff --stat docs/design/reference/
```
Review the diff image at `.artifacts/plate-diff.png` by eye before accepting.
Magenta marks every changed pixel; anything outside the ENV cell is a bug in
this stage, not a baseline that needs moving.

- [ ] **Step 6: Full gate**

Run: `npm run agent:verify`
Expected: every step passes.

- [ ] **Step 7: Commit**

```bash
git add src/hud/state.ts src/hud/plate.js src/hud/state.test.js docs/design/reference/
git commit -m "feat(hud): the ENV cell names the remote, not the local host

It read HOST for every SSH session, which was true of the laptop and useless
about the machine the work was on."
```

---

## Stage 8 — Reaching it: the palette action and the manual route

**Files:**
- Modify: `src/core/paletteActions.ts:13-75` (context), `:76` (`buildPaletteActions`)
- Modify: `tools/agent-hooks/install.mjs`
- Create: `tools/agent-hooks/doom-term-remote.sh`
- Test: `src/core/paletteActions.test.ts`, `tools/agent-hooks/install.test.mjs`

The spec promises two ways to reach the channel and Stages 1-7 build neither:
a launch the user can invoke, and a route for a remote they are already sitting
on. Without this stage `ssh_launch` has no caller.

- [ ] **Step 1: Write the failing palette test**

```ts
  it('offers a remote connection action', () => {
    const actions = buildPaletteActions(ctx);
    const connect = actions.find((a) => a.id === 'session.connect-remote');
    expect(connect).toBeDefined();
    expect(connect!.category).toBe('Session');
  });

  it('does not offer it when there is no group to open it in', () => {
    const actions = buildPaletteActions({ ...ctx, activeGroup: undefined as never });
    expect(actions.find((a) => a.id === 'session.connect-remote')).toBeUndefined();
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/core/paletteActions.test.ts -t 'remote connection'`
Expected: FAIL — no such action.

- [ ] **Step 3: Implement the action**

`PaletteContext` gains one callback beside the existing `onCreateNode`:

```ts
  /** Open a session that instruments the far end at login. */
  onConnectRemote?: (destination: string) => void;
```

and `buildPaletteActions` gains the entry:

```ts
  if (ctx.activeGroup && ctx.onConnectRemote) {
    actions.push({
      id: 'session.connect-remote',
      category: 'Session',
      title: 'Connect to remote host…',
      run: () => ctx.onConnectRemote!(''),
    });
  }
```

`App.tsx` wires it to a session spawned through the Rust `ssh_launch` form.
The destination is typed by the user; **it is never guessed from history**, and
an empty destination opens the prompt rather than connecting to anything.

- [ ] **Step 4: Write the failing installer test**

```js
test('the remote snippet installs additively and uninstalls cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doom-remote-'));
  await writeFile(join(root, '.bashrc'), '# my own config\nexport EDITOR=vi\n');

  runInstaller({ root, remote: true });
  const after = await readFile(join(root, '.bashrc'), 'utf8');
  assert.ok(after.includes('# my own config'), 'the user\'s own config was disturbed');
  assert.ok(after.includes('doom-term-hook'), 'the entry is not tagged');
  assert.ok(after.includes('DOOM_TERM_BOOTSTRAPPED'));

  // Idempotent: a second install must not append a second copy.
  runInstaller({ root, remote: true });
  const twice = await readFile(join(root, '.bashrc'), 'utf8');
  assert.equal(
    twice.split('DOOM_TERM_BOOTSTRAPPED').length,
    after.split('DOOM_TERM_BOOTSTRAPPED').length,
  );

  runInstaller({ root, remote: true, remove: true });
  const removed = await readFile(join(root, '.bashrc'), 'utf8');
  assert.ok(removed.includes('# my own config'));
  assert.ok(!removed.includes('DOOM_TERM_BOOTSTRAPPED'));
});
```

- [ ] **Step 5: Run and watch it fail**

Run: `node --test tools/agent-hooks/install.test.mjs`
Expected: FAIL — `runInstaller` takes no `remote` option.

- [ ] **Step 6: Implement**

`runInstaller` (`install.mjs:205`) gains `remote = false`. When set, it patches
`~/.bashrc` and `~/.zshrc` rather than the agent hook configs, using the same
`MARKER` (`'doom-term-hook'`, `:31`), the same `backupOnce` (`:96`) and the same
`atomicWrite` (`:124`) the JSON path already uses — one tagging convention, not
two. The snippet body is `doom-term-remote.sh`, generated to match
`remote_enrichment_snippet()` from Stage 5.

**Keep the two in sync by construction:** add a test asserting the shipped
`.sh` and the Rust string agree, or the remote will emit a frame this build
cannot parse.

```js
test('the shipped snippet matches the one the daemon generates', async () => {
  const shipped = await readFile('tools/agent-hooks/doom-term-remote.sh', 'utf8');
  assert.ok(shipped.includes('SetUserVar=doomterm='));
  assert.ok(shipped.includes('DOOM_TERM_BOOTSTRAPPED'));
  assert.ok(shipped.includes('"v":1'), 'schema version drifted from remote.rs');
});
```

- [ ] **Step 7: Run and watch them pass**

Run: `node --test tools/agent-hooks/install.test.mjs && npx vitest run src/core/paletteActions.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/paletteActions.ts src/core/paletteActions.test.ts src/App.tsx \
        tools/agent-hooks/install.mjs tools/agent-hooks/doom-term-remote.sh \
        tools/agent-hooks/install.test.mjs
git commit -m "feat(remote): a way to reach the channel

ssh_launch had no caller. A palette action opens an instrumented session, and
the installer gains a --remote mode for a host you are already on — same
doom-term-hook tagging, same backup and atomic write as the agent hooks, so
one uninstall convention covers both."
```

---

## Verification summary

| Stage | Command | Expected |
| :--- | :--- | :--- |
| 1 | `cargo test -p doom-term-pty` | PASS; Warp's frame never reaches the renderer |
| 2 | `cargo test -p doom-term-pty` + manual agent repro | PASS; repro outcome written into the spec |
| 3 | `cargo test -p doom-term-pty remote::` | PASS, 6 tests |
| 4 | `cargo test -p doom-term-server && cargo check` | PASS (Linux only) |
| 5 | `cargo test -p doom-term-pty` + manual remote | PASS; nothing prints on connect |
| 6 | `npx vitest run && npm run typecheck` | clean |
| 7 | `npm run agent:verify` | all pass; HUD baseline moved only if genuinely changed |
| 8 | `node --test tools/agent-hooks/install.test.mjs && npx vitest run src/core/paletteActions.test.ts` | PASS |
