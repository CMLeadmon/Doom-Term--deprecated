# Beta readiness audit

Audit started from origin/main `ec22a2a` on 2026-09-06; continued through 2026-09-09.
This is a working evidence ledger, not a release certification.

## Current verdict

Not ready to depend on as a primary work terminal yet. The basic shell, layout,
and command palette work, and the repository has substantial regression coverage.
However, reconnect history fidelity, telemetry attribution, native notification
routing, and several security and verification gaps need more work.

## Confirmed repairs in this audit

- The daemon rejects foreign/opaque browser origins and unexpected WebSocket
  Host headers, handles fragmented upgrades, and rejects browser hook POSTs.
  Configured `DOOM_AUTH_TOKEN` now gates commands and retained hook delivery.
  The frontend authenticates before binding sessions, with a transient token
  input when required. Tokens remain in window memory, never local storage.
- Remote binds are refused. This is a local terminal protocol without TLS.
  Native local clients without Origin remain trusted when no token is configured;
  use an access token on machines with other untrusted local users.
- Reconnect binds all explicitly bound panes, including background and parked
  panes. Process-exit callbacks move to the new connection with output callbacks.
- PTY and agent events update the owning workspace. Late telemetry updates its
  own session metadata without overwriting the foreground workspace's HUD.
- Saved YOLO preferences no longer type Enter into a potentially different
  process. Automatic approval is visibly unavailable because the existing hook
  protocol does not identify a verifiable prompt or approval response. Optional
  review banners open the agent terminal and do not fabricate approval success.
- Sound and notification controls share application state. The browser notification
  chip reflects permission as well as the saved preference.
- Worktree creation uses a correlated daemon request and Git argv, starts from
  current HEAD, and opens the new sibling checkout only after Git succeeds.
  Errors remain visible; existing branches/checkouts are never forced or removed.
- Removed the misleading “Spawn AI Agent Session” action, which only spawned
  another default shell. Installed agents can still be launched normally inside
  a terminal and detected by foreground process inspection.
- Unit tests cannot accidentally connect to a developer's live PTY daemon.
- Generated shell scripts and tmux configuration use a newly-created 0700
  directory and atomic 0600 files, avoiding predictable-path symlink writes.
- Hook installation validates every existing config before any write, rejects
  malformed/unsupported data, preserves foreign groups, quotes shell paths, and
  atomically replaces complete configurations with a first-change backup.
- Attention, switcher search, and notification selection include all workspaces.
  Session selection updates its owning workspace. Direct-jump numbers are unique
  across workspaces, including a migration for duplicate stored numbers.
- OSC 133 B preserves idle prompt state; only C starts execution. Explicit pane
  trees override legacy layout names, fixing splits collapsing on pane selection.
- Scrollback search uses Ctrl+Shift+F; plain Ctrl+F reaches the child process.
- HUD environment markers no longer claim a verified sandbox; review mode no
  longer claims automatic approval. Shell counter limits remain unknown.
- The desktop minimum width is 960. HiDPI uses 2x instead of 3x when needed
  to fit; narrower browser windows can scroll the plate with keyboard or pointer.
  Canvas drawing and hit testing use the same integer scale.
- Desktop production CSP restricts scripts/assets to local sources and permits
  only Tauri IPC and the loopback daemon for connections. Development CSP permits
  Vite's refresh preamble and HMR. The dev server binds loopback by default.
- Rust dependencies are pinned in the root Cargo.lock. Desktop checks use a
  distinct nonzero environment-block exit. CI now includes backend tests, HUD
  pixel comparison, and real production-bundle browser interactions.
- Claude/Codex transcript hints are scoped to agent, cwd, exact pane, and the
  Linux foreground PID plus kernel start ticks. Another same-agent pane or a
  replacement foreground process cannot reuse the reading. Directory scans are
  diagnostic-only; absent attribution renders unknown. Hint retention is capped
  at 256 entries and expires after 30 minutes.
- Transcript readers reject non-regular files without blocking on FIFO opens.
  Missing/malformed token accounting is unknown; overflowing totals are rejected.
