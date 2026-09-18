use doom_term_pty as pty;

pub mod artifacts;
mod hooks;
mod metadata;
mod security;
mod usage;
mod worktree;

// Public v2 transport; there is no legacy wire fallback.
mod attachments;
mod outbound;
mod protocol;
mod gateway;
#[cfg(test)]
mod recovery_tests;

#[cfg(test)]
mod security_tests;

#[cfg(all(test, target_os = "linux"))]
mod telemetry_tests;

use anyhow::Result;
#[cfg(test)]
use futures_util::{SinkExt, StreamExt};
use parking_lot::RwLock;
use pty::demuxer::DemuxEvent;
use pty::session::PtySession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
#[cfg(test)]
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_git_repo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoverableSession {
    pub id: String,
    pub cwd: String,
    pub command: String,
    pub durable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
pub enum ServerMessage {
    PasteResult {
        request_id: String,
        session_id: String,
        error: Option<String>,
    },
    AuthResult {
        success: bool,
        message: String,
    },
    PtyEvent {
        session_id: String,
        event: DemuxEvent,
    },
    /// An agent CLI told us something through its own hook.
    ///
    /// This is how the terminal learns that an agent is blocked on a human —
    /// the single most valuable thing it can know about a session nobody is
    /// looking at. It arrives from the AGENT's process, which knows its own
    /// cwd and session id but nothing about our node ids, so the frontend
    /// correlates by cwd.
    AgentEvent {
        /// "claude" | "codex" — whichever hook script posted.
        agent: String,
        /// The vendor's event name, verbatim. "PermissionRequest" blocks;
        /// "Stop" clears. Anything else is forwarded and ignored downstream
        /// rather than dropped here, so a new event never needs a daemon change.
        event: String,
        cwd: Option<String>,
        agent_session_id: Option<String>,
        /// The Doom Term pane this agent is running in, when the hook could say.
        ///
        /// The exact key. `cwd` cannot be one: two agents in a single repository
        /// share it, so the first match won and the wrong pane was marked as
        /// waiting on the user. Absent for an agent started before its session
        /// carried the variable, in which case the client falls back to cwd.
        doom_session_id: Option<String>,
    },
    /// An artifact was published or updated by an agent, tool, or user script.
    ArtifactEvent {
        artifact: crate::artifacts::ArtifactRecord,
        open_pane: bool,
        phase: String,
    },
    Telemetry {
        /// Which session this describes, echoed from the request.
        ///
        /// A reply is asynchronous, so by the time it lands the user may have
        /// switched tabs. Without this the client can only assume the answer is
        /// about whatever is on screen now, and a foreground agent gets
        /// attributed to the wrong session — the same class of mislabel the
        /// per-session `agent` lookup below exists to prevent.
        session_id: Option<String>,
        username: String,
        hostname: String,
        current_dir: String,
        git_branch: Option<String>,
        isolation: String,
        agent_key: Option<String>,
        agent_name: Option<String>,
        /// Fraction 0..1 of the account's binding rate limit that is used, or
        /// None when unknown. None renders '--' on the plate; it must never be
        /// coerced to 0.0, which would claim a fresh quota we did not observe.
        rate_used: Option<f64>,
        /// Fraction 0..1 of the running agent's context window that is filled,
        /// or None when unknown. A different source entirely from `rate_used`:
        /// that is the account's rate limit over HTTPS, this is one session's
        /// window read from its transcript. They must never be conflated, and
        /// like `rate_used` this must never be coerced to 0.0.
        context_used: Option<f64>,
        /// The model the running agent is actually using, or None.
        ///
        /// Read from the transcript, never inferred. /proc yields only a
        /// binary name, which is why this field did not exist before and why
        /// inventing one was ruled out.
        agent_model: Option<String>,
        /// What the shell on the far end of a transport reported, or None for a
        /// local session.
        ///
        /// Its presence changes how every sibling field must be read: a remote
        /// session's unreported branch is unknown, never the daemon's own.
        /// Boxed to keep this variant from dwarfing every other one — clippy's
        /// large_enum_variant, which every ServerMessage would otherwise pay
        /// for. Option<Box<T>> rather than clippy's suggested Box<Option<T>>:
        /// it keeps the null niche, does not allocate for a local session, and
        /// serializes identically either way.
        remote: Option<Box<doom_term_pty::remote::RemoteEnrichment>>,
    },
    DirectoryListing {
        request_id: String,
        current_path: String,
        parent_path: Option<String>,
        entries: Vec<DirectoryEntry>,
    },
    SessionClosed {
        session_id: String,
    },
    Error {
        message: String,
    },
    /// Whether this session survives the daemon, and why not when it does not.
    ///
    /// Reported rather than assumed: a durability guarantee that silently is
    /// not one is worse than no guarantee, because the user acts on it — they
    /// leave an agent running and close the lid.
    SessionMode {
        session_id: String,
        durable: bool,
        detail: Option<String>,
    },
    SessionListing {
        request_id: String,
        sessions: Vec<RecoverableSession>,
    },
    WorktreeCreated {
        request_id: String,
        path: Option<String>,
        branch: Option<String>,
        error: Option<String>,
    },
    Pong,
}

type SessionsMap = Arc<RwLock<HashMap<String, Arc<PtySession>>>>;
type UsageHandle = Arc<usage::service::UsageService>;

/// Where the daemon listens.
///
/// This protocol is local-only; it does not provide TLS for remote access.
fn listen_addr(host: Option<String>, port: Option<String>) -> String {
    let host = host.unwrap_or_else(|| "127.0.0.1".to_string());
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };
    format!("{}:{}", host, port.unwrap_or_else(|| "1421".to_string()))
}

