use doom_term_pty as pty;

mod hooks;
mod metadata;
mod security;
mod usage;
mod worktree;

// Public v2 transport; there is no legacy wire fallback.
mod attachments;
mod outbound;
mod protocol;
mod recovery;
#[cfg(test)]
mod recovery_tests;
mod tombstones;

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

#[cfg(any())]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", content = "payload")]
pub enum ClientMessage {
    Auth {
        token: String,
    },
    Spawn {
        id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
    },
    Reattach {
        id: String,
    },
    Write {
        id: String,
        data: String,
    },
    Paste {
        request_id: String,
        id: String,
        text: String,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Signal {
        id: String,
        signal: String,
    },
    Kill {
        id: String,
    },
    BrowseDirectory {
        /// Echoed back on the reply. Without it the client matched replies to
        /// requests by arrival order, which desynchronised permanently the
        /// first time a request was dropped.
        request_id: String,
        path: Option<String>,
    },
    ListSessions {
        request_id: String,
    },
    CreateWorktree {
        request_id: String,
        cwd: String,
        branch: String,
    },
    GetTelemetry {
        /// Directory to report on. The daemon's own process directory is not a
        /// useful answer: it never changes when a session runs `cd`.
        cwd: Option<String>,
        /// Which session to describe. Telemetry is per-session — the foreground
        /// process, and therefore the agent, differs per tab — so without this
        /// the daemon answered about whichever session happened to be first in
        /// the map, and the plate could describe a tab that is not on screen.
        #[serde(default)]
        session_id: Option<String>,
    },
    Ping,
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

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));
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

    let server = Arc::new(recovery::RecoveryServer::new()?);
    let sessions = server.sessions.clone();
    let usage = server.usage.clone();
    tokio::spawn(server.clone().maintain());

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
                tokio::spawn(handle_connection(stream, client_addr, server.clone()));
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