- Removed Antigravity's unverified transcript-byte/token conversion, model/window
  defaults, and assumed 100-request quota. Both `agy` and `antigravity` retain
  foreground identity detection, but model/context/quota remain unknown until a
  verified pane-scoped accounting adapter exists. This also removes that reader's
  unbounded profile-history scan and directory-prefix attribution.
- Switching panes withholds the old pane's model, context, rate, and environment
  while awaiting telemetry. New terminals use their target group's directory,
  not a stale HUD value. Creating a normal terminal preserves existing sibling
  panes; a refused last-workspace close does not kill its sessions.
- Hook deadlines now include an unclosed stdin pipe, cap payloads at 64 KiB,
  preserve trailing newlines, and always return zero. Curl configuration and
  inherited proxies cannot redirect hook payloads. Without GNU timeout/gtimeout,
  the hook skips posting. These repository changes do not rewrite installed user
  hooks automatically; rerun the additive installer to deploy the updated script.
- Ctrl+C and Ctrl+Z no longer combine control-byte input with an out-of-band
  process-group signal. Raw-mode applications receive the byte; cooked terminals
  retain their line-discipline behavior. The palette now calls this “Send Ctrl+C”
  instead of promising an unconditional SIGINT.
- Clipboard CR/CRLF becomes LF before multiline bracketing. Embedded escape and
  other control bytes are removed (tab and LF remain). A real-browser regression
  reproduced CR paste executing its first command before Enter, and passes with
  the initial fix. Further probing disproved frontend-only mode checks: tmux
  enables its outer mode even while its child disables paste support.
- Clipboard now uses an authenticated, correlated Paste/PasteResult exchange.
  The direct PTY observes child mode; tmux admits and delivers in its command
  queue using the exact pane's mode. Multiline input is refused when unsupported.
  Requests are capped at 1 MiB, never queued/replayed, and time out with an unknown
  delivery outcome. Clipboard access failures, stale reads, and daemon refusals
  have visible handling. Tmux buffers use random names and stdin payloads, with
  bounded helper I/O and cleanup that preserves unrelated buffers.
- Quick-select insertion restores terminal keyboard focus. First spawn preserves
  a grid measured before session binding. Split dividers retain their 1px bevel
  but have a usable transparent pointer target; real dragging updates child size.
- Rendered terminal rows now use 17px line boxes, matching the integer PTY row
  calculation. The former 17.875px line height accumulated 37px of overflow and
  scrolled an editor's first row out of view. A real-browser viewport-containment
  regression reproduces that failure and passes with the fix.

## Evidence so far

- Node tests: 86 passing; Vitest: 438 passing across 53 files at the first repair
  checkpoint. Further changes require fresh verification.
- Rust: 58 PTY tests and 76 backend tests passed; three live-account probes are
  deliberately ignored. New network tests exercise actual loopback sockets.
- Frontend typecheck and production build passed. HUD reference comparison:
  15,360 pixels compared, zero mismatches.
- Tauri `cargo check --all-targets` passed in the existing `doom-tauri` development
  container. The host lacks dbus/GTK/WebKit development libraries. This proves
  compilation, not desktop runtime or packaging correctness.
- Chromium/Playwright at `http://127.0.0.1:1420`, with the WebSocket redirected
  only in the test context to an isolated daemon on port 1521: first-run folder
  picker, real shell command result (separate from its echo), palette navigation,
  settings dialog, and disabled automatic approval verified without console
  errors. Captured 1280×840 and 800×600 screenshots outside the repository.
- `npm audit`: no reported vulnerabilities in the installed dependency graph.
  `cargo audit` reports zero vulnerability-class advisories and 18 warnings:
  17 unmaintained dependencies and GLib VariantStrIter unsoundness
  ([RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429)). These
  warnings are not a clean dependency-security bill of health.
- Second checkpoint verification: 95 Node tests and 445 Vitest tests passed;
  Rust 58 unit + 1 integration PTY tests and 76 backend tests passed (three
  live probes ignored). Native Tauri
  all-target compilation passed with CSP in the existing development container.
