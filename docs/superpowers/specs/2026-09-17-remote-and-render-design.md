# Remote Awareness and Render Integrity: Design

**Status**: Design, 2026-09-17
**Branch**: `feat/remote-enhancement`
**Execution plans**: written after this document is approved — one per track,
`../plans/2026-09-17-render-pipeline.md`, `../plans/2026-09-17-remote-awareness.md`,
`../plans/2026-09-17-window-chrome.md`.

---

## The question

Every defect in this document was observed in one configuration: a **Windows
build of Doom Term, SSH'd into a Linux development machine**. That is not an
incidental detail. It is the configuration the product has never been built for,
and it is where the architecture's one unexamined assumption becomes visible.

The assumption is this: **the machine the daemon runs on is the machine the work
happens on.** Every enrichment field, every process witness, and every
transcript read is written against it. Over SSH it is false, and the code does
not know that it is false — so it answers about the wrong machine with the same
confidence it answers about the right one.

Nine observations. Two of them — the wrong host and the missing remote
enrichment — are one bug seen from two sides, and four more reduce to two roots
in the render pipeline. This document decides what to build, on what evidence,
and what must keep reading `--`.

---

## What is actually true today

Seven findings, read out of the code rather than out of the architecture.
Track A, B and C below refer back to them by number.

### Finding 1. Enrichment is computed from the daemon's own machine, unconditionally

`backend/src/metadata.rs:11-142` is the whole of it. Every field:

```rust
let hostname = std::env::var("HOSTNAME")
    .or_else(|_| std::env::var("COMPUTERNAME"))
    .unwrap_or_else(|_| "localhost".to_string());
```

That is the **Windows box's** hostname, reported for a session whose shell is on
a Linux server. `git_branch` runs `git -C <current_dir>` as a local subprocess
against a path that exists only on the remote. `agent` comes from
`session.foreground_command()`, which over SSH is literally the `ssh` process —
`classify_agent` returns `None` for it, so the agent well goes dark while Claude
Code runs three feet away. `context` and `rate_used` read transcript files under
the local `$HOME`.

The ENV indicator is the same bug wearing a different hat.
`foreground.rs:92 detect_isolation()` inspects the local filesystem for
container markers, finds none, and returns `"host"` — which `hud/state.ts:90`
renders as `HOST`. It is not wrong about the local machine. It is answering a
question nobody asked.

**There is no string `ssh` anywhere in `src/`, `crates/`, or `backend/src/`.**
This is not a broken remote implementation. There has never been one.

### Finding 2. The demuxer models OSC and CSI, and nothing else

`crates/doom-term-pty/src/demuxer.rs:275-303`:

```rust
if self.in_esc {
    self.in_esc = false;
    if b == b']' { /* in_osc = true */ }
    if b == b'[' { /* in_csi = true */ }
    // Some other ESC sequence — hand it to the renderer intact.
    if b == b'c' { events.push(DemuxEvent::BracketedPasteMode { enabled: false }); }
    output_chunk.push(0x1b);
    output_chunk.push(b);
```

`ESC P` — DCS, the Device Control String introducer — reaches that catch-all. The
introducer is emitted as text and the state machine returns to ground, so
**every byte of the payload is printed as ordinary output.**

This is what the remote machine's existing Warp bootstrap produces on screen —
the ninth observation, reported verbatim:

```
$f{"hook": "SourcedRcFileForWarp", "value": { "shell": "bash", "uname": "Linux" }}
```

Warp's rc snippet emits `ESC P $f{…} ST`. We print from `$f` onward, character
for character. `ESC _` (APC), `ESC ^` (PM) and `ESC X` (SOS) have the same hole.

It compounds. Warp terminates with the 8-bit ST `\x9c`, and `take_output`
(`demuxer.rs:57`) runs `String::from_utf8_lossy` over the accumulated chunk.
Raw C1 bytes `0x80..=0x9f` are not valid UTF-8, so the terminator is replaced
with U+FFFD before `@xterm/headless` could resynchronise on it. The demuxer
cannot see 8-bit control introducers either, for the same reason.

This is a **prerequisite** for everything in Track B, not a side quest. An
in-band enrichment channel travels this exact path.