const CLI_ARTIFACT_SCRIPT: &str = include_str!("../../tools/agent-hooks/doom-term-artifact.sh");
/// The hook this platform can actually run.
///
/// The POSIX hook needs `sh`, GNU `timeout` and `curl` on PATH. A stock Windows
/// has none of the first two, and Claude Code's native Windows build no longer
/// requires Git for Windows — so provisioning the .sh there writes a file that
/// can never fire, and the agent well stays dark for a reason nothing reports.
/// The .ps1 sibling keeps the same bounded-critical-path contract.
#[cfg(not(windows))]
const HOOK_SCRIPT: &str = include_str!("../../tools/agent-hooks/doom-term-hook.sh");
#[cfg(windows)]
const HOOK_SCRIPT: &str = include_str!("../../tools/agent-hooks/doom-term-hook.ps1");

#[cfg(not(windows))]
const HOOK_SCRIPT_NAME: &str = "doom-term-hook.sh";
#[cfg(windows)]
const HOOK_SCRIPT_NAME: &str = "doom-term-hook.ps1";

/// When a daemon that nobody is connected to should stop.
///
/// ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
///
/// On Linux and macOS the tmux substrate is what survives: the shell is nobody's
/// child of ours, so the daemon can come and go. Windows has no tmux, and the
/// ConPTY dies with the daemon — so there, and only there, the daemon itself has
/// to be the thing that outlives the window. Closing Doom Term and reopening it
/// should find the agent still working.
///
/// The cost of that is a process with no window, which is exactly the kind of
/// thing that gets forgotten. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` means a
/// forgotten daemon is a forgotten agent still burning tokens, so the grace is
/// bounded: reopen within it and the session is there, walk away and the daemon
/// exits and takes the tree with it — which is exactly today's behaviour, just
/// deferred.
///
/// ── WHY AN ENV VAR AND NOT `cfg(windows)` ──────────────────────────────────
///
/// Compiling this only for Windows would make it untestable from a Linux host,
/// and the failure mode is severe: a miscount exits a daemon somebody is
/// actively using and every session dies at once. Gating on a variable the
/// Tauri shell sets means the logic runs, and is tested, everywhere — while
/// staying inert for `npm run server`, which must not disappear from under a
/// developer.
struct IdleWatch {
    live: std::sync::atomic::AtomicUsize,
    /// When the last client left, or when the daemon started and none ever
    /// arrived. `None` while somebody is connected.
    alone_since: parking_lot::Mutex<Option<std::time::Instant>>,
    grace: Duration,
}

impl IdleWatch {
    fn new(grace: Duration, now: std::time::Instant) -> Self {
        // A daemon nobody ever connects to must not live forever either, so the
        // clock starts at boot rather than at the first disconnect.
        Self {
            live: std::sync::atomic::AtomicUsize::new(0),
            alone_since: parking_lot::Mutex::new(Some(now)),
            grace,
        }
    }

    fn joined(&self) {
        self.live.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.alone_since.lock() = None;
    }