- The maintained `npm run test:ui` now builds the production bundle, applies
  the desktop CSP (substituting only the disposable daemon port), and exercises
  startup, real shell output, Unicode, Ctrl+C, palette/settings, splits and
  zoom restoration, and narrow-viewport keyboard scrolling. Missing browser/server
  is a failure. Each run uses its own
  temporary runtime/tmux directory, stops its own processes, and retains
  screenshots outside the repository.
- Third checkpoint verification: 101 Node tests; 449 Vitest tests; 58 PTY unit
  tests, 1 PTY integration test, and 83 backend tests passed (3 live probes ignored).
  Typecheck, production build, HUD pixel comparison, and native all-target Tauri
  compilation passed. Real HTTP hooks and disposable agent-named PTY processes
  reproduce same-directory and same-pane-restart telemetry attribution cases.
- The production-CSP browser smoke additionally verifies new sessions preserve
  splits, open in the selected workspace, and can be activated from another
  workspace's attention row. Screenshots were inspected; browser console and
  page-error collectors were empty. These are not real vendor-agent sessions.
- Follow-up palette regression: a stationary pointer generated mouse-enter when
  the palette opened underneath it, stealing the initial attention-first keyboard
  selection. Pointer movement now changes selection; appearance alone does not.
  The component regression and real-browser attention-selection assertion passed.
  Fresh follow-up verification: all 450 Vitest tests and the production build pass.
- Input-safety checkpoint: 101 Node tests and 452 Vitest tests pass; typecheck,
  production build, and the zero-mismatch HUD comparison pass. Rust passes 58 PTY
  unit tests, 2 PTY integration tests, and 83 backend tests (3 live probes ignored).
  The new raw-mode integration fixture rejects forced Ctrl+C/Z signals and checks
  the exact C/Z/D bytes. The Chromium smoke verifies CR paste waits for Enter in
  explicitly enabled Bash bracketed-paste mode, nested-shell Ctrl+D, and cooked
  Ctrl+C. HTTP/browser tests require permission to launch processes and bind local
  sockets in restricted sandboxes. Changed Rust files pass rustfmt; the workspace
  formatting check still finds pre-existing differences in unrelated files.

## MVP evidence and remaining probes

| Capability | Current evidence | Outstanding validation or issue |
| --- | --- | --- |
| Attention queue | Exact-pane hook routing and cross-workspace presentation/activation regression tests | Background panes after cold reload still need binding coverage |
| Notifications | Pure transition policy tested; browser toggle now reflects permission | Native `notify-send` path does not route clicks to sessions |
| Session switcher | Browser keyboard/filter smoke and multi-workspace attention activation; unique slot and stationary-pointer regression tests | Larger-session-count keyboard/scroll stress coverage remains |
| Clipboard and pass-through | Real CR/LF refusal with Bash mode off; CR paste waits for Enter with mode on; direct/tmux literal byte tests; stale-read and protocol lifecycle tests; cooked Ctrl+Z/fg/Ctrl+C and Ctrl+D | Nested multiplexers and unobserved process replacement are not certified; additional TUI keyboard behavior remains |
| Turn navigation | Prompt-shape heuristics covered by tests | Real supported agent sessions and unsupported-agent behavior need review |
| Quick select | Real clipboard copy, insertion without submission, and restored-focus browser checks | Multi-letter labels and large target lists remain to audit |
| Binary splits | Geometry/component tests, live two-pane I/O, divider drag with actual stty size change, and selection/new-terminal regressions | Reload and asymmetric-layout fidelity remain |
| Focus and zoom | Browser zoom/unzoom verifies visibility and mounted sibling counts | Spatial focus and labels need deeper browser probes |
| Park versus kill | Close policy, OSC 133 idle lifecycle and reconnected exit delivery tested | Park/recovery runtime pending |
| Durable recovery | tmux discovery and reconciliation tests | Reset plus bounded replay can lose history; replay ordering and restart fidelity need architectural repair |

## Other confirmed follow-up work

- Non-Linux transcript process attribution is unavailable; context readings stay
  unknown there. Hook attribution is sampled at receipt; delayed hooks spanning
  a process replacement and account overrides need deeper identity validation.
- Filesystem/Git telemetry work still runs synchronously in the request path;
  regular-file validation does not bound slow filesystem or subprocess latency.