### Finding 3. The viewport is pinned by pixel offset, and the follow effect always wins

`RawTerminalView.tsx:375-404` re-runs on every `lines` change and, unless the
reader is detached or a gesture is in flight, executes `el.scrollTop =
el.scrollHeight`. Around it sits a 400ms gesture window (`SCROLL_INTENT_MS`,
line 69), a `leaveTail()` wheel pre-empt (line 354), and hand-rolled trim
compensation that multiplies a measured row height by a trimmed-row count.

Each of those is a correction for the same underlying choice: the reader's
position is stored as a **pixel**, and pixels do not survive a buffer whose rows
are being deleted from the top while new ones arrive at the bottom. Over SSH
output arrives in bursts, which widens every window in which the effect fires
against a reader mid-gesture. That is the "sticky bottom".

There is no smooth scrolling of any kind. `grep -rn "scroll-behavior\|scrollBehavior"
src/` returns one unrelated `scrollIntoView` in `CommandPalette.tsx:121`.

### Finding 4. Row identity is not stable, and the whole buffer is in the DOM

`core/xtermLines.ts:173` mints the React key, and the doc comment twelve lines
above it concedes the defect:

```
 * The id is the absolute buffer line. It shifts by one each time scrollback
 * trims, which costs a re-render of the rows below; a monotonic id would need a
 * line-creation event xterm does not expose.
```

"Costs a re-render" understates it. React keys on `row-${y}`. After a trim, key
`row-4` names what `row-5` named a frame ago, so React re-associates DOM nodes
with different content across the entire list — and it does this for every trim,
forever, once scrollback is full at 5000 lines (`xtermScreen.ts:9`).

`RawTerminalView.tsx:762` renders `lines.map(...)` — **all of them**. There is no
virtualization. A keystroke at the bottom of a full buffer reconciles 5000
elements before its echo can paint.

#### The trim compensation never runs

Worse than the comment admits, and only visible once the producers are traced.
`XtermScreen.getLines()` (`xtermScreen.ts:266`) is the sole production source of
the `lines` prop — `usePtyEvents.ts:236` calls it, the value lands on
`node.tuiLines`, and `App.tsx:520` and `:530` pass it in. It always calls
`linesFrom(buffer, 0, ...)`, so **`lines[0].row` is always 0**. The sibling
method that would yield a non-zero first row, `linesSince(mark)`
(`xtermScreen.ts:301`), has no production caller anywhere in `src/`.

So in the follow effect, `firstRow` is 0, `previousFirstRow` is 0, `trimmed` is
`0 - 0`, and `if (trimmed > 0 ...)` is never true. The roughly sixty lines of
trim compensation at `RawTerminalView.tsx:385-396` are **unreachable in the
running application.** They pass their unit test only because
`RawTerminalView.test.tsx:214-245` hand-feeds `row(2), row(3), row(4)` — a shape
`getLines()` cannot produce.

This is the most direct explanation of the reported jumbled history. A detached
reader receives no compensation at all, so once the 5000-line buffer is full
(`xtermScreen.ts:9`) and an agent keeps writing, the text under them crawls
away — precisely the failure that code was written to prevent, by a correction
that has never once executed.

### Finding 5. Refused input is silently swallowed

`core/sessionAttachment.ts:277-282`:

```ts
mutate(action: string, payload: Record<string, unknown>, ready = true): boolean {
  if (!ready && action !== 'Kill' && action !== 'StreamApplied') return false;
  const identity = this.mutationIdentity(ready);
  if (!identity) return false;
```

`mutationIdentity` returns `null` whenever `status !== 'ready'`. So
`ptyClient.writeToSession` returns `false` and the bytes are dropped — while
`RawTerminalView.handleKeyDown:673` calls `e.preventDefault()` unconditionally
and discards the return value. A keystroke typed before the attachment settles
does not reach the child and leaves no trace that it did not.

### Finding 6. `CSI 6n` is answered with a fabricated cursor position

`demuxer.rs:123-126`:

```rust
// Device Status Report. The demuxer does not model a cursor, so it
// reports the origin: an approximate answer costs a repaint,
// silence costs five seconds.
"6n" => Some("\x1b[1;1R"),
```