    fn left(&self, now: std::time::Instant) {
        // fetch_sub returns the PREVIOUS value, so 1 means this was the last.
        if self.live.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) == 1 {
            *self.alone_since.lock() = Some(now);
        }
    }

    fn should_exit(&self, now: std::time::Instant) -> bool {
        if self.live.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            return false;
        }
        match *self.alone_since.lock() {
            Some(since) => now.duration_since(since) >= self.grace,
            None => false,
        }
    }
}

/// Decrements on every exit path, including a panic in the connection handler.
///
/// Without this a handler that panicked would leave the count permanently above
/// zero and the daemon would never exit. Leaking upward is the safe direction,
/// but "safe" here means "never reclaims", which is not a state to design for.
struct ClientGuard(Option<Arc<IdleWatch>>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        if let Some(watch) = &self.0 {
            watch.left(std::time::Instant::now());
        }
    }
}

#[cfg(test)]
mod idle_watch_tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn a_daemon_nobody_ever_connects_to_still_exits() {
        // The clock starts at boot, not at the first disconnect: otherwise a
        // daemon spawned by a window that never opened would live forever.
        let now = Instant::now();
        let watch = IdleWatch::new(Duration::from_secs(60), now);
        assert!(!watch.should_exit(now));
        assert!(watch.should_exit(now + Duration::from_secs(60)));
    }

    #[test]
    fn a_connected_client_keeps_the_daemon_alive_indefinitely() {
        // The severe failure this guards: exiting under somebody who is working.
        let now = Instant::now();
        let watch = IdleWatch::new(Duration::from_secs(60), now);
        watch.joined();
        assert!(!watch.should_exit(now + Duration::from_secs(60 * 60 * 24)));
    }

    #[test]
    fn the_grace_starts_when_the_last_client_leaves_not_the_first() {
        let start = Instant::now();
        let watch = IdleWatch::new(Duration::from_secs(60), start);
        watch.joined();
        watch.joined();

        let first_left = start + Duration::from_secs(10);
        watch.left(first_left);
        assert!(
            !watch.should_exit(first_left + Duration::from_secs(120)),
            "one of two clients leaving is not an idle daemon"
        );

        let last_left = start + Duration::from_secs(20);
        watch.left(last_left);
        assert!(!watch.should_exit(last_left + Duration::from_secs(59)));
        assert!(watch.should_exit(last_left + Duration::from_secs(60)));
    }

    #[test]
    fn reconnecting_inside_the_grace_cancels_the_exit() {
        // This is the whole feature: close the window, reopen it, find the
        // agent still working.
        let start = Instant::now();
        let watch = IdleWatch::new(Duration::from_secs(60), start);
        watch.joined();
        watch.left(start + Duration::from_secs(1));
        watch.joined();
        assert!(!watch.should_exit(start + Duration::from_secs(600)));
    }

    #[test]
    fn the_guard_decrements_even_if_the_handler_unwinds() {
        let start = Instant::now();
        let watch = Arc::new(IdleWatch::new(Duration::from_secs(60), start));
        watch.joined();
        // AssertUnwindSafe because parking_lot::Mutex is not RefUnwindSafe.
        // Sound here: the panic is raised before the guard touches anything, and
        // the assertion below is precisely that the mutex is left consistent.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
            let watch = watch.clone();
            move || {
                let _guard = ClientGuard(Some(watch));
                panic!("a connection handler died");
            }
        }));
        assert!(result.is_err());
        // Without the Drop guard the count would still be 1 here and the daemon
        // would never reclaim itself.
        assert!(watch.should_exit(Instant::now() + Duration::from_secs(120)));
    }
}