- Native runtime/packaging and dependency-maintenance warnings remain to assess.
- First-row editor clipping found during screenshot review is repaired and tested
  for actual viewport containment, not just DOM text. Horizontal cell alignment,
  additional fonts/viewports, function keys, and IME remain to audit.

## Child-checked paste checkpoint (2026-09-08)

- Final checkpoint verification: 101 Node tests,
  475 Vitest tests (55 files), 64 PTY unit tests, 5 PTY integration tests, and 84
  backend tests pass; three live-account probes remain ignored. Typecheck,
  production build, HUD comparison (15,360 pixels, zero mismatches), and native
  Tauri all-target compilation pass. The final refinement verifies that typing
  during an in-flight request does not suppress its refusal notice.
- Chromium production-CSP smoke passes at 1280×840, 960×840, and 800×600 on
  `http://127.0.0.1:1420` with an isolated ephemeral-port daemon. Both CR and LF
  clipboard requests into unsupported Bash insert nothing; supported CR paste
  waits for Enter. The same run verifies job control, quick-select, editor file
  save, live split resizing, zoom, settings, and cross-workspace attention.
  Page identity, meaningful content, absent framework overlays, and empty
  console/page-error collectors are checked. Screenshots were inspected outside
  the repository; editor clipping found here was repaired in the follow-up below.
- The Browser plugin is unavailable; this uses the maintained Playwright runner.
  The build still reports a >500 kB main chunk. Existing jsdom canvas/localStorage
  diagnostics and the deliberate corrupt-storage diagnostic remain in unit output.
  Modified Rust files pass rustfmt; unrelated workspace formatting is not claimed.

### Editor geometry follow-up

The added Chromium containment assertion failed with `rowTop=-24`,
`rowBottom=-6.125`, and viewport top `1`: the first editor line was entirely
above the visible terminal. With whole-pixel line boxes, the same full browser
suite passes and screenshot inspection shows the typed first line and editor
status row together. This closes the observed vertical clipping defect, not
every remaining full-screen terminal compatibility question.

## Antigravity telemetry follow-up (2026-09-09)

A real request-handler regression with a disposable profile reproduced invented
telemetry: a text-only transcript yielded `Gemini Flash`, context fraction
`0.001556396484375`, and quota fraction `0.01`. With the unsupported reader removed,
the same fixture returns absent model/context/quota while preserving Antigravity
identity for both command aliases, with and without a configured model.

The Linux regression uses bubblewrap to mount fixture files in a private process,
network, and mount namespace. It leaves the HOME environment variable unchanged;
real profiles and credentials are not read or changed. Install `bubblewrap` before
running `cargo test --locked` on Linux; CI installs it. Missing bubblewrap or denied
namespace creation fails the test explicitly rather than silently skipping it.

Fresh verification: 101 Node tests, 475 Vitest tests, 64 PTY unit tests, 5 PTY
integration tests, and 83 backend tests pass; three live-account probes remain
ignored. Typecheck, production build, HUD comparison (15,360 pixels, zero
mismatches), and native Tauri all-target compilation in `doom-tauri` pass.
The backend test count drops by one because two live-profile-dependent tests
were replaced by the isolated regression above.

The maintained Chromium smoke's assertions pass at 1280×840, 960×840, and
800×600, with no collected browser runtime errors. Screenshot review nevertheless
found `sh: leep: command not found` following its rapid `sleep 30`/Ctrl+C probe.
That probe checks the next command's success without establishing that sleep
became the foreground process, so its pass is insufficient evidence of correct
interrupt timing/input ordering. This remains to investigate; the separate
Ctrl+Z/fg probe explicitly observes a stopped job. Editor first-row containment
and file save still pass. The >500 kB bundle warning and previously documented
unit-test diagnostics remain.

### Interrupt verification follow-up

Browser WebSocket tracing confirmed that the rapid probe sends all characters
of `sleep 30`, Enter, and Ctrl+C in order. One traced run canceled the line while
it was still being edited; a separate disposable tmux experiment, without Doom
Term, likewise showed rapid Enter/Ctrl+C canceling input before execution. This
does not establish the cause of the earlier partial-line `leep` observation.

