//! Supervises the bundled PTY daemon.
//!
//! Doom Term is a desktop application first: the daemon is an implementation
//! detail, not something a user should have to start. It ships inside the app
//! bundle as a Tauri sidecar, is launched at startup, and is killed when the
//! app exits.
//!
//! The frontend talks to it over a loopback WebSocket rather than through Tauri
//! IPC, so this module is the whole of the desktop shell's involvement with it.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Must match the daemon's default in `backend/src/main.rs`.
pub const DEFAULT_PORT: u16 = 1421;

/// What `GET /health` must name itself for us to treat a listening port as our
/// own daemon. Must match `DAEMON_SERVICE_ID` in `backend/src/main.rs`.
const DAEMON_SERVICE_ID: &str = "doom-term-daemon";

/// How long to wait for the daemon to accept connections before giving up and
/// letting the frontend's own reconnect loop take over.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the identity handshake may take. Generous against a loaded machine,
/// short enough that a process which accepts connections and then says nothing
/// cannot hold up the window.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(750);

/// Holds the spawned child so it can be killed on exit, and the port the
/// frontend must dial. `child` is `None` when the app attached to a daemon it
/// did not start.
pub struct Daemon {
    child: Mutex<Option<CommandChild>>,
    port: u16,
}

impl Daemon {
    pub fn port(&self) -> u16 {
        self.port
    }
}

fn address(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

/// The port the developer asked for, if any, else the default.
///
/// `npm run server` and the daemon itself both read `DOOM_PORT`; honouring it
/// here keeps "run the daemon yourself on a chosen port" working.
fn preferred_port() -> u16 {
    std::env::var("DOOM_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(DEFAULT_PORT)
}

/// Whether the process listening on `port` is one of our daemons.
///
/// A TCP connect only proves that *something* is there. That was the whole of
/// the old check, and it made any process holding 1421 — a stale dev server, a
/// leftover debug proxy — into this app's daemon: the shell spawned nothing,
/// the frontend dialled a stranger, and every terminal failed silently with no
/// error in any log. So ask, and require the daemon to say its own name.
fn daemon_identifies_itself(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address(port), HANDSHAKE_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));

    let request = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    // The reply is a short JSON body; a stranger that floods us is cut off
    // rather than read to exhaustion.
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    while buf.len() < 8192 && Instant::now() < deadline {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }

    let reply = String::from_utf8_lossy(&buf);
    reply.starts_with("HTTP/1.1 200") && reply.contains(DAEMON_SERVICE_ID)
}

/// Whether anything at all is accepting on the port.
fn is_listening(port: u16) -> bool {
    TcpStream::connect_timeout(&address(port), Duration::from_millis(250)).is_ok()
}

/// An ephemeral port the OS says is free.
///
/// Bind-then-drop leaves a small window in which something else could take it,
/// which is why the daemon is still the one that binds for real and why a
/// failure here is not fatal — the frontend reports a daemon it cannot reach.
fn free_port() -> Option<u16> {
    let listener = TcpListener::bind(address(0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    Some(port)
}

/// What to do about the daemon, and on which port.
///
/// Decided before the Tauri app is built, because the webview needs the port in
/// an initialization script and plugins are registered before `build()`. The
/// decision needs nothing from the app — it is all loopback probing — so it is
/// separated from the spawning, which needs the app handle for the sidecar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    /// A daemon of ours is already up here; do not start a second.
    Attach(u16),
    /// Nothing of ours is here; start one on this port.
    Spawn(u16),
}

impl Plan {
    pub fn port(self) -> u16 {
        match self {
            Plan::Attach(port) | Plan::Spawn(port) => port,
        }
    }
}

/// Decides where the daemon will be.
///
/// A developer running `npm run server` in a terminal already has a daemon on
/// the port; spawning a second one would only fail to bind and die, so we
/// attach to the existing one instead. Anything else holding the port is a
/// stranger, and we move out of its way rather than mistaking it for ours.
pub fn plan() -> Plan {
    let preferred = preferred_port();

    if !is_listening(preferred) {
        return Plan::Spawn(preferred);
    }

    if daemon_identifies_itself(preferred) {
        log::info!(
            "PTY daemon already listening on {}; attaching to it",
            address(preferred)
        );
        return Plan::Attach(preferred);
    }

    match free_port() {
        Some(fallback) => {
            log::warn!(
                "{} is held by something that is not a Doom Term daemon; starting ours on {} instead",
                address(preferred),
                address(fallback)
            );
            Plan::Spawn(fallback)
        }
        None => {
            // Nothing free to move to. Spawning on the occupied port fails to
            // bind and the UI reports a daemon it cannot reach, which is the
            // honest outcome and still better than adopting the stranger.
            log::error!("no free loopback port for the PTY daemon");
            Plan::Spawn(preferred)
        }
    }
}

/// Starts the bundled daemon, or records that we attached to a running one.
pub fn start(app: &AppHandle, plan: Plan) -> Result<(), Box<dyn std::error::Error>> {
    let port = plan.port();

    if let Plan::Attach(port) = plan {
        app.manage(Daemon {
            child: Mutex::new(None),
            port,
        });
        return Ok(());
    }

    // AppImage's loader paths are for the GUI, not host programs. Clear
    // inheritance before supplying the sanitized snapshot so removed variables
    // cannot leak back into the daemon, tmux server, or terminal children.
    let mut env = crate::daemon_env::sanitize(std::env::vars_os());
    // The daemon reads DOOM_PORT for itself. Stating it explicitly is what
    // makes the fallback above real rather than advisory.
    env.insert(
        std::ffi::OsString::from("DOOM_PORT"),
        std::ffi::OsString::from(port.to_string()),
    );
    // Windows only. Linux and macOS have tmux: the shell is nobody's child of
    // ours, so the daemon may come and go and the work survives either way.
    // Windows has no tmux and the ConPTY dies with the daemon, so there the
    // daemon itself is what has to outlive the window — see RunEvent::Exit in
    // lib.rs, which deliberately does not stop it there.
    //
    // The grace is what keeps that from becoming a forgotten process: reopen
    // within ten minutes and the agent is still working, walk away and the
    // daemon exits and takes its process tree with it.
    #[cfg(windows)]
    env.insert(
        std::ffi::OsString::from("DOOM_TERM_IDLE_EXIT_SECS"),
        std::ffi::OsString::from("600"),
    );
    let (mut rx, child) = app
        .shell()
        .sidecar("doom-term-server")?
        .env_clear()
        .envs(env)
        .spawn()?;
    app.manage(Daemon {
        child: Mutex::new(Some(child)),
        port,
    });

    // The daemon logs through env_logger, which writes to stderr.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    log::info!("daemon: {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    log::error!("PTY daemon exited with {:?}", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    if wait_until_listening(port) {
        log::info!("PTY daemon ready on {}", address(port));
    } else {
        // Not fatal: the frontend reconnects on a timer, so a slow start just
        // means the first window paints before the terminal is usable.
        log::warn!(
            "PTY daemon did not accept connections within {:?}; the UI will keep retrying",
            STARTUP_TIMEOUT
        );
    }

    Ok(())
}

fn wait_until_listening(port: u16) -> bool {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if is_listening(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Kills the daemon if this app started it. A daemon we merely attached to is
/// somebody else's to stop.
pub fn stop(app: &AppHandle) {
    if let Some(daemon) = app.try_state::<Daemon>() {
        if let Some(child) = daemon.child.lock().take() {
            log::info!("stopping the bundled PTY daemon");
            let _ = child.kill();
        }
    }
}