fn provision_cli_tools() {
    let Some(home) = pty::home_dir() else {
        return;
    };

    let targets = [
        home.join(".local").join("bin").join("doom-term-artifact"),
        home.join(".doom-term")
            .join("bin")
            .join("doom-term-artifact"),
        home.join(".doom-term")
            .join("agent-hooks")
            .join("doom-term-artifact.sh"),
    ];

    for target in &targets {
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(existing) = std::fs::read_to_string(target) {
            if existing == CLI_ARTIFACT_SCRIPT {
                continue;
            }
        }
        let tmp = target.with_extension(format!("tmp-{}", std::process::id()));
        if std::fs::write(&tmp, CLI_ARTIFACT_SCRIPT).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
            }
            let _ = std::fs::rename(&tmp, target);
            log::info!("Provisioned CLI artifact helper at {:?}", target);
        }
    }

    let hook_targets = [home
        .join(".doom-term")
        .join("agent-hooks")
        .join(HOOK_SCRIPT_NAME)];
    for target in &hook_targets {
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(existing) = std::fs::read_to_string(target) {
            if existing == HOOK_SCRIPT {
                continue;
            }
        }
        let tmp = target.with_extension(format!("tmp-{}", std::process::id()));
        if std::fs::write(&tmp, HOOK_SCRIPT).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
            }
            let _ = std::fs::rename(&tmp, target);
            log::info!("Provisioned agent hook at {:?}", target);
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));
    // Before anything is spawned. The directory the daemon is launched in is
    // not ours to keep — under an AppImage it is the FUSE mount, and it is
    // unmounted the moment the app exits while the tmux server started from it
    // lives on. See `anchor_working_directory`.
    log::info!(
        "working directory anchored at {}",
        pty::anchor_working_directory().display()
    );
    if let Ok(host) = std::env::var("DOOM_HOST") {
        anyhow::ensure!(
            security::loopback_host(&host),
            "DOOM_HOST must be a loopback address; remote terminal access is unsupported"
        );
    }
    let addr = listen_addr(
        std::env::var("DOOM_HOST").ok(),
        std::env::var("DOOM_PORT").ok(),
    );
    let listener = TcpListener::bind(&addr).await?;
    log::info!(
        "⚡ Doom Term PTY WebSocket Server listening on ws://{}",
        listener.local_addr()?
    );
    provision_cli_tools();

    let server = Arc::new(gateway::Gateway::new()?);
    let sessions = server.sessions.clone();
    let usage = server.usage.clone();
    tokio::spawn(server.clone().maintain());

    // Set by the Tauri shell on Windows, where the daemon has to outlive the
    // window because there is no tmux to hold the session. Unset everywhere
    // else, including `npm run server`.
    let idle: Option<Arc<IdleWatch>> = std::env::var("DOOM_TERM_IDLE_EXIT_SECS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(|secs| {
            log::info!("daemon will exit after {secs}s with no connected client");
            Arc::new(IdleWatch::new(
                Duration::from_secs(secs),
                std::time::Instant::now(),
            ))
        });
    if let Some(watch) = idle.clone() {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if watch.should_exit(std::time::Instant::now()) {
                    log::info!("no client for the grace period; daemon exiting");
                    std::process::exit(0);
                }
            }
        });
    }

    // Rate-limit usage refreshes on its own timer, never on the request path:
    // GetTelemetry is polled every 2 s and must not wait on an HTTPS round-trip.
    {
        let usage = usage.clone();
        let sessions = sessions.clone();
        tokio::spawn(async move {
            loop {
                // The poll gate has two halves. `due()` is the request rate —
                // at most one read per REFRESH_INTERVAL, counting failures. The
                // foreground check is the reason to ask at all: no Claude in the
                // foreground means nothing to report, and polling a quota
                // endpoint on a timer for an idle shell is rude.
                // ANY session, not the first one: the cache is shared across
                // tabs, so one Claude anywhere is reason enough to refresh it.
                let snapshot: Vec<_> = sessions.read().values().cloned().collect();
                let is_claude = tokio::task::spawn_blocking(move || {
                    snapshot
                        .into_iter()
                        .filter_map(|session| session.foreground_command())
                        .filter_map(|comm| pty::classify_agent(&comm))
                        .any(|agent| agent.key == "claude")
                })
                .await
                .unwrap_or(false);

                if is_claude && usage.due() {
                    let usage = usage.clone();
                    // ureq is blocking; keep it off the async runtime's threads.
                    let _ = tokio::task::spawn_blocking(move || usage.refresh_blocking()).await;
                }

                tokio::time::sleep(usage::service::GATE_TICK).await;
            }
        });
    }

    loop {
        match listener.accept().await {
            Ok((stream, client_addr)) => {
                let server = server.clone();
                let idle = idle.clone();
                tokio::spawn(async move {
                    if let Some(watch) = &idle {
                        watch.joined();
                    }
                    let _guard = ClientGuard(idle);
                    handle_connection(stream, client_addr, server).await;
                });
            }
            Err(e) => {
                log::warn!("Listener accept error (retrying): {:?}", e);
                tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            }
        }
    }
}