The maintained probe now waits until the exact private tmux pane reports `sleep`
as its foreground command, sends Ctrl+C, and requires the shell to return before
checking another command. A negative control that omitted Ctrl+C failed after
five seconds with `sleep` still in the foreground. Restoring Ctrl+C passes the
full Chromium smoke; editor and narrow-viewport screenshots were inspected.
Only verification changed here, not application input behavior. The rapid-input
anomaly remains open rather than being declared fixed by this stronger probe.

## Recovery contract implementation in progress

The [sequenced recovery contract](superpowers/specs/2026-09-09-sequenced-recovery-design.md)
specifies create-only versus attach-only operations, incarnation/attachment
fences, ordered replay, bounded retention, and refusal of disconnected input.
Exact warm continuation is distinct from a fresh tmux view with separated,
potentially incomplete recovered history. It adds no disk transcript journal.
The user approved implementation on 2026-09-10. The
[inline implementation plan](superpowers/plans/2026-09-10-sequenced-recovery.md)
tracks the work; its runtime verification gates remain outstanding. Approval is
not evidence of implemented recovery or beta readiness.

### Verification baseline repair (2026-09-10)

Remote CI failed at the real tmux paste test even though local checks passed.
The adapter admitted tmux 3.3+, but `bracket_paste_flag` was only added in
[tmux 3.7](https://raw.githubusercontent.com/tmux/tmux/3.7/CHANGES).
Ubuntu's older packaged tmux expands that unknown format to an empty string,
which correctly fails closed but prevents enabled multiline paste. Local tmux
3.7c masked the dependency error. The runtime and opt-in sidecar now require
3.7+, and CI builds checksum-pinned 3.7c. Unsupported versions report
non-durable direct-PTY fallback at creation; paste admission is not weakened.
The version regression failed on the old floor; the corrected floor and real
direct/tmux paste suite pass locally. Remote CI must be checked separately.

The next CI run passed paste and reached an existing telemetry-fixture failure:
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. CI now installs
a per-executable AppArmor user-namespace allowance for `/usr/bin/bwrap`, following
[Ubuntu's documented policy](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces),
then probes the same namespace setup before testing. This is runner-only setup;
the real fixture's private profile/PID/network isolation remains required and no
host-wide security setting is disabled. [CI run 34482935923](https://github.com/CMLeadmon/Doom-Term/actions/runs/34482935923)
passed all stages, including the real browser and native compilation. A separate
sidecar-builder regression rejects a 3.6b executable before installation; reverting
its minimum to 3.3 made that regression fail, then restoring 3.7 passed.

### Recovery foundation (2026-09-10; not the protocol cutover)

The PTY's internal 500-event ring is replaced by a cursor-readable journal with
8 MiB / 8,192 records per stream and 64 MiB globally. Entire oldest records are
evicted, cursors outside retention fail explicitly, and serialized u64 sequences
remain decimal strings. Output, observed TUI/semantic events, accepted resizes,
and closure now share an observation order and source monotonic timestamps.
Journal handles release retained payloads on final drop. Oversized records and
overlong CSI/OSC accumulators end rendering with an explicit fault; the reader
keeps draining the living child and further terminal input is refused.

The live wire protocol is still legacy at this checkpoint. Its compatibility
reader deliberately retains the previous 500-record delivery cap instead of
copying the enlarged journal into its old unbounded outbound channel. Cursor
subscription delivery, ownership/ready fencing, persisted tmux incarnations,
separated cold archives, background reconciliation and recovery-state UI remain
in progress. The currently generated adapter identities are not yet evidence of
durable pane identity. These foundations alone do not repair exact reconnection.

`TerminalScreen` now exposes parse-completion and five-second drain promises,
independent of browser painting. Disposal/reset rejects outstanding boundaries;
late callbacks cannot acknowledge a new parser. A real-parser regression found
that `xterm.reset()` left queued old bytes alive (`old bytesnew bytes`); explicit
reset now replaces that parser while preserving the wrapper's subscriptions.
A stalled async parser fixture verifies timeout without fabricating application.

Local verification: 75 PTY unit tests, 11 PTY integration tests and 83 backend
tests pass (three live-account tests remain intentionally ignored); 480 Vitest
tests pass, as do the 101 existing Node tests and the added sidecar regression.
Typecheck, production build, exact HUD comparison (15,360 pixels; zero mismatch),
Rust check and native all-target compilation in `doom-tauri` pass. Existing
JSDOM/corrupt-storage diagnostic output and the >500 kB bundle warning remain;
these are not claimed to be warning-free checks.

The production-CSP Chromium smoke also passes: shell/Unicode, clipboard/job
control, foreground Ctrl+C, quick-select, editor save/restore, split/zoom,
settings/workspaces and background hooks. Screenshots in `/tmp/doom-ui-S9Blb1`
(editor and 800-pixel viewport inspected) show a contained editor viewport and
working split shells. Browser plugin was unavailable; maintained Playwright was
used. This is regression smoke, not the still-required disconnect/restart and
exact-cell recovery certification.

### Recovery startup race and exact helper targets (2026-09-10)

[Foundation CI 34517285834](https://github.com/CMLeadmon/Doom-Term/actions/runs/34517285834)
failed the split-pane browser probe: its new terminal stayed blank. A late
SessionMode could erase startup bytes already parsed or queued. Two real-parser
regressions failed before the correction. Legacy reset now precedes the Spawn
request instead of following asynchronously arriving output. Metadata receipt
does not reset a screen. Exact warm continuation still awaits v2.

An isolated real-tmux regression also proved that a missing session name could
prefix-match a neighbor: querying its pid, capturing its history, and killing it.
All non-create helpers now disable server auto-start and use exact name targets;
the regression leaves the neighbor alive. Query, capture, list and version
helpers now have declared input/output budgets and two-second deadlines. This
does not yet fence same-name replacement by incarnation or separate archives.

Fresh local checks pass: 481 Vitest and 102 Node tests, 89 PTY and 83 backend
tests (three live-account tests ignored), typecheck, build, HUD and Rust check.
Production-CSP Chromium smoke passes with artifacts `/tmp/doom-ui-EwhRvu`
(split screenshot inspected); native all-target compilation in `doom-tauri`
also passes.
The existing bundle warning remains. Workspace-wide rustfmt reports pre-existing
formatting differences in untouched backend usage and native-shell files;
changed Rust files are checked separately. Remote CI for the correction must
be inspected separately, not inferred from these local results.

### Durable adapter APIs (2026-09-10; transport integration pending)

The startup/exact-name correction is green in
[CI 34518524744](https://github.com/CMLeadmon/Doom-Term/actions/runs/34518524744).
The next adapter layer adds create-only and attach-only APIs with persistent
128-bit tmux-pane incarnation metadata, root-pid checking and exact numeric
targets. Duplicate creation cannot stamp or adopt an existing pane. A missing,
unidentified or replaced target cannot become a fallback shell. Explicit legacy
adoption checks the observed pane and pid and never overwrites an identity.

Retiring a display adapter ends its stream, kills/reaps only its owned client,
and joins its reader/poll threads without declaring the shell exited. The next
adapter retains the root incarnation and changes its stream epoch. Seven real
isolated tests cover PID preservation, zero/one display-client counts across
repeated retirement/attachment, prefix refusal, direct-PTY retirement refusal,
legacy adoption, respawn/server replacement (including reused numeric pane id),
and a stalled bootstrap that finishes within ten seconds while preserving its
created root. A real Vim fixture saves edits from both sides of reattachment;
its historical capture stays outside the fresh live journal.

Archive capture returns a separate typed value with capture identity, observed
dimensions, line count, at-limit information and explicit potentially
overlapping/incomplete provenance. Empty history does not become captured live
screen rows. Oversized/failed capture is an error, not a complete empty archive.
The full 8 MiB helper test initially timed out because successful 4 KiB reads
slept one millisecond each; it now passes with the unchanged two-second deadline
by backing off only on stalled I/O.

This is still not the v2 protocol cutover: the live daemon/frontend use legacy
Spawn/rebind, and the new APIs are not advertised as live recovery yet. Socket
ownership/readiness fences, mutation handling, archive transfer/presentation and
exact browser stream comparisons remain outstanding. The existing browser
regression smoke passes (`/tmp/doom-ui-4B6SjB`); it does not exercise the new
recovery handshake. Local Rust check passes with 96 PTY and 83 backend tests
(three live-account tests ignored); native all-target compilation in
`doom-tauri` passes. Existing frontend checks remain 481 Vitest / 102 Node,
typecheck, build and zero-mismatch HUD, with no frontend changes in this layer.

### Applied frontend stream cursors (2026-09-10; transport integration pending)

The durable adapter checkpoint is green in
[CI 34523016148](https://github.com/CMLeadmon/Doom-Term/actions/runs/34523016148).
The frontend now has a separately tested `StreamApplication`: validated decimal
u64 cursors advance only after real parser application, ordered resize and
semantic projection. Duplicate records do not repeat bytes, counts or activity;
unseen catch-up records restore state without live-activity callbacks. Execution
durations use recorded source timestamps in the descriptor's clock epoch;
missing history or endpoints remain unknown. Gaps, identity changes, faults,
backward clocks and disposal stop further application.

Warm continuation retains the same parser. A 600-record real-xterm fixture
matches an uninterrupted control's rendered spans, wrapping and cursor while
preserving earlier history and marks. Explicit cold registry replacement uses
recorded initial dimensions and rejects pending work from the old parser.
Queued application is bounded to 4 MiB / 8,192 entries, and a reconnect drain
has one five-second deadline including all earlier queued records. Separate
three-second writes reproduced the previous per-write deadline hole. Disposed
screens and projection-triggered disposal cannot acknowledge semantic work or
emit subsequent activity; the 64 KiB record limit includes identity fields.

Forty focused parser/protocol/registry tests and all 502 Vitest / 102 Node tests
pass. Typecheck, production build and exact HUD comparison pass (15,360 pixels,
zero mismatch). Existing JSDOM/storage diagnostics and the >500 kB bundle warning
remain. The production-CSP Chromium regression smoke also passes with isolated
artifacts in `/tmp/doom-ui-OIxarL`; the split screenshot was inspected and shows
both live shell panes contained above the status plate. These are module-level
continuation tests and legacy browser smoke, not the required real
WebSocket disconnect/daemon-restart certification. The live legacy protocol,
ownership/readiness gates, no-input-replay cutover and archive UI still require
Tasks 4+6; the recovery contract is not yet implemented end to end.

### Negotiated recovery service (2026-09-12; staged, not public cutover)

The v2 service now has real authenticated socket tests for negotiation, exact
ownership, parser-applied cut acknowledgements, correlated paste, ordered resize,
disconnect cleanup, heartbeat expiry, bounded frame reception and closed-process
retention. A full outbound queue originally allowed an early cut acknowledgement;
queue commit and cut publication are now atomic. A blocked PTY write originally
prevented lease release; socket reads now stay active independently of ordered
command execution, with bounded inbound admission and discarded pending commands
on disconnect.

Cold attachment discovers an existing pane's identity without inventing a daemon
checkpoint. A bounded rebuild preserves its PID and observed dimensions, retires
the previous display client, starts a fresh stream epoch and transfers history
as separate capture-id/ordinal chunks with explicit completion and provenance.
Real tests preserve shell and editor state; archive bytes do not enter the live
journal. A killed display client produces an adapter fault, not a fabricated
process exit. A later actual exit still becomes a bounded tombstone after a
rendering fault, and explicit KILL remains possible for an owned process that
has closed its terminal descriptors.

Adversarial fixtures also reproduced stale input, resize and paste delivery.
Identified tmux input now uses literal hex bytes in an identity-checked command
queue, preserving NUL/control/Unicode/escape bytes without clipboard framing.
Identified windows use explicit, identity-fenced resizing; late display sizing
cannot independently resize a replacement pane. Paste rechecks its socket lease
after loading its private buffer and cleans up on refusal. Direct kill no longer
trusts a cached numeric PID after its Child has been reaped.

Fresh verification passes: 103 PTY tests, 107 backend tests (three live-account
tests ignored), 503 Vitest / 102 Node tests, typecheck, production build,
15,360-pixel zero-mismatch HUD and native all-target compilation in `doom-tauri`.
The existing bundle-size and JSDOM fixture diagnostics remain. These checks do
not certify end-to-end recovery: the public listener/frontend still use the
legacy protocol pending their coordinated replacement. Remaining work includes
metadata/hooks and explicit legacy recovery, all-workspace identity persistence,
removal of input replay, archive presentation, live stress tests and all eleven
real-browser contract gates. Beta readiness remains unproven.

### Frontend recovery cutover (2026-09-13; local work in progress)

The public frontend client now uses negotiated connection and per-session
attachment modules. It no longer has a reconnect typing queue, echo-held input,
or legacy Spawn wire command. Focus is separate from attachment; exact restored
identities in background and parked workspaces attach with concurrency four.
Catch-up projection uses source-derived timing and suppresses completion
notification replay. Desired geometry no longer reflows the parser before an
ordered confirmation. Targeted suites pass, including real xterm continuation,
stale-socket rejection, create/paste uncertainty and identity-only reconciliation.

**This working tree is mid-cutover, not deployable yet.** The public backend
listener still needs its matching v2 integration. Migrating the legacy frontend
fixtures exposed and fixed close-before-Kill-result handling; all 565 Vitest
tests now pass, as does typecheck. This is not a browser/daemon pass. Archive/cache
presentation and storage bounds, lifecycle UI outcomes, explicit legacy recovery,
metadata/hooks, stress coverage and real-browser gates remain open. Earlier
green full-suite/build results above describe the pre-cutover state, not these
unfinished local changes.

### Public recovery integration (2026-09-15; not release-certified)

The public listener and frontend now both speak protocol v2. The old WebSocket
dispatcher and its unbounded delivery queue are removed; legacy daemon commands
remain test-only while their historical PTY tests are migrated. Real recovery
socket fixtures now enter through the public HTTP/WebSocket router. Authentication
and negotiation gate discovery, metadata and retained hook state.

Directory listings have count/serialized-byte bounds and a visible partial-listing
notice. Metadata workers have bounded admission, retain their permits through
uncancellable filesystem work, and do not stall ordinary socket dispatch. Git
queries are bounded; worktree creation has a 20-second helper deadline and leaves
unconfirmed partial work intact. Telemetry replies carry the expected incarnation
and cannot describe a replacement process under a reused pane id.

Hook state has stable source ids, an atomic retained/live handoff and bounded
retention. New direct and durable roots pass their incarnation to the hook script.
The frontend buffers early hook state until exact-identity binding, suppresses
duplicate/restored asks and refuses stale-process clearing. Explicit revival now
creates a fresh logical id and replaces its original cached pane only after Create
confirmation, preserving cache and focus on failed/unknown results.

Fresh checks: 104 PTY tests, 112 backend tests (three live-account tests ignored),
578 Vitest tests, 102 Node tests, typecheck and native all-target compilation pass.
The latest pre-revival production build and 15,360-pixel zero-mismatch HUD check
also pass; bundle-size and test-environment diagnostics remain. A fresh browser
smoke is in progress. No full recovery-browser gate pass is claimed.

Still open: explicit legacy/replacement recovery choices, cache/archive presentation
and combined storage bounds, removal of legacy PTY Spawn/rebind APIs, durable pane
exit observation, live overflow/gap and concurrent/lost-create stress tests, and
all eleven real-browser contract gates. This is not yet a deployable completion
of the written recovery plan or a beta-readiness certification.

## Trust boundary references

WebSocket origin checking follows [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455):
loopback binding alone does not authenticate browser scripts. Tauri's
[CSP guidance](https://v2.tauri.app/security/csp/) informed the desktop policy.

## Running browser verification

Install Chromium once with `npx playwright install chromium`, then run
`npm run test:ui` with port 1420 free. CI installs Chromium's system dependencies
too. Browser plugin not available in this audit; regular Playwright was used.
This is a smoke suite, not a claim that every MVP scenario has passed.