The comment is honest about what it is doing and wrong about what it costs. This
is a **fabricated measurement returned to a program that asked for a real one** —
Axiom 3 at the source, in the one place where the consequence is not a dash on a
plate but an agent computing its composer geometry from a lie.

It is the leading hypothesis for the sticky first character (see Track A3), and
it should be fixed on its own merits whether or not the reproduction
implicates it.

### Finding 7. The agents bar contradicts the plate about what colour an agent is

`components/AgentQueueIndicator.tsx:67-78` carries a private colour table:

```ts
const AGENT_COLORS: Record<string, string> = {
  claude: '#e08a63',
  codex: '#e6e6e6',
  ...
```

`hud/plate.js:122` carries another one, and `plate.js:111-116` states that the
canonical list is keyed to `foreground.rs classify_agent`. Two tables, two sets
of values, one vendor. The component also renders hand-drawn SVG paths where the
plate has nine canonical bitmap `MARKS`, floats itself over the terminal with
`absolute top-2 right-4` (line 97), and mixes a `1px solid` border with `--bevel-up`.

---

## The two shared roots

Before the tracks, the two changes that most of Track A reduces to.

### Root A — the viewport anchors on a row, not a pixel

`xtermLines.ts` already puts an absolute buffer row on every line — `row`, set
by `lineToAnsi` and carried through `linesFrom`. Make that the anchor.

```
follow mode  →  anchor = TAIL
detached     →  anchor = { row: N, offsetPx: k }
```

Trim compensation disappears entirely: row N is still row N after the rows above
it are deleted. `SCROLL_INTENT_MS`, `gesturing()`, `noteGesture()`, the
`sessionScrollPositions` pixel map and the `firstRowRef` bookkeeping all go with
it — roughly 60 lines of correction that exist only to defend a pixel.

New module `src/core/viewportAnchor.ts`, pure and DOM-free, so every transition
is testable without a browser.

### Root B — line ids are monotonic, and only the visible window is in the DOM

xterm exposes no line-creation event, but it does not need to: the trimmed-row
count is already computed in the follow effect. Move that accounting into
`XtermScreen`, where it belongs, and mint

```ts
id = `L${trimmedTotal + y}`
```

which is monotonic for the life of the session. React then re-renders a row when
its *content* changes and never because the buffer moved underneath it.

With stable ids, virtualization is safe. New module `src/core/rowWindow.ts`:
`(anchor, viewportRows, overscan, total) → { start, end, padTopPx, padBottomPx }`,
rendered as two spacer divs around the slice.

**Known consequence, stated rather than discovered later:** native browser
find-in-page and cross-buffer text selection stop covering rows outside the
window. `Ctrl+Shift+F` already owns search (`keymap.ts`), and `turnText()`
operates on the `lines` array rather than the DOM — but
`RawTerminalView.handleMouseDown:688-702` resolves `commandRegion` boundaries
by `querySelector` (lines 696-697), and must be changed to compute the range
from the array and scroll the endpoints into the window before selecting.

---

## Track A — render and input

### A1 · Smooth scroll

The anchor from Root A makes "smooth" a rendering question rather than a
scroll-position question. A wheel event accumulates into a **target** anchor; an
rAF loop eases the current anchor toward it with an exponential time constant of
~120ms and settles exactly, never asymptotically.

- `overscroll-behavior: contain` on the grid, so a gesture at the tail does not
  bounce the window.
- `prefers-reduced-motion: reduce` collapses the easing to an immediate set. The
  anchor model is unchanged; only the interpolation is skipped.
- `overflowAnchor: 'none'` stays. The browser's scroll anchoring heuristic is
  still the wrong tool for a buffer that knows exactly what it trimmed.

### A2 · Input latency

Two independent costs, addressed separately.

**The local cost** is Root B. Virtualizing the row list removes a 5000-element
reconcile from the path between a keystroke and its echo. This is not
speculative and helps on localhost too.

**The remote cost** is the round trip, and the only thing that touches it is
prediction. Adopt VS Code's rules, which are the ones with a decade of field
evidence behind them:

| | |
|---|---|
| Engage | measured RTT > 30ms (`localEchoLatencyThreshold`'s default) |
| Disengage | alt-screen active; foreground is `vim`/`vi`/`nano`/`tmux`; RTT recovers |
| Predict | printable ASCII at the cursor, and backspace over a predicted cell |
| Never predict | control bytes, arrows, anything while a paste is in flight |
| Roll back | any disagreement between predicted and confirmed output drops **all** predictions for that session at once |

New module `src/core/localEcho.ts`, pure: `(pending, confirmedOutput) → kept |
rolled-back`. RTT is measured by timestamping writes and matching the next
arriving output frame, and is reported as `--` until enough samples exist.

**Axiom 1 is untouched.** Prediction is a *display* layer. `keyToBytes` still
sends the child exactly what it sent before, byte for byte; nothing is
swallowed, reordered, or synthesised on the wire.

**On Axiom 3.** Painting an unconfirmed character is inventing screen state, and
that deserves an explicit answer rather than a shrug. The answer is that a
prediction is rendered in `--st-idle` (`#847c6e`) — one of the five canonical
state colours, already WCAG-AA guaranteed against `--ground` by
`src/styles/material.test.js`, and already meaning *not settled*. A predicted
cell is visibly not a confirmed cell, in the vocabulary the plate already uses
for exactly this. That is a stated uncertainty, which is what Axiom 3 asks for.
It is not a new material, and it needs no new colour.

### A3 · The sticky first character

**This is the one item this document does not claim to have solved.** It has two
live hypotheses and a reproduction requirement, and the implementation plan must
reproduce before it fixes.

*Hypothesis 1 — the keystroke never left.* Per finding 5, input typed before
the attachment reports `ready` is dropped while `preventDefault()` runs anyway.
This explains a **missing** first character cleanly. It explains a *stuck* one
only if the shell echoed it before the agent took the terminal.

*Hypothesis 2 — the agent's geometry is built on a fabricated DSR.* Per
finding 6, an agent that probes `CSI 6n` during startup is told `1;1R`
regardless of where the cursor is. An agent that positions its composer relative
to that answer will erase relative to it too, and the cell it believes it is
clearing is not the cell the character is in. This explains a character that
renders, survives backspace, and sits at the *start* of the composer — which is
the reported symptom precisely.

**Fixes, which are worth making independently of which hypothesis wins:**

1. `onWrite` returns whether the write was accepted. `handleKeyDown` calls
   `preventDefault()` only on acceptance, and a refusal raises the existing
   transient notice. Refused input is reported as refused. No queue, no replay —
   the same discipline the paste contract already sets out in `CLAUDE.md`.
2. `CSI 6n` stops being answered from the demuxer, which has no cursor to
   report. `5n` (health) and `c`/`>c` (device attributes) are genuinely static
   and stay where they are. DSR 6 routes to the session's `XtermScreen`, which
   is the only component in the system that knows the answer.

### A4 · Scrollback integrity

Root B's monotonic ids, plus B0's control-string handling — an unterminated DCS
today does not merely print one stray line, it leaves the *renderer* parsing a
payload as text. Both failure modes present as "jumbled history".

---

## Track B — remote awareness

### B0 · Control strings are consumed, never printed

Add a string-state to the demuxer alongside `in_osc` and `in_csi`:

| Introducer | 7-bit | 8-bit |
|---|---|---|
| DCS | `ESC P` | `0x90` |
| SOS | `ESC X` | `0x98` |
| PM  | `ESC ^` | `0x9e` |
| APC | `ESC _` | `0x9f` |

Terminated by ST (`ESC \` or `0x9c`) or, leniently, BEL. Bounded by
`MAX_CONTROL_LEN` (= `stream::MAX_RECORD_BYTES`) with the same `control_fault`
as OSC.

**The 8-bit introducers are declined, and that correction came from the code.**
This document first claimed they should be recognised in the byte loop ahead of
the UTF-8 splice. They cannot be: `0x80..=0xbf` is the UTF-8 *continuation*
range and the C1 introducers live inside it, so `0x9f` is both the APC
introducer and the second byte of every four-byte emoji — U+1F389 is
`f0 9f 8e 89`. Implementing the original claim ate emoji, and
`a_four_byte_emoji_survives_a_split_at_every_interior_offset` caught it on the
first run. xterm declines them in UTF-8 mode for exactly this reason.

The 8-bit **terminator** is a different question and is honoured, but only
inside an open string, where the body is opaque bytes rather than decoded text.
That is the ST Warp's bootstrap actually emits.

Nothing inside a string sequence reaches the renderer. Foreign vendor hooks —
Warp's `SourcedRcFileForWarp` and `InitSubshell`, iTerm2's — are swallowed in
silence rather than parsed; we are not a Warp client and must not behave like
one. Sixel is not a regression risk: `@xterm/headless` has no renderer and
`addon-image` is not loaded.

### B1 · The enrichment channel

**Delivery.** kitty's `kitten ssh` model: the bootstrap rides the connection it
is bootstrapping. A palette action and a `doom-ssh` shim launch `ssh` with the
snippet attached, so the remote shell is instrumented at login, by construction,
before anything else runs. Guarded by `$DOOM_TERM_BOOTSTRAPPED` exactly as Warp
guards `$WARP_BOOTSTRAPPED`, so a nested session does not re-bootstrap.

**Auto-injection into a running session is explicitly rejected.** It is the
obvious feature and it is unsafe: writing a snippet to a child's stdin types it
into whatever is running, which may be a pager, an editor, or an agent's
composer. The tempting gate — "only inject at an OSC 133 prompt mark" — is
circular, because OSC 133 only arrives once the remote is already instrumented.
Users who want an already-running remote enriched install the snippet in their
own rc file (Warp's documented model), additively and reversibly, through the
same idempotent tagging `tools/agent-hooks/install.mjs` already uses.

**Payload.** iTerm2's `SetUserVar`, not a private sequence:

```
OSC 1337 ; SetUserVar = doomterm = <base64(json)> ST
```

Emitted once per prompt from a precmd hook, alongside the OSC 133 and OSC 7
sequences `shell_integration.rs` already generates. Choosing iTerm2's documented
mechanism over a private OSC number means the same rc snippet is harmless in
iTerm2, WezTerm and kitty — it sets a variable they ignore — rather than
printing garbage in every terminal that is not ours.

Schema, versioned, every field optional:

```json
{ "v": 1, "host": "devbox", "user": "cml", "shell": "bash",
  "cwd": "/home/cml/src/app", "branch": "main",
  "agent": "claude", "busy": true }
```

A malformed or oversized frame is discarded whole. There is no partial apply.

### B2 · ENV and host identity

`ServerMessage::Telemetry` gains `remote: Option<RemoteEnrichment>`, and the
merge rule is the entire point:

> When a session is remote, a field the remote did not report renders `--`. It
> **never** falls back to the local value.

That rule is what fixes finding 1. The local answer is not a degraded
version of the remote answer; it is an answer about a different computer, and
Axiom 3 has no category for "true of something else".

The ENV cell gains a remote form. Isolation still reads `CTNR`/`TREE`/`HOST`
when the remote reports it — describing the *remote* — and the host identity is
drawn `@devbox`, left-truncated the way `branch` already is through
`truncateLeft(..., PLATE_480.valueChars)`. One ASCII character of prefix, no new
glyph, no new material.

`context` and `rate_used` stay `--` over SSH. A shell snippet cannot read a
transcript's token accounting, and `backend/src/usage/` resolves attribution
from `/proc/<pid>/fd` on the machine the agent runs on. Inventing a number here
would be the exact failure `CLAUDE.md` names. A helper binary could supply them
honestly; that is a later decision, out of scope for this spec.

---

## Track C — window chrome

### C1 · The top bar

`decorations: false` in `src-tauri/tauri.conf.json`, replaced by a 28px plate
strip. One horizontal bar carrying, left to right: **agent marks**, the title as
a `data-tauri-drag-region`, and `−` `□` `×` as Unicode glyphs.

The Windows trap, named so it is not rediscovered: Tauri v2 with
`decorations: false` loses window resize even when `resizable: true`
([tauri-apps/tauri#8519](https://github.com/tauri-apps/tauri/issues/8519)).
`tauri-plugin-decorum` is the resolution — it keeps Snap Layouts and the resize
borders while allowing a custom strip — and it requires `withGlobalTauri: true`
plus a `decorum:allow-show-snap-overlay` capability. It is a window plugin, not
an icon library; `CLAUDE.md`'s prohibition is unaffected.

**Focus is not the bar's to take.** Axiom 1 means the terminal keeps the
keyboard: every control carries `tabIndex={-1}` and cancels `mousedown`, so a
click closes a window without ever moving focus out of the pane.

### C2 · Agent marks

The marks move into the strip and lose their label — no `AGENTS:` text, per the
original request. `AgentQueueIndicator.tsx` is deleted and replaced by a
titlebar region that renders the plate's own nine `MARKS` through a shared
`agentMark(key)` extracted from `hud/plate.js`. The duplicate `AGENT_COLORS`
table goes with it, along with the hand-drawn SVGs, `animate-pulse`,
`transition-all`, `ring-2`, and the `1px solid` border layered over `--bevel-up`.

One agent, one mark, one colour, sourced from the table that
`foreground.rs classify_agent` is keyed to.

### On Axiom 2

> *The Status Plate is the Only Persistent Chrome.*

A titlebar is persistent chrome, and this document amends the axiom rather than
pretending otherwise. The amended form:

> The Status Plate is the only persistent **application** chrome. Window
> management — drag, minimise, maximise, close, and the identity of the agents
> running in the window — lives in a top bar that renders in the same four
> materials. There are still no tab strips, no sidebars, and no floating
> toolbars.

The change is defensible on its own terms: the strip replaces an OS titlebar
that was already persistent and already outside the design system, and it
*removes* the floating `AgentQueueIndicator`, which violated the axiom without
ever being granted an exception.

---

## Verification

`npm run agent:verify` gates everything, as always. New coverage:

| Suite | Proves |
|---|---|
| `core/viewportAnchor.test.ts` | tail↔row transitions; anchor survives a trim burst; reduced-motion path |
| `core/rowWindow.test.ts` | window arithmetic at buffer edges; padding sums to total height |
| `core/localEcho.test.ts` | engage/disengage thresholds; rollback drops every prediction; never predicts a control byte |
| `core/xtermLines.test.ts` | ids are monotonic across trims; unchanged rows keep identity |
| `demuxer.rs` | DCS/APC/PM/SOS consumed to ST and BEL; 8-bit introducers; 8-bit ST survives the UTF-8 splice; **Warp's exact `$f{…}` frame never reaches the renderer** |
| `remote.rs` | frame parse, version rejection, oversize rejection, no partial apply |
| `metadata.rs` | a remote session with no reported branch renders `--`, not the local branch |
| `TitleBar.test.tsx` | controls never take focus from the pane; zero radius; bevel pair only |

**The HUD reference will move.** The ENV cell changes shape for remote sessions,
so `npm run hud:check` fails until `npm run hud:ref` regenerates
`docs/design/reference/plate-480@1x.png` and `@4x.png`. That regeneration is a
reviewable step in the plan, not a silent side effect — the check fails closed
by design and must be seen to fail before the baseline moves.

---

## The `--` ledger

What this design deliberately leaves unknown, and why:

| Reading | Over SSH | Why |
|---|---|---|
| `CONTEXT %` | `--` | needs transcript bytes on the remote; a shell snippet cannot read them |
| `USAGE %` | `--` | same |
| `BRANCH` | remote's, or `--` | never the local repository's |
| `ENV` | remote's, or `--` | never `HOST` meaning the local host |
| Agent | remote's, or `--` | `ssh` is a transport, not an agent; `classify_agent` is not widened to admit it |
| RTT | `--` until sampled | local echo stays disengaged until it has a measurement |

---

## Out of scope

- **A remote helper binary.** Wave Terminal's `wsh` model would supply context
  and usage honestly. It also means per-architecture release binaries, write
  access to the remote `$HOME`, version skew, and a second authentication
  surface. It is a coherent phase 2 and it is not this document.
- **Doom Term managing SSH connections itself.** A built-in client would know
  host identity structurally, and would replace a working transport with one we
  maintain.
- **Parsing foreign vendor hooks.** B0 swallows Warp's frames. It does not read
  them. We are not a Warp client.
- **Unrelated refactoring** of `RawTerminalView.tsx`, which is 840 lines and
  will shed roughly 60 to Root A. Further decomposition is a separate concern.
