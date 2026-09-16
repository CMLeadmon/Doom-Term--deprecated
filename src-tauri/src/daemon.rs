//! Supervises the bundled PTY daemon.
//!
//! Doom Term is a desktop application first: the daemon is an implementation
//! detail, not something a user should have to start. It ships inside the app
//! bundle as a Tauri sidecar, is launched at startup, and is killed when the
//! app exits.
//!
//! The frontend talks to it over a loopback WebSocket rather than through Tauri
//! IPC, so this module is the whole of the desktop shell's involvement with it.

use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Must match the daemon's default in `backend/src/main.rs`.
const DAEMON_PORT: u16 = 1421;

/// How long to wait for the daemon to accept connections before giving up and
/// letting the frontend's own reconnect loop take over.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Holds the spawned child so it can be killed on exit. `None` when the app
/// attached to a daemon it did not start.
pub struct Daemon(Mutex<Option<CommandChild>>);

fn address() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], DAEMON_PORT))
}

/// Whether something is already accepting connections on the daemon's port.
fn is_listening() -> bool {
    TcpStream::connect_timeout(&address(), Duration::from_millis(250)).is_ok()
}

/// Starts the bundled daemon unless one is already running.
///
/// A developer running `npm run server` in a terminal already has a daemon on
/// the port; spawning a second one would only fail to bind and die, so we
/// attach to the existing one instead.
pub fn start(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if is_listening() {
        log::info!(
            "PTY daemon already listening on {}; attaching to it",
            address()
        );
        app.manage(Daemon(Mutex::new(None)));
        return Ok(());
    }

    // AppImage's loader paths are for the GUI, not host programs. Clear
    // inheritance before supplying the sanitized snapshot so removed variables
    // cannot leak back into the daemon, tmux server, or terminal children.
    let (mut rx, child) = app
        .shell()
        .sidecar("doom-term-server")?
        .env_clear()
        .envs(crate::daemon_env::sanitize(std::env::vars_os()))
        .spawn()?;
    app.manage(Daemon(Mutex::new(Some(child))));

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

    if wait_until_listening() {
        log::info!("PTY daemon ready on {}", address());
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

fn wait_until_listening() -> bool {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if is_listening() {
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
        if let Some(child) = daemon.0.lock().take() {
            log::info!("stopping the bundled PTY daemon");
            let _ = child.kill();
        }
    }
}