/// What a hook script POSTs. Everything is optional because the vendors do not
/// agree on field names and a missing field must never drop the event — knowing
/// that SOMETHING is blocked is most of the value.
#[derive(Debug, Deserialize)]
struct HookPost {
    agent: Option<String>,
    #[serde(alias = "hook_event_name", alias = "event_name", alias = "type")]
    event: Option<String>,
    cwd: Option<String>,
    #[serde(alias = "session_id")]
    agent_session_id: Option<String>,
    /// Where the agent is writing its own transcript.
    ///
    /// The only field in the payload that comes from inside the agent's own
    /// process, and therefore the only way to tell two agents in one directory
    /// apart — which is precisely the case both context readers give up on.
    /// See `usage/hint.rs`.
    #[serde(alias = "transcriptPath", alias = "transcript")]
    transcript_path: Option<String>,
}

#[cfg(test)]
type HookState = Arc<hooks::HookHub>;
#[cfg(test)]
fn remember_hook_state(state: &HookState, message: &ServerMessage) {
    state.publish(message.clone(), None);
}

/// The pane an agent is running in, as reported by the hook script.
///
/// See `doom_term_pty::session::SESSION_ID_ENV` for the other end of this.
const DOOM_SESSION_HEADER: &str = "x-doom-term-session";

/// One header's value from a raw request, matched case-insensitively.
fn header_value(request: &str, name: &str) -> Option<String> {
    let head = request.split("\r\n\r\n").next()?;
    head.lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.trim().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Receive one agent hook event and fan it out to every connected client.
///
/// Deliberately unauthenticated and bound to loopback only: the poster is a
/// shell script the user installed, running as the user, on the same machine.
/// Adding a token would mean writing it somewhere the script can read, which is
/// the same trust boundary with more moving parts.
///
/// Always answers 204, even for a body it could not parse. The caller is a hook
/// in the agent's critical path — a non-2xx or a hang there is a paused agent,
/// and no telemetry is worth that.
async fn serve_hook(
    mut stream: TcpStream,
    hooks: &hooks::HookHub,
    path_agent: Option<String>,
    sessions: &SessionsMap,
) {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];

    // Read until the body is complete or the peer stops. Bounded so a wedged
    // client cannot grow this without limit.
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(500);
    loop {
        if buf.len() > 64 * 1024 {
            break;
        }
        let read = tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await;
        match read {
            Ok(Ok(0)) | Err(_) => break,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf);
                if let Some(headers_end) = text.find("\r\n\r\n") {
                    let body_len = text[..headers_end]
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.trim()
                                .eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if buf.len() >= headers_end + 4 + body_len {
                        break;
                    }
                }
            }
            Ok(Err(_)) => break,
        }
    }

    let text = String::from_utf8_lossy(&buf).into_owned();
    // Hooks are native shell requests. A browser's simple POST can mutate
    // state even when CORS prevents it reading the response.
    let head = text.split("\r\n\r\n").next().unwrap_or("");
    let browser_request = head
        .lines()
        .skip(1)
        .filter_map(|l| l.split_once(':'))
        .any(|(k, _)| k.eq_ignore_ascii_case("origin") || k.eq_ignore_ascii_case("sec-fetch-site"));
    let host_ok = stream.local_addr().ok().is_some_and(|addr| {
        header_value(&text, "host").is_some_and(|h| security::trusted_host(&h, addr.port()))
    });
    if browser_request || !host_ok {
        let _ = stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return;
    }
    // Read from the raw headers, NOT from the peeked request line: that one is
    // lowercased for routing, and a session id is case-sensitive.
    let doom_session_id = header_value(&text, DOOM_SESSION_HEADER);
    let incarnation = header_value(&text, "x-doom-term-incarnation")
        .and_then(|value| pty::stream::Identity::try_from(value).ok());
    // A pane name is reusable. Only the exact durable/direct process identity
    // may teach telemetry where its transcript lives; an old hook landing
    // after replacement must not describe the new foreground process.
    let attributed_session = doom_session_id
        .as_ref()
        .zip(incarnation.as_ref())
        .and_then(|(id, expected)| {
            sessions
                .read()
                .get(id)
                .cloned()
                .map(|session| (session, expected))
        })
        .filter(|(session, expected)| {
            &session.stream().snapshot().metadata.incarnation == *expected
        })
        .map(|(session, _)| session);
    if let Some(body) = text.split("\r\n\r\n").nth(1) {
        if let Ok(post) = serde_json::from_str::<HookPost>(body.trim_end_matches(char::from(0))) {
            // Recorded before the event is fanned out, so a Stop that arrives
            // with a transcript path still teaches us where that agent writes.
            if let (Some(cwd), Some(path)) = (post.cwd.as_deref(), post.transcript_path.as_deref())
            {
                let agent = post
                    .agent
                    .as_deref()
                    .or(path_agent.as_deref())
                    .unwrap_or("");
                let process = attributed_session
                    .as_ref()
                    .and_then(|s| s.shell_pid())
                    .and_then(pty::foreground::foreground_identity);
                usage::hint::remember(agent, cwd, doom_session_id.as_deref(), process, path);
                log::info!("hook: transcript for {agent} in {cwd} -> {path}");
            }

            let msg = ServerMessage::AgentEvent {
                // The vendors do not put their own name in the payload, so it
                // comes from the URL the hook script posts to: /hook/claude.
                // Taken from the path rather than injected into the JSON,
                // because rewriting arbitrary JSON in POSIX shell is a bug farm.
                agent: post
                    .agent
                    .or(path_agent)
                    .unwrap_or_else(|| "unknown".into()),
                event: post.event.unwrap_or_else(|| "unknown".into()),
                cwd: post.cwd,
                agent_session_id: post.agent_session_id,
                doom_session_id,
            };
            hooks.publish(msg, incarnation);
        }
    }

    let _ = stream
        .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
        .await;
    let _ = stream.flush().await;
}