async fn handle_connection(
    stream: TcpStream,
    client_addr: SocketAddr,
    server: Arc<recovery::RecoveryServer>,
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
    server: Arc<recovery::RecoveryServer>,
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

#[cfg(any())]
fn handle_client_msg(
    msg: ClientMessage,
    sessions: &SessionsMap,
    usage: &UsageHandle,
    tx: &tokio::sync::mpsc::UnboundedSender<ServerMessage>,
) {
    match msg {
        ClientMessage::CreateWorktree {
            request_id,
            cwd,
            branch,
        } => {
            let tx = tx.clone();
            tokio::task::spawn_blocking(move || {
                let result = worktree::create(&pty::session::expand_path(&cwd), &branch);
                let (path, branch, error) = match result {
                    Ok(path) => (
                        Some(path.to_string_lossy().into_owned()),
                        Some(branch),
                        None,
                    ),
                    Err(error) => (None, None, Some(error.to_string())),
                };
                let _ = tx.send(ServerMessage::WorktreeCreated {
                    request_id,
                    path,
                    branch,
                    error,
                });
            });
        }
        ClientMessage::Auth { token } => {
            let required = std::env::var("DOOM_AUTH_TOKEN").unwrap_or_default();
            let success = required.is_empty() || token == required;
            let _ = tx.send(ServerMessage::AuthResult {
                success,
                message: if success {
                    "Authenticated to Doom Term gateway".to_string()
                } else {
                    "Invalid authentication token".to_string()
                },
            });
        }
        ClientMessage::Spawn {
            id,
            cols,
            rows,
            cwd,
            shell,
        } => {
            // Spawning an id we already hold is a RECONNECT, not a new terminal.
            //
            // The client re-sends Spawn on every page load, because its own
            // record of what it spawned dies with the page. Treating that as a
            // fresh session was the single worst bug in the app: tmux is started
            // with `new-session -A`, which ATTACHES when the session exists, so
            // each reload added another client to the same pane. Three clients
            // in, tmux is blocking on a write to a pty nobody drains and the
            // terminal freezes — the shell still receives every keystroke and
            // echoes it, and not one byte reaches the screen.
            //
            // Rebinding is the whole fix: point the live session at this
            // connection, resize it to this client's grid, and replay what it
            // has. Everything below this branch is for ids we have never seen.
            // A dead entry is not a session to rebind — it is a corpse.
            //
            // Nothing used to remove a session whose process had exited, so a
            // later Spawn found the stale entry, rebound it, replayed its ring
            // and returned WITHOUT starting anything. The pane then showed a
            // scrollback with no shell behind it and never accepted a command.
            let existing = sessions
                .read()
                .get(&id)
                .filter(|session| session.is_alive())
                .cloned();
            if existing.is_none() {
                sessions.write().remove(&id);
            }
            if let Some(session) = existing {
                let tx_clone = tx.clone();
                let session_id_clone = id.clone();
                session.rebind(
                    move |event| {
                        let _ = tx_clone.send(ServerMessage::PtyEvent {
                            session_id: session_id_clone.clone(),
                            event,
                        });
                    },
                    {
                        let tx = tx.clone();
                        let id = id.clone();
                        let sessions = sessions.clone();
                        move || {
                            sessions.write().remove(&id);
                            let _ = tx.send(ServerMessage::SessionClosed {
                                session_id: id.clone(),
                            });
                        }
                    },
                );
                let _ = session.resize(cols, rows);
                let _ = tx.send(ServerMessage::SessionMode {
                    session_id: id.clone(),
                    durable: session.is_durable(),
                    detail: session.durability_detail(),
                });
                for event in session.get_replay_events() {
                    let _ = tx.send(ServerMessage::PtyEvent {
                        session_id: id.clone(),
                        event,
                    });
                }
                return;
            }

            let tx_clone = tx.clone();
            let session_id_clone = id.clone();
            match PtySession::spawn(
                id.clone(),
                cols,
                rows,
                cwd,
                shell,
                move |event| {
                    let _ = tx_clone.send(ServerMessage::PtyEvent {
                        session_id: session_id_clone.clone(),
                        event,
                    });
                },
                {
                    let tx_clone = tx.clone();
                    let session_id_clone = id.clone();
                    let sessions_clone = sessions.clone();
                    move || {
                        // Drop it here, not merely announce it. Leaving the
                        // entry behind is what made ListSessions advertise
                        // exited shells as recoverable.
                        sessions_clone.write().remove(&session_id_clone);
                        let _ = tx_clone.send(ServerMessage::SessionClosed {
                            session_id: session_id_clone.clone(),
                        });
                    }
                },
            ) {
                Ok(session) => {
                    let _ = tx.send(ServerMessage::SessionMode {
                        session_id: id.clone(),
                        durable: session.is_durable(),
                        detail: session.durability_detail(),
                    });
                    sessions.write().insert(id, Arc::new(session));
                }
                Err(e) => {
                    let _ = tx.send(ServerMessage::Error {
                        message: format!("Failed to spawn PTY session: {}", e),
                    });
                }
            }
        }
        ClientMessage::Reattach { id } => {
            if let Some(session) = sessions.read().get(&id) {
                let replay = session.get_replay_events();
                for event in replay {
                    let _ = tx.send(ServerMessage::PtyEvent {
                        session_id: id.clone(),
                        event,
                    });
                }
            }
        }
        ClientMessage::Write { id, data } => {
            if let Some(session) = sessions.read().get(&id) {
                if let Err(e) = session.write(data.as_bytes()) {
                    let _ = tx.send(ServerMessage::Error {
                        message: format!("Write error: {}", e),
                    });
                }
            }
        }
        ClientMessage::Paste {
            request_id,
            id,
            text,
        } => {
            // Admission precedes buffering/work submission. Hold an Arc to the
            // exact live session: never re-look up an id after it is replaced.
            let session = sessions
                .read()
                .get(&id)
                .filter(|session| session.is_alive())
                .cloned();
            let error = if text.len() > pty::paste::MAX_PASTE_BYTES {
                Some("Paste exceeds the 1 MiB limit".to_owned())
            } else if session.is_none() {
                Some("Session is unavailable; paste was not sent".to_owned())
            } else {
                None
            };
            if error.is_some() {
                let _ = tx.send(ServerMessage::PasteResult {
                    request_id,
                    session_id: id,
                    error,
                });
                return;
            }
            let tx = tx.clone();
            tokio::task::spawn_blocking(move || {
                let error = session
                    .unwrap()
                    .paste(&text)
                    .err()
                    .map(|error| error.to_string());
                let _ = tx.send(ServerMessage::PasteResult {
                    request_id,
                    session_id: id,
                    error,
                });
            });
        }
        ClientMessage::Resize { id, cols, rows } => {
            if let Some(session) = sessions.read().get(&id) {
                let _ = session.resize(cols, rows);
            }
        }
        ClientMessage::Signal { id, signal } => {
            if let Some(session) = sessions.read().get(&id) {
                let _ = session.send_signal(&signal);
            }
        }
        ClientMessage::Kill { id } => {
            if let Some(session) = sessions.write().remove(&id) {
                let _ = session.kill();
            }
        }
        ClientMessage::BrowseDirectory { request_id, path } => {
            let target_str = path.unwrap_or_else(|| "~".to_string());
            let target_path = pty::session::expand_path(&target_str);
            let dir = if target_path.exists() && target_path.is_dir() {
                target_path
            } else if let Ok(home) = std::env::var("HOME") {
                std::path::PathBuf::from(home)
            } else {
                std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"))
            };

            let current_path = dir.to_string_lossy().to_string();
            let parent_path = dir.parent().map(|p| p.to_string_lossy().to_string());

            let mut entries = Vec::new();
            if let Ok(read_dir) = std::fs::read_dir(&dir) {
                for entry in read_dir.flatten() {
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    if file_name.starts_with('.') && file_name != ".git" {
                        continue;
                    }
                    let path_buf = entry.path();
                    let is_dir = path_buf.is_dir();
                    let is_git_repo = is_dir && path_buf.join(".git").exists();
                    entries.push(DirectoryEntry {
                        name: file_name,
                        path: path_buf.to_string_lossy().to_string(),
                        is_dir,
                        is_git_repo,
                    });
                }
            }

            entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });

            let _ = tx.send(ServerMessage::DirectoryListing {
                request_id,
                current_path,
                parent_path,
                entries,
            });
        }
        ClientMessage::ListSessions { request_id } => {
            // In-memory direct PTYs and tmux-backed PTYs are both live. Then
            // enumerate the private socket to find durable sessions left by an
            // earlier daemon. A map de-duplicates the two witnesses by id.
            let mut found: HashMap<String, RecoverableSession> = HashMap::new();
            {
                let map = sessions.read();
                for (id, session) in map.iter() {
                    // Liveness is the whole point of a recovery list. An entry
                    // whose reader thread has stopped describes a process that
                    // is gone, and offering it as recoverable produced a row
                    // with an empty cwd and an empty command that could not be
                    // attached to anything.
                    if !session.is_alive() {
                        continue;
                    }
                    found.insert(
                        id.clone(),
                        RecoverableSession {
                            id: id.clone(),
                            cwd: session.current_cwd().unwrap_or_default(),
                            command: session.foreground_command().unwrap_or_default(),
                            durable: session.is_durable(),
                        },
                    );
                }
            }

            let sidecar_dir = std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
            if let Some(exe) = pty::tmux::resolve_tmux(sidecar_dir.as_deref()) {
                for session in pty::tmux::list_sessions(&exe) {
                    found
                        .entry(session.id.clone())
                        .or_insert(RecoverableSession {
                            id: session.id,
                            cwd: session.cwd,
                            command: session.command,
                            durable: true,
                        });
                }
            }

            let mut listed: Vec<_> = found.into_values().collect();
            listed.sort_by(|a, b| a.id.cmp(&b.id));
            let _ = tx.send(ServerMessage::SessionListing {
                request_id,
                sessions: listed,
            });
        }
        ClientMessage::GetTelemetry { cwd, session_id } => {
            let session = session_id
                .as_ref()
                .and_then(|id| sessions.read().get(id).cloned());
            let _ = tx.send(metadata::telemetry(cwd, session_id, session, usage));
        }
        ClientMessage::Ping => {
            let _ = tx.send(ServerMessage::Pong);
        }
    }
}

