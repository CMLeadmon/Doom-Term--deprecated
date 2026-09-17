# Building Doom Term

Doom Term is a Tauri 2 desktop app: a React frontend, a Rust WebSocket daemon
bundled as an external sidecar, and a shared PTY crate underneath both.

```
crates/doom-term-pty/   the PTY layer — one implementation, two shells
backend/                the daemon (doom-term-server), bundled as a sidecar
src-tauri/              the desktop shell that launches it
src/                    the React frontend
```

## Prerequisites

Everywhere: **Node 22+** and a **stable Rust toolchain**.

| Platform | Also needed |
| :--- | :--- |
| Linux | `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev`, plus `patchelf file desktop-file-utils` to bundle |
| macOS | Xcode command line tools |
| Windows | MSVC build tools (the C toolchain `ring` needs) and the WebView2 runtime, which ships with Windows 11 |

To run the full test suite on Linux you also need `bubblewrap`, `vim-tiny`, and
**tmux 3.7 or newer** — older tmux has no `bracket_paste_flag`, so the
child-checked paste tests cannot observe the mode they exist to check. Distro
packages are usually too old; `.github/workflows/ci.yml` builds 3.7c from a
checksum-pinned tarball.

## Everyday commands

```bash
npm install
npm run dev          # Vite frontend against a daemon you start yourself
npm run server       # the daemon alone, on 127.0.0.1:1421
npm run tauri dev    # the whole desktop app
```

`npm run agent:verify` is the single gate: typecheck → tests → production build
→ pixel-exact HUD → `cargo check` → `cargo test` → Tauri shell check. Run it
before opening a pull request.

Two things it deliberately does **not** do:

- `npm run hud:check:browser` is excluded, because nothing headless can produce
  its input. Capture `.artifacts/plate-actual.png` from the running app first.
- It does not lint. `cargo fmt --all --check` and
  `cargo clippy --all-targets -- -D warnings` run as their own CI job.

## Why `src-tauri` is not a default workspace member

`cargo check` and `cargo test` at the workspace root deliberately skip
`src-tauri`. It needs glib, gtk, dbus-1 and webkit2gtk, which a headless
checkout does not have, and a gate that fails on a missing system package is
indistinguishable from one that fails on a real bug.

Ask for it explicitly instead:

```bash
npm run check:tauri
```

This reports three outcomes, not two. Exit **0** is a pass, **1** is a genuine
compile failure, and **2** is an *environment block* — the machine lacks the
development packages. Trust that exit code over a bare `cargo check`, which can
exit 0 from cache having run no build scripts and verified nothing.

## Building for Windows from Linux

The PTY crate cross-checks directly, and this is the fast loop for Windows work:

```bash
rustup target add x86_64-pc-windows-msvc
cargo check --all-targets --target x86_64-pc-windows-msvc -p doom-term-pty
```

**`--all-targets` is not optional.** Plain `cargo check` skips test code, and
every Windows break found while building 0.2.0 was *in* a test — an ungated
`std::os::unix` import, and POSIX fixture programs in tests nobody had gated.

The daemon does **not** cross-check this way: `ring` compiles C and needs MSVC's
`lib.exe`, so you get `failed to find tool "lib.exe"`. That is an environment
limit, not a Windows incompatibility — a real `windows-latest` runner builds it
without complaint.

To cross-*build* the whole app, [`cargo-xwin`](https://github.com/rust-cross/cargo-xwin)
supplies the MSVC CRT and SDK:

```bash
cargo install cargo-xwin
rustup target add x86_64-pc-windows-msvc
# also needs clang, lld and nsis
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc
```

NSIS installers cross-compile; **MSI does not** — WiX only runs on Windows. CI
builds both.

## Sidecars

`npm run sidecar` builds the daemon and installs it under the name Tauri's
bundler demands: `doom-term-server-<target-triple>[.exe]`. Getting that name
wrong fails at bundle time with a confusing "file not found", so the path is
derived from `cargo metadata` rather than guessed — a crate inside a workspace
builds into the *workspace's* target directory, not its own.

Bundling tmux is opt-in and off by default. `binaries/tmux` is deliberately not
in `tauri.conf.json`'s `externalBin`, because every entry there must exist at
bundle time. To ship it, set `DOOM_TMUX_BINARY` to a tmux ≥ 3.7 executable
*and* add the entry back. Without it, `resolve_tmux` still finds a system tmux
on `PATH`, and on macOS in the Homebrew prefixes a Finder-launched app cannot
see through `PATH` alone.

## Troubleshooting

**`cargo check` passes but `tauri build` fails at link.** Checking never
invokes the linker. Missing `-lgdk-3`, `-lpangocairo-1.0`, `-lcairo-gobject`,
`-lgdk_pixbuf-2.0` or `-latk-1.0` means GTK development libraries, not your
code. The sidecar half builds fine before the shell link fails.

**AppImage bundling fails inside rootless podman.** Set
`APPIMAGE_EXTRACT_AND_RUN=1`; linuxdeploy cannot mount there.

**A terminal opens in the wrong directory.** The tmux server outlives every
launch and keeps whichever working directory it first inherited. `tmux -L
doom-term kill-server` restarts it — which is also the only thing that picks up
a changed `tmux.conf`.