async fn serve_artifact_post(
    mut stream: TcpStream,
    artifacts: &Arc<crate::artifacts::ArtifactHub>,
) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(2500);
    loop {
        if buf.len() > 4 * 1024 * 1024 + 8192 {
            break;
        }
        let read = tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await;
        match read {
            Ok(Ok(0)) | Err(_) => break,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf);
                if let Some(headers_end) = text.find("\r\n\r\n") {
                    let body_len = text[..headers_end]
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.trim()
                                .eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if buf.len() >= headers_end + 4 + body_len {
                        break;
                    }
                }
            }
            Ok(Err(_)) => break,
        }
    }

    let text = String::from_utf8_lossy(&buf).into_owned();
    let host_ok = stream.local_addr().ok().is_some_and(|addr| {
        header_value(&text, "host").is_some_and(|h| security::trusted_host(&h, addr.port()))
    });
    if !host_ok {
        let _ = stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return;
    }

    let session_id = header_value(&text, DOOM_SESSION_HEADER);
    if let Some(body) = text.split("\r\n\r\n").nth(1) {
        let clean_body = body.trim_end_matches(char::from(0));
        match serde_json::from_str::<crate::artifacts::ArtifactPost>(clean_body) {
            Ok(post) => match artifacts.publish_or_update(post, session_id) {
                Ok((record, _)) => {
                    let resp_body = serde_json::json!({
                        "id": record.id,
                        "title": record.title,
                        "type": record.artifact_type,
                        "version": record.version,
                        "url": format!("http://127.0.0.1:1421/artifact/{}", record.id)
                    });
                    let resp_bytes = serde_json::to_vec(&resp_body).unwrap();
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        resp_bytes.len()
                    );
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(&resp_bytes).await;
                    let _ = stream.flush().await;
                    return;
                }
                Err(err) => {
                    let resp_body = serde_json::json!({ "error": err });
                    let resp_bytes = serde_json::to_vec(&resp_body).unwrap();
                    let header = format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        resp_bytes.len()
                    );
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(&resp_bytes).await;
                    let _ = stream.flush().await;
                    return;
                }
            },
            Err(err) => {
                let resp_body = serde_json::json!({ "error": format!("Invalid JSON: {}", err) });
                let resp_bytes = serde_json::to_vec(&resp_body).unwrap();
                let header = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    resp_bytes.len()
                );
                let _ = stream.write_all(header.as_bytes()).await;
                let _ = stream.write_all(&resp_bytes).await;
                let _ = stream.flush().await;
                return;
            }
        }
    }

    let _ = stream
        .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
        .await;
    let _ = stream.flush().await;
}

async fn serve_artifact_list(
    mut stream: TcpStream,
    artifacts: &Arc<crate::artifacts::ArtifactHub>,
) {
    let mut drain = [0u8; 4096];
    let _ = stream.read(&mut drain).await;
    let list = artifacts.list();
    let body_bytes = serde_json::to_vec(&list).unwrap_or_default();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body_bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(&body_bytes).await;
    let _ = stream.flush().await;
}