#[cfg(any())]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn defaults_to_loopback_so_the_bundled_daemon_is_not_a_network_shell() {
        assert_eq!(listen_addr(None, None), "127.0.0.1:1421");
    }

    #[test]
    fn ipv6_loopback_is_a_valid_socket_address() {
        assert_eq!(
            listen_addr(Some("::1".to_string()), Some("9000".to_string())),
            "[::1]:9000"
        );
    }

    type Outbox = tokio::sync::mpsc::UnboundedReceiver<ServerMessage>;

    /// A daemon's worth of state, without a socket or a runtime.
    ///
    /// `handle_client_msg` is the whole request path, and an unbounded channel
    /// needs no reactor to send or `try_recv` on — so these drive the real
    /// lifecycle against a real process rather than a mock of one.
    fn daemon() -> (
        SessionsMap,
        UsageHandle,
        tokio::sync::mpsc::UnboundedSender<ServerMessage>,
        Outbox,
    ) {
        // Direct spawn, so OUR child is the shell and its status is the shell's.
        // Under tmux the child is a client and the honest answer is unknown,
        // which is a different assertion — see the comment in session.rs.
        std::env::set_var("DOOM_TERM_NO_TMUX", "1");
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Arc::new(RwLock::new(HashMap::new())),
            Arc::new(usage::service::UsageService::new()),
            tx,
            rx,
        )
    }

    /// Wait for a message the predicate accepts, or give up.
    fn wait_for<T>(
        rx: &mut Outbox,
        limit: Duration,
        mut accept: impl FnMut(&ServerMessage) -> Option<T>,
    ) -> Option<T> {
        let start = Instant::now();
        loop {
            match rx.try_recv() {
                Ok(msg) => {
                    if let Some(found) = accept(&msg) {
                        return Some(found);
                    }
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                    if start.elapsed() > limit {
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return None,
            }
        }
    }

    fn spawn(
        id: &str,
        shell: &str,
        sessions: &SessionsMap,
        usage: &UsageHandle,
        tx: &tokio::sync::mpsc::UnboundedSender<ServerMessage>,
    ) {
        handle_client_msg(
            ClientMessage::Spawn {
                id: id.to_string(),
                cols: 80,
                rows: 24,
                cwd: None,
                shell: Some(shell.to_string()),
            },
            sessions,
            usage,
            tx,
        );
    }

    fn agent_event(event: &str, cwd: &str, doom_session_id: Option<&str>) -> ServerMessage {
        ServerMessage::AgentEvent {
            agent: "claude".to_string(),
            event: event.to_string(),
            cwd: Some(cwd.to_string()),
            agent_session_id: Some("vendor-abc".to_string()),
            doom_session_id: doom_session_id.map(str::to_string),
        }
    }

    fn blocked_state(state: &HookState) -> Vec<(String, String)> {
        let mut rows: Vec<(String, String)> = state
            .subscribe()
            .0
            .iter()
            .map(|record| {
                (
                    record
                        .key
                        .strip_suffix(":unidentified")
                        .unwrap_or(&record.key)
                        .to_string(),
                    record.wire("catch-up")["data"]["event"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                )
            })
            .collect();
        rows.sort();
        rows
    }

    #[test]
    fn a_stop_that_arrives_with_nobody_listening_is_still_remembered() {
        // The bus drops an event outright when it has no subscriber, and the
        // result of `send` was discarded. Because blockedOnUser is persisted
        // with the workspace, a Stop lost during a reload left the session
        // marked ASKS with nothing able to clear it.
        let state: HookState = Arc::new(hooks::HookHub::default());

        remember_hook_state(
            &state,
            &agent_event("PermissionRequest", "/repo", Some("pane-1")),
        );
        assert_eq!(
            blocked_state(&state),
            vec![(
                "session:pane-1".to_string(),
                "PermissionRequest".to_string()
            )]
        );

        remember_hook_state(&state, &agent_event("Stop", "/repo", Some("pane-1")));
        assert_eq!(
            blocked_state(&state),
            vec![("session:pane-1".to_string(), "Stop".to_string())],
            "the later transition replaces the earlier one for the same pane"
        );
    }

    #[test]
    fn two_agents_in_one_directory_keep_separate_hook_state() {
        // The reason the pane id has to be the key: keyed by directory, the
        // second agent's Stop would clear the first agent's prompt.
        let state: HookState = Arc::new(hooks::HookHub::default());
        remember_hook_state(
            &state,
            &agent_event("PermissionRequest", "/repo", Some("pane-1")),
        );
        remember_hook_state(&state, &agent_event("Stop", "/repo", Some("pane-2")));

        assert_eq!(
            blocked_state(&state),
            vec![
                (
                    "session:pane-1".to_string(),
                    "PermissionRequest".to_string()
                ),
                ("session:pane-2".to_string(), "Stop".to_string()),
            ]
        );
    }

    #[test]
    fn an_agent_that_cannot_name_its_pane_falls_back_to_its_directory() {
        let state: HookState = Arc::new(hooks::HookHub::default());
        remember_hook_state(&state, &agent_event("PermissionRequest", "/repo", None));
        assert_eq!(
            blocked_state(&state),
            vec![("claude:/repo".to_string(), "PermissionRequest".to_string())]
        );
    }

    #[test]
    fn only_the_events_that_carry_state_are_retained() {
        // Retaining every vendor event would grow this map for things nothing
        // downstream reads, and replay them at every connect.
        let state: HookState = Arc::new(hooks::HookHub::default());
        remember_hook_state(
            &state,
            &agent_event("Notification", "/repo", Some("pane-1")),
        );
        assert!(blocked_state(&state).is_empty());
    }

    #[test]
    fn the_hook_script_session_header_is_read_verbatim() {
        // Case-insensitive on the NAME, untouched in the VALUE: session ids are
        // case-sensitive, and the request line used for routing is lowercased.
        let request = "POST /hook/claude HTTP/1.1\r\n\
             Content-Type: application/json\r\n\
             X-Doom-Term-Session: Node-AB12\r\n\
             \r\n\
             {}";
        assert_eq!(
            header_value(request, DOOM_SESSION_HEADER),
            Some("Node-AB12".to_string())
        );
    }

    #[test]
    fn a_hook_post_without_the_header_reports_no_pane() {
        let request = "POST /hook/claude HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{}";
        assert_eq!(header_value(request, DOOM_SESSION_HEADER), None);
    }

    #[test]
    fn a_process_that_failed_is_not_reported_as_a_clean_exit() {
        // The reader thread used to emit `ExecutionEnd { exit_code: Some(0) }`
        // on EOF without consulting the child at all, so a shell that died on a
        // failure reached the UI as a green PASS.
        let (sessions, usage, tx, mut rx) = daemon();
        spawn("review-dead", "/bin/false", &sessions, &usage, &tx);

        let code = wait_for(&mut rx, Duration::from_secs(10), |msg| match msg {
            ServerMessage::PtyEvent {
                event: DemuxEvent::ExecutionEnd { exit_code },
                ..
            } => Some(*exit_code),
            _ => None,
        });

        assert_eq!(
            code,
            Some(Some(1)),
            "/bin/false exits 1, and it must say so"
        );
    }

    #[test]
    fn a_dead_session_is_not_offered_as_recoverable() {
        // ListSessions enumerated every map entry, so an exited shell was
        // advertised with an empty cwd and an empty command — a recovery row
        // that could not be attached to anything.
        let (sessions, usage, tx, mut rx) = daemon();
        spawn("review-gone", "/bin/false", &sessions, &usage, &tx);

        let closed = wait_for(&mut rx, Duration::from_secs(10), |msg| match msg {
            ServerMessage::SessionClosed { session_id } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(closed.as_deref(), Some("review-gone"));

        handle_client_msg(
            ClientMessage::ListSessions {
                request_id: "r1".to_string(),
            },
            &sessions,
            &usage,
            &tx,
        );

        let listed = wait_for(&mut rx, Duration::from_secs(5), |msg| match msg {
            ServerMessage::SessionListing { sessions, .. } => Some(sessions.clone()),
            _ => None,
        })
        .expect("a listing must come back");

        assert!(
            !listed.iter().any(|s| s.id == "review-gone"),
            "a session whose process exited is not recoverable: {:?}",
            listed
        );
    }

    #[test]
    fn spawning_over_a_dead_id_starts_a_real_process() {
        // Spawn treated any map entry as a live session to rebind: it replayed
        // the corpse's ring and returned WITHOUT starting anything, leaving a
        // pane that showed scrollback and accepted no commands.
        let (sessions, usage, tx, mut rx) = daemon();
        spawn("review-reuse", "/bin/false", &sessions, &usage, &tx);
        wait_for(&mut rx, Duration::from_secs(10), |msg| match msg {
            ServerMessage::SessionClosed { .. } => Some(()),
            _ => None,
        })
        .expect("the first process must exit");

        // A shell that stays up, under the id the dead one used.
        spawn("review-reuse", "/bin/cat", &sessions, &usage, &tx);

        let live = sessions
            .read()
            .get("review-reuse")
            .map(|session| session.is_alive());
        assert_eq!(
            live,
            Some(true),
            "the id must now hold a live process, not a replayed corpse"
        );

        handle_client_msg(
            ClientMessage::Kill {
                id: "review-reuse".to_string(),
            },
            &sessions,
            &usage,
            &tx,
        );
    }

    #[test]
    fn a_rebound_session_announces_its_exit_to_the_new_connection() {
        let (sessions, usage, tx, _rx) = daemon();
        spawn("review-rebound-close", "/bin/cat", &sessions, &usage, &tx);
        let (next_tx, mut next_rx) = tokio::sync::mpsc::unbounded_channel();
        spawn(
            "review-rebound-close",
            "/bin/cat",
            &sessions,
            &usage,
            &next_tx,
        );
        handle_client_msg(
            ClientMessage::Kill {
                id: "review-rebound-close".to_string(),
            },
            &sessions,
            &usage,
            &next_tx,
        );
        let closed = wait_for(&mut next_rx, Duration::from_secs(2), |msg| match msg {
            ServerMessage::SessionClosed { session_id } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(closed.as_deref(), Some("review-rebound-close"));
    }
}
