//! Metadata is observational, never an attachment or process-creation path.
//! Call on bounded-admission blocking workers, without catalog/session locks.
use crate::{pty, usage, DirectoryEntry, ServerMessage, UsageHandle};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

pub fn telemetry(
    cwd: Option<String>,
    session_id: Option<String>,
    session: Option<Arc<pty::PtySession>>,
    usage: &UsageHandle,
) -> ServerMessage {
    // The kernel first, the client's copy second.
    //
    // The client learns the directory from OSC 7, which the integration
    // script emits once per prompt — so `cd repo && claude` never
    // reports the move and the app describes the wrong directory for as
    // long as the agent runs. CONTEXT % is looked up BY directory, so
    // that showed up as a permanent '--' next to a running agent.
    let observed = session.as_ref().and_then(|s| s.current_cwd());

    // Observed, then asked for, then HOME — and never the daemon's own
    // directory.
    //
    // This used to end at `std::env::current_dir()`. A session has nothing to
    // do with where the daemon was started, and under an AppImage that is the
    // FUSE mount: a GetTelemetry with no session and no cwd answered
    // `/tmp/.mount_XXXXXXXX/usr`, the client stored it on the node, and every
    // terminal opened from that node inherited it. The app reported a
    // directory that belongs to a mount which is unmounted when the app exits.
    // HOME is the same last resort `resolve_cwd` uses when it spawns a shell,
    // so the two agree about where "nowhere in particular" is.
    let current_dir = observed
        .or_else(|| {
            cwd.map(|c| pty::session::expand_path(&c).to_string_lossy().to_string())
                .filter(|c| !c.trim().is_empty())
        })
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string());
    // No game vocabulary in anything the UI can render: an unknown user
    // is unknown, not a "marine" on "phobos-base".
    let username = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());
    let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".to_string());

    let git_branch = pty::process_io::run_bounded(
        Path::new("git"),
        &[
            "-C".into(),
            current_dir.clone(),
            "rev-parse".into(),
            "--abbrev-ref".into(),
            "HEAD".into(),
        ],
        &[],
        pty::process_io::HelperLimits {
            timeout: Duration::from_secs(2),
            input_bytes: 0,
            output_bytes: 4096,
        },
    )
    .ok()
    .and_then(|bytes| String::from_utf8(bytes).ok())
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());

    // Who is actually running in THIS session, per the kernel — not per
    // the tab title, and not per whichever session sorted first. An id
    // the daemon does not know describes nothing, so the agent is
    // unknown rather than borrowed from another tab.
    let agent = session
        .as_ref()
        .and_then(|s| s.foreground_command())
        .and_then(|comm| pty::classify_agent(&comm));

    // Only for an agent whose transcripts we can read, and only ever
    // against its OWN vendor's files — reporting Codex's pane against
    // Claude's transcripts would be a straightforward mislabel.
    //
    // Codex additionally carries its rate limit in the same record, so
    // it needs no OAuth call at all; `codex_rate` is that number.
    // Antigravity has no verified, pane-scoped accounting adapter.
    // Transcript byte length, history rows, and configured defaults
    // cannot supply these measurements; unsupported agents stay '--'.
    let process = session
        .as_ref()
        .and_then(|s| s.shell_pid())
        .and_then(pty::foreground::foreground_identity);
    let (context, agent_rate) = match agent.as_ref().map(|a| a.key) {
        Some("claude") => (
            usage::context::context_fraction(&current_dir, session_id.as_deref(), process),
            None,
        ),
        Some("codex") => {
            match usage::codex::reading(&current_dir, session_id.as_deref(), process) {
                Some((reading, rate)) => (Some(reading), rate),
                None => (None, None),
            }
        }
        _ => (None, None),
    };

    let is_worktree = pty::detect_worktree(std::path::Path::new(&current_dir));
    let isolation = if is_worktree {
        "worktree".to_string()
    } else {
        pty::detect_isolation().to_string()
    };

    ServerMessage::Telemetry {
        session_id,
        username,
        hostname,
        current_dir,
        git_branch,
        isolation,
        agent_key: agent.as_ref().map(|a| a.key.to_string()),
        agent_name: agent.as_ref().map(|a| a.name.to_string()),
        // Read-only: whatever the refresh loop last managed to learn.
        // Reported only for the agent it belongs to — showing Claude's
        // quota while Codex is in the foreground would be a mislabel.
        rate_used: match agent.as_ref().map(|a| a.key) {
            Some("claude") => usage.cached(),
            Some("codex") => agent_rate,
            _ => None,
        },
        context_used: context.as_ref().map(|c| c.fraction),
        // Empty means the source did not name a model — Codex's token
        // event does not. Absent, not guessed: this field has only ever
        // held what was read.
        agent_model: context.map(|c| c.model).filter(|m| !m.is_empty()),
    }
}

const DIRECTORY_BYTES: usize = 256 * 1024;
const DIRECTORY_ENTRIES: usize = 2048;

pub fn browse(request_id: String, path: Option<String>) -> Value {
    let requested = pty::expand_path(path.as_deref().unwrap_or("~"));
    let dir = if requested.is_dir() {
        requested
    } else {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("/"))
    };
    let mut reply = json!({"event":"DirectoryListing","data":{
        "request_id":request_id, "current_path":dir.to_string_lossy(),
        "parent_path":dir.parent().map(|p| p.to_string_lossy()),
        "entries":[], "truncated":false, "error":null
    }});
    let mut budget =
        DIRECTORY_BYTES.saturating_sub(serde_json::to_vec(&reply).unwrap().len() + 1024);
    let mut entries = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(500);
    match std::fs::read_dir(&dir) {
        Ok(read) => {
            for (scanned, entry) in read.enumerate() {
                if entries.len() >= DIRECTORY_ENTRIES
                    || scanned >= 8192
                    || Instant::now() >= deadline
                {
                    reply["data"]["truncated"] = json!(true);
                    break;
                }
                let Ok(entry) = entry else {
                    reply["data"]["truncated"] = json!(true);
                    continue;
                };
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') && name != ".git" {
                    continue;
                }
                let path = entry.path();
                let is_dir = path.is_dir();
                let entry = DirectoryEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_dir,
                    is_git_repo: is_dir && path.join(".git").exists(),
                };
                let size = serde_json::to_vec(&entry).unwrap().len() + 1;
                if size > budget {
                    reply["data"]["truncated"] = json!(true);
                    break;
                }
                budget -= size;
                entries.push(entry);
            }
        }
        Err(_) => {
            reply["data"]["error"] = json!("Directory could not be read; inventory is unknown")
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    reply["data"]["entries"] = json!(entries);
    reply
}

pub fn create_worktree(request_id: String, cwd: String, branch: String) -> Value {
    match crate::worktree::create(&pty::expand_path(&cwd), &branch) {
        Ok(path) => {
            json!({"event":"WorktreeCreated","data":{"request_id":request_id,"path":path,"branch":branch,"error":null}})
        }
        Err(_) => {
            json!({"event":"WorktreeCreated","data":{"request_id":request_id,"path":null,"branch":null,"error":"Worktree was not confirmed; inspect the repository before retrying"}})
        }
    }
}