async fn serve_artifact_get(
    mut stream: TcpStream,
    artifacts: &Arc<crate::artifacts::ArtifactHub>,
    raw_head: &str,
) {
    let mut drain = [0u8; 4096];
    let _ = stream.read(&mut drain).await;
    let path = raw_head.split_whitespace().nth(1).unwrap_or("");
    let rest = path.strip_prefix("/artifact/").unwrap_or("");
    let is_raw = rest.ends_with("/raw");
    let id = if is_raw {
        rest.trim_end_matches("/raw")
    } else {
        rest
    };

    if let Some(record) = artifacts.get(id) {
        if is_raw {
            let body_bytes = record.content.as_bytes();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body_bytes.len()
            );
            let _ = stream.write_all(header.as_bytes()).await;
            let _ = stream.write_all(body_bytes).await;
            let _ = stream.flush().await;
        } else {
            let html = artifacts.render_standalone_page(&record);
            let body_bytes = html.as_bytes();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body_bytes.len()
            );
            let _ = stream.write_all(header.as_bytes()).await;
            let _ = stream.write_all(body_bytes).await;
            let _ = stream.flush().await;
        }
    } else {
        let not_found = format!(
            "<!DOCTYPE html><html><body style=\"background:#14120f;color:#d8cbb0;font-family:monospace;padding:24px;\"><h3>Artifact not found</h3><p>Artifact '{}' does not exist or has expired.</p><p><a style=\"color:#e0a92c;\" href=\"/artifacts\">View all active artifacts</a></p></body></html>",
            id
        );
        let header = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            not_found.len()
        );
        let _ = stream.write_all(header.as_bytes()).await;
        let _ = stream.write_all(not_found.as_bytes()).await;
        let _ = stream.flush().await;
    }
}

/// Server-Sent Events for a single artifact: an id and a version, nothing else.
///
/// A standalone artifact page cannot use the terminal WebSocket, because
/// `security::trusted_origin` refuses the daemon's own origin — and it must keep
/// refusing it, since an `html` artifact is agent-authored JavaScript and that
/// socket drives PTYs. This stream is the narrow grant that replaces it:
/// same-origin only (no CORS header), scoped to one artifact, and carrying no
/// content a same-origin fetch could not already read.
async fn serve_artifact_events(
    mut stream: TcpStream,
    artifacts: &Arc<crate::artifacts::ArtifactHub>,
    id: &str,
) {
    let mut drain = [0u8; 4096];
    let _ = stream.read(&mut drain).await;

    if artifacts.get(id).is_none() {
        let body = format!("Artifact '{id}' does not exist or has expired.");
        let header = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes()).await;
        let _ = stream.write_all(body.as_bytes()).await;
        let _ = stream.flush().await;
        return;
    }

    let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n\r\n";
    if stream.write_all(header.as_bytes()).await.is_err() {
        return;
    }

    // Subscribe before priming. The reverse order drops an update that lands in
    // between, leaving the page on stale content until a human reloads it.
    let mut events = artifacts.subscribe_events();
    if let Some(current) = artifacts.get(id) {
        if write_artifact_event(&mut stream, &current.id, current.version)
            .await
            .is_err()
        {
            return;
        }
    }

    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(20));
    keepalive.tick().await; // the first tick completes immediately

    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok((record, _)) => {
                    if record.id != id {
                        continue;
                    }
                    if write_artifact_event(&mut stream, &record.id, record.version)
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                // A dropped broadcast may have carried this artifact. The store
                // holds the truth, so resend that instead of guessing.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let Some(current) = artifacts.get(id) else {
                        return;
                    };
                    if write_artifact_event(&mut stream, &current.id, current.version)
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            },
            _ = keepalive.tick() => {
                // A comment frame. Its only job is to turn a departed client into
                // a write error, so this task stops parking on a dead socket.
                if stream.write_all(b": keepalive\n\n").await.is_err() {
                    return;
                }
                if stream.flush().await.is_err() {
                    return;
                }
            }
        }
    }
}

async fn write_artifact_event(
    stream: &mut TcpStream,
    id: &str,
    version: u32,
) -> std::io::Result<()> {
    let payload = serde_json::json!({ "id": id, "version": version });
    stream
        .write_all(format!("data: {payload}\n\n").as_bytes())
        .await?;
    stream.flush().await
}

async fn serve_cli_artifact_script(mut stream: TcpStream) {
    let mut drain = [0u8; 4096];
    let _ = stream.read(&mut drain).await;
    let bytes = CLI_ARTIFACT_SCRIPT.as_bytes();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/x-shellscript; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(bytes).await;
    let _ = stream.flush().await;
}

