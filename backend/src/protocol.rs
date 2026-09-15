//! V2 commands have no Spawn/rebind compatibility path.
use doom_term_pty::stream::{Identity, Sequence, StreamMetadata};
use serde::{Deserialize, Serialize};

pub const MAX_WIRE_BYTES: usize = 6 * 1024 * 1024 + 65536;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResumeCursor {
    pub stream_epoch: Identity,
    pub after_sequence: Sequence,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", content = "payload", deny_unknown_fields)]
pub enum Client {
    Auth {
        token: String,
    },
    Negotiate {
        version: u16,
    },
    Create {
        request_id: String,
        id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
    },
    Attach {
        request_id: String,
        id: String,
        incarnation: Identity,
        resume: Option<ResumeCursor>,
    },
    RecoverLegacy {
        request_id: String,
        id: String,
        pane: String,
        root_pid: u32,
    },
    StreamApplied {
        id: String,
        incarnation: Identity,
        attachment_id: Identity,
        sequence: Sequence,
    },
    Write {
        id: String,
        incarnation: Identity,
        attachment_id: Identity,
        data: String,
    },
    Paste {
        request_id: String,
        id: String,
        incarnation: Identity,
        attachment_id: Identity,
        text: String,
    },
    Resize {
        id: String,
        incarnation: Identity,
        attachment_id: Identity,
        cols: u16,
        rows: u16,
    },
    Signal {
        id: String,
        incarnation: Identity,
        attachment_id: Identity,
        signal: String,
    },
    Kill {
        request_id: String,
        id: String,
        incarnation: Identity,
        attachment_id: Identity,
    },
    ListSessions {
        request_id: String,
    },
    BrowseDirectory {
        request_id: String,
        path: Option<String>,
    },
    GetTelemetry {
        cwd: Option<String>,
        session_id: Option<String>,
        incarnation: Option<Identity>,
    },
    CreateWorktree {
        request_id: String,
        cwd: String,
        branch: String,
    },
    Ping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttachOutcome {
    Resume,
    ReplayFromStart,
    Rebuild,
    Unreconstructable,
    Missing,
    Closed,
    Replaced,
    Busy,
    Incompatible,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Descriptor {
    #[serde(flatten)]
    pub metadata: StreamMetadata,
    pub clock_epoch: Identity,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn dimensions_valid(cols: u16, rows: u16) -> bool {
    cols > 0 && rows > 0 && u32::from(cols) * u32::from(rows) <= 1_048_576
}
pub fn parse(text: &str) -> Result<Client, &'static str> {
    const INVALID: &str = "Invalid or incompatible v2 command";
    // A 1 MiB paste can occupy six times that size in escaped JSON. The PTY
    // cap still applies to original decoded UTF-8, before normalization.
    if text.len() > MAX_WIRE_BYTES {
        return Err(INVALID);
    }
    let command: Client = serde_json::from_str(text).map_err(|_| INVALID)?;
    let request = |value: &str| !value.is_empty() && value.len() <= 256;
    let valid = match &command {
        Client::Auth { token } => token.len() <= 4096,
        Client::Negotiate { .. } | Client::Ping => true,
        Client::Create {
            request_id,
            id,
            cols,
            rows,
            cwd,
            shell,
        } => {
            request(request_id)
                && valid_id(id)
                && dimensions_valid(*cols, *rows)
                && cwd.as_ref().is_none_or(|value| value.len() <= 4096)
                && shell
                    .as_ref()
                    .is_none_or(|value| !value.is_empty() && value.len() <= 4096)
        }
        Client::Attach { request_id, id, .. } | Client::Kill { request_id, id, .. } => {
            request(request_id) && valid_id(id)
        }
        Client::RecoverLegacy { request_id, id, pane, root_pid } => {
            request(request_id) && valid_id(id) && *root_pid > 0
                && pane.starts_with('%') && pane.len() > 1 && pane.len() <= 21
                && pane[1..].bytes().all(|byte| byte.is_ascii_digit())
        }
        Client::StreamApplied { id, .. } => valid_id(id),
        Client::Write { id, data, .. } => valid_id(id) && data.len() <= 65536,
        Client::Paste {
            request_id,
            id,
            ..
        // Preserve correlation for an oversized but well-formed paste. The
        // handler rejects original decoded UTF-8 over 1 MiB before dispatch;
        // treating that refusal as an incompatible handshake loses its ids.
        } => request(request_id) && valid_id(id),
        Client::Resize { id, cols, rows, .. } => valid_id(id) && dimensions_valid(*cols, *rows),
        Client::Signal { id, signal, .. } => {
            valid_id(id)
                && matches!(
                    signal.as_str(),
                    "SIGINT" | "INT" | "ctrl+c" | "SIGTSTP" | "TSTP" | "ctrl+z" | "EOF" | "ctrl+d"
                )
        }
        Client::ListSessions { request_id } => request(request_id),
        Client::BrowseDirectory { request_id, path } => {
            request(request_id) && path.as_ref().is_none_or(|p| p.len() <= 4096 && !p.contains('\0'))
        }
        Client::GetTelemetry { cwd, session_id, incarnation } => {
            cwd.as_ref().is_none_or(|p| p.len() <= 4096 && !p.contains('\0'))
                && session_id.as_ref().is_none_or(|id| valid_id(id))
                && (incarnation.is_none() || session_id.is_some())
        }
        Client::CreateWorktree { request_id, cwd, branch } => {
            request(request_id) && cwd.len() <= 4096 && !cwd.contains('\0')
                && !branch.is_empty() && branch.len() <= 256 && !branch.contains('\0')
        }
    };
    if valid {
        Ok(command)
    } else {
        Err(INVALID)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mutations_require_both_identities_and_cannot_smuggle_a_create_into_attach() {
        let token = "a".repeat(32);
        let write = json!({"action":"Write","payload":{"id":"pane","incarnation":token,"attachment_id":token,"data":"text"}});
        assert!(parse(&write.to_string()).is_ok());
        for key in ["incarnation", "attachment_id"] {
            let mut legacy = write.clone();
            legacy["payload"].as_object_mut().unwrap().remove(key);
            assert!(parse(&legacy.to_string()).is_err());
        }
        assert!(
            parse(r#"{"action":"Spawn","payload":{"id":"pane","cols":80,"rows":24}}"#).is_err()
        );
        let mut attach = json!({"action":"Attach","payload":{"request_id":"attach","id":"pane","incarnation":token,"resume":{"stream_epoch":token,"after_sequence":"9007199254740993"}}});
        assert!(parse(&attach.to_string()).is_ok());
        attach["payload"]["shell"] = json!("/bin/sh");
        assert!(parse(&attach.to_string()).is_err());
    }

    #[test]
    fn malformed_cursors_and_resource_requests_are_refused_without_echoing_contents() {
        let token = "b".repeat(32);
        let mut create = json!({"action":"Create","payload":{"request_id":"create","id":"pane","cols":80,"rows":24,"shell":null,"cwd":null}});
        assert!(parse(&create.to_string()).is_ok());
        for (cols, rows) in [(0, 24), (80, 0), (65535, 65535)] {
            create["payload"]["cols"] = json!(cols);
            create["payload"]["rows"] = json!(rows);
            assert!(parse(&create.to_string()).is_err());
        }
        for sequence in [json!(1), json!("01"), json!("18446744073709551616")] {
            let ack = json!({"action":"StreamApplied","payload":{"id":"pane","incarnation":token,"attachment_id":token,"sequence":sequence}});
            assert!(parse(&ack.to_string()).is_err());
        }
        let malformed = json!({"action":"Paste","payload":{"request_id":"paste","id":"pane","incarnation":"wrong","attachment_id":token,"text":"SECRET"}});
        let error = parse(&malformed.to_string()).unwrap_err();
        assert!(!error.contains("SECRET"));
    }
}