async fn serve_cli_hook_script(mut stream: TcpStream) {
    let mut drain = [0u8; 4096];
    let _ = stream.read(&mut drain).await;
    let bytes = HOOK_SCRIPT.as_bytes();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/x-shellscript; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(bytes).await;
    let _ = stream.flush().await;
}

async fn handle_connection(
    stream: TcpStream,
    client_addr: SocketAddr,
    server: Arc<gateway::Gateway>,
) {
    handle_connection_authenticated(
        stream,
        client_addr,
        server,
        std::env::var("DOOM_AUTH_TOKEN")
            .ok()
            .filter(|s| !s.is_empty()),
    )
    .await;
}

async fn handle_connection_authenticated(
    mut stream: TcpStream,
    client_addr: SocketAddr,
    server: Arc<gateway::Gateway>,
    required_token: Option<String>,
) {
    let port = match stream.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => return,
    };
    let Some(head) = security::request_head(&stream).await else {
        return;
    };
    let peek_str = head.to_lowercase();
    let is_ws = header_value(&head, "upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"));

    if peek_str.starts_with("post /artifact") {
        serve_artifact_post(stream, &server.artifacts).await;
        return;
    }

    if peek_str.starts_with("get /artifacts") {
        serve_artifact_list(stream, &server.artifacts).await;
        return;
    }

    if peek_str.starts_with("get /artifact/") {
        // Ids are case-sensitive, so the id comes off the raw head rather than
        // the lowercased copy the routing match uses.
        let path = head.split_whitespace().nth(1).unwrap_or("");
        if let Some(id) = path
            .strip_prefix("/artifact/")
            .and_then(|rest| rest.strip_suffix("/events"))
        {
            serve_artifact_events(stream, &server.artifacts, id).await;
            return;
        }
        serve_artifact_get(stream, &server.artifacts, &head).await;
        return;
    }

    if peek_str.starts_with("get /doom-term-artifact")
        || peek_str.starts_with("get /cli/doom-term-artifact")
    {
        serve_cli_artifact_script(stream).await;
        return;
    }

    if peek_str.starts_with("get /doom-term-hook")
        || peek_str.starts_with("get /cli/doom-term-hook")
    {
        serve_cli_hook_script(stream).await;
        return;
    }

    if peek_str.starts_with("post /hook") {
        // "POST /hook/claude HTTP/1.1" -> Some("claude")
        let agent = peek_str
            .split_whitespace()
            .nth(1)
            .and_then(|p| p.strip_prefix("/hook/"))
            .map(|a| a.trim_end_matches('/').to_string())
            .filter(|a| !a.is_empty());
        serve_hook(stream, &server.hooks, agent, &server.sessions).await;
        return;
    }

    if !is_ws {
        // Standard HTTP GET request: respond with friendly HTML redirect to port 1420
        let html_body = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0; url=http://localhost:1420">
  <title>Doom Term</title>
  <style>
    body { background: #121212; color: #f0f0f0; font-family: monospace; text-align: center; padding-top: 15vh; margin: 0; }
    h1 { color: #d49b00; font-size: 2.2rem; margin-bottom: 10px; }
    p { color: #888888; font-size: 1rem; line-height: 1.6; }
    .card { max-width: 500px; margin: 0 auto; background: #1a1a1a; padding: 30px; border: 2px solid #3c3c3c; border-radius: 8px; box-shadow: inset 2px 2px 0 rgba(255,255,255,0.1), inset -2px -2px 0 rgba(0,0,0,0.8); }
    .btn { display: inline-block; margin-top: 24px; padding: 12px 28px; background: #d49b00; color: #000; text-decoration: none; font-weight: bold; border-radius: 4px; font-size: 1.1rem; box-shadow: 0 4px 6px rgba(0,0,0,0.4); }
    .btn:hover { background: #ffd700; transform: scale(1.02); }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚡ DOOM TERM</h1>
    <p>PTY WebSocket Server is running on port <strong>1421</strong>.</p>
    <p>The interactive Web Terminal UI is hosted on port <strong>1420</strong>.</p>
    <a class="btn" href="http://localhost:1420">👉 CLICK TO OPEN DOOM TERM UI (Port 1420)</a>
  </div>
</body>
</html>"#;

        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html_body.len(),
            html_body
        );

        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.flush().await;
        return;
    }

    log::info!("Client WebSocket connected from {}", client_addr);
    server.accept(stream, port, required_token).await;
}
