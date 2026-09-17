use super::*;
use std::time::{Duration, Instant};

/// Real PTYs and HTTP hook requests, without real agent binaries, credentials,
/// user transcripts, tmux servers, or global HOME changes.
struct Fixture {
    root: tempfile::TempDir,
    sessions: SessionsMap,
    usage: UsageHandle,
}

impl Fixture {
    fn new() -> Self {
        std::env::set_var("DOOM_TERM_NO_TMUX", "1");
        Self {
            root: tempfile::tempdir().unwrap(),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            usage: Arc::new(usage::service::UsageService::new()),
        }
    }

    fn pane(&self, agent: &str, name: &str) -> String {
        let program = self.root.path().join(agent);
        if !program.exists() {
            std::fs::copy("/bin/cat", &program).unwrap();
        }
        let id = format!("{}-{name}", self.root.path().display());
        let session = PtySession::create(
            id.clone(),
            80,
            24,
            Some(self.root.path().display().to_string()),
            Some(program.display().to_string()),
        )
        .unwrap();
        self.sessions.write().insert(id.clone(), Arc::new(session));
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if self
                .sessions
                .read()
                .get(&id)
                .and_then(|s| s.foreground_command())
                .as_deref()
                == Some(agent)
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "fixture process did not become the foreground agent"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        id
    }

    fn incarnation(&self, id: &str) -> String {
        self.sessions
            .read()
            .get(id)
            .unwrap()
            .stream()
            .snapshot()
            .metadata
            .incarnation
            .as_str()
            .to_owned()
    }

    async fn hook_with_incarnation(
        &self,
        agent: &str,
        pane: Option<&str>,
        incarnation: Option<&str>,
        count: u64,
    ) {
        let path = self.root.path().join(format!("{agent}-{count}.jsonl"));
        let record = if agent == "claude" {
            serde_json::json!({"type":"assistant", "message": {"model":"claude-haiku-4-5", "usage":{"input_tokens":count}}})
        } else {
            serde_json::json!({"payload":{"type":"token_count", "info":{"model_context_window":200000, "last_token_usage":{"total_tokens":count}}}})
        };
        std::fs::write(&path, format!("{record}\n")).unwrap();
        let body =
            serde_json::json!({"event":"Stop", "cwd":self.root.path(), "transcript_path":path})
                .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let agent = agent.to_owned();
        let sessions = self.sessions.clone();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_hook(stream, &hooks::HookHub::default(), Some(agent), &sessions).await;
        });
        let mut header = pane
            .map(|id| format!("X-Doom-Term-Session: {id}\r\n"))
            .unwrap_or_default();
        if let Some(incarnation) = incarnation {
            header.push_str(&format!("X-Doom-Term-Incarnation: {incarnation}\r\n"));
        }
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(format!("POST /hook HTTP/1.1\r\nHost: {addr}\r\n{header}Content-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await.unwrap();
        task.await.unwrap();
        assert!(reply.starts_with("HTTP/1.1 204"));
    }

    async fn hook(&self, agent: &str, pane: Option<&str>, count: u64) {
        let incarnation = pane.map(|id| self.incarnation(id));
        self.hook_with_incarnation(agent, pane, incarnation.as_deref(), count)
            .await;
    }

    fn context(&self, id: &str) -> Option<f64> {
        let session = self.sessions.read().get(id).cloned();
        let ServerMessage::Telemetry {
            session_id,
            context_used,
            ..
        } = metadata::telemetry(None, Some(id.into()), session, &self.usage)
        else {
            panic!("missing telemetry response")
        };
        assert_eq!(session_id.as_deref(), Some(id));
        context_used
    }

    fn wait_command(&self, id: &str, command: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while self
            .sessions
            .read()
            .get(id)
            .and_then(|s| s.foreground_command())
            .as_deref()
            != Some(command)
        {
            assert!(
                Instant::now() < deadline,
                "foreground did not become {command}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let sessions: Vec<_> = self.sessions.read().values().cloned().collect();
        for session in sessions {
            let _ = session.kill();
        }
    }
}

/// Run this regression with a disposable profile mounted only inside a private
/// namespace. HOME is unchanged, and no real agent history or credentials are
/// read or modified. This exercises the real request handler, including any
/// legacy provider that might scan a profile instead of using pane attribution.
#[test]
fn unsupported_agent_history_cannot_invent_telemetry() {
    const CHILD: &str = "DOOM_UNSUPPORTED_TELEMETRY_FIXTURE";
    if std::env::var_os(CHILD).is_none() {
        let profile = tempfile::tempdir().unwrap();
        let logs = profile.path().join("brain/fixture/.system_generated/logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("transcript.jsonl"),
            "{\"type\":\"PLANNER_RESPONSE\",\"text\":\"No token accounting here\"}\n".repeat(100),
        )
        .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        // The old reader accepts a directory prefix and counts every recent
        // history row as quota use, despite neither proving pane ownership.
        std::fs::write(
            profile.path().join("history.jsonl"),
            format!("{{\"timestamp\":{now},\"workspace\":\"/\",\"conversationId\":\"fixture\"}}\n"),
        )
        .unwrap();
        let profile_mount =
            std::fs::canonicalize(std::env::var_os("HOME").expect("HOME path")).unwrap();
        assert!(
            profile_mount.parent().is_some(),
            "HOME must not be the root"
        );
        for configured in [false, true] {
            if configured {
                std::fs::write(
                    profile.path().join("settings.json"),
                    r#"{"model":"unverified-configured-model-pro"}"#,
                )
                .unwrap();
            }
            let result = std::process::Command::new("bwrap")
                .args(["--die-with-parent", "--unshare-pid", "--unshare-net"])
                .args(["--ro-bind", "/", "/", "--tmpfs", "/tmp", "--ro-bind"])
                .arg(std::env::current_exe().unwrap())
                .arg("/tmp/doom-telemetry-test")
                .arg("--tmpfs")
                .arg(&profile_mount)
                .arg("--ro-bind")
                .arg(profile.path())
                .arg(profile_mount.join(".gemini/antigravity-cli"))
                .args(["--proc", "/proc", "--dev", "/dev"])
                .args(["--setenv", "TMPDIR", "/tmp"])
                .args(["--chdir", "/tmp", "--setenv", CHILD, "1"])
                .args([
                    "/tmp/doom-telemetry-test",
                    "--exact",
                    "telemetry_tests::unsupported_agent_history_cannot_invent_telemetry",
                    "--nocapture",
                ])
                .output()
                .expect("bubblewrap is required for the isolated telemetry regression");
            assert!(
                result.status.success(),
                "isolated telemetry regression failed (configured={configured}):\n{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr),
            );
        }
        return;
    }

    let fixture = Fixture::new();
    for agent in ["agy", "antigravity"] {
        let id = fixture.pane(agent, agent);
        let response = metadata::telemetry(
            None,
            Some(id.clone()),
            fixture.sessions.read().get(&id).cloned(),
            &fixture.usage,
        );
        let ServerMessage::Telemetry {
            session_id,
            agent_key,
            agent_name,
            agent_model,
            context_used,
            rate_used,
            ..
        } = response
        else {
            unreachable!()
        };
        assert_eq!(session_id.as_deref(), Some(id.as_str()));
        assert_eq!(agent_key.as_deref(), Some("antigravity"));
        assert_eq!(agent_name.as_deref(), Some("ANTIGRAVITY"));
        assert_eq!(
            (agent_model, context_used, rate_used),
            (None, None, None),
            "history bytes and settings are not measured, pane-scoped usage"
        );
    }
}

#[tokio::test]
async fn same_agent_panes_in_one_directory_keep_their_own_context() {
    for agent in ["claude", "codex"] {
        let fixture = Fixture::new();
        let a = fixture.pane(agent, "a");
        let b = fixture.pane(agent, "b");
        fixture.hook(agent, Some(&a), 20000).await;
        fixture.hook(agent, Some(&b), 40000).await;
        assert_eq!(
            fixture.context(&a),
            Some(0.1),
            "pane A borrowed pane B's context for {agent}"
        );
        assert_eq!(fixture.context(&b), Some(0.2));
    }
}

#[tokio::test]
async fn an_unattributed_hook_cannot_describe_a_pane() {
    for agent in ["claude", "codex"] {
        let fixture = Fixture::new();
        let a = fixture.pane(agent, "a");
        fixture.hook(agent, None, 20000).await;
        assert_eq!(
            fixture.context(&a),
            None,
            "a directory match is not proof of pane ownership"
        );
    }
}

#[tokio::test]
async fn a_stale_incarnation_hook_cannot_teach_the_replacement_its_transcript() {
    let fixture = Fixture::new();
    let id = fixture.pane("claude", "stale-incarnation");
    fixture
        .hook_with_incarnation("claude", Some(&id), Some(&"f".repeat(32)), 20000)
        .await;
    assert_eq!(fixture.context(&id), None);
    fixture.hook("claude", Some(&id), 20000).await;
    assert_eq!(fixture.context(&id), Some(0.1));
}

#[tokio::test]
async fn a_new_agent_process_in_the_same_pane_does_not_inherit_the_old_transcript() {
    let fixture = Fixture::new();
    let program = fixture.root.path().join("claude");
    std::fs::copy("/bin/cat", &program).unwrap();
    let id = format!("{}-restart", fixture.root.path().display());
    let session = PtySession::create(
        id.clone(),
        80,
        24,
        Some(fixture.root.path().display().to_string()),
        Some("/bin/sh".into()),
    )
    .unwrap();
    fixture
        .sessions
        .write()
        .insert(id.clone(), Arc::new(session));
    fixture.wait_command(&id, "sh");
    let session = fixture.sessions.read().get(&id).unwrap().clone();
    session
        .write(format!("{}\n", program.display()).as_bytes())
        .unwrap();
    fixture.wait_command(&id, "claude");
    fixture.hook("claude", Some(&id), 20000).await;
    assert_eq!(fixture.context(&id), Some(0.1));
    session.write(b"\x03").unwrap();
    fixture.wait_command(&id, "sh");
    session
        .write(format!("{}\n", program.display()).as_bytes())
        .unwrap();
    fixture.wait_command(&id, "claude");
    assert_eq!(
        fixture.context(&id),
        None,
        "a different foreground process needs its own hook"
    );
}

/// Drive a real enrichment frame through a real PTY.
///
/// The fixture's "agent" is a copy of /bin/cat, so anything written in comes
/// straight back out — through the real demuxer, into the real session state.
/// Nothing here is stubbed but the agent's own behaviour.
fn report_remote(fixture: &Fixture, id: &str, json: &str) {
    use base64::Engine as _;
    let payload = base64::engine::general_purpose::STANDARD.encode(json);
    let session = fixture.sessions.read().get(id).cloned().unwrap();
    session
        // The trailing newline is load-bearing: the PTY is in canonical mode and
        // `cat` does not flush a line until it sees one, so without it nothing
        // is ever echoed back through the demuxer.
        .write(format!("\x1b]1337;SetUserVar=doomterm={payload}\x07\n").as_bytes())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if session.remote_enrichment().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the session never observed the enrichment frame");
}

fn telemetry_for(fixture: &Fixture, id: &str) -> ServerMessage {
    let session = fixture.sessions.read().get(id).cloned();
    metadata::telemetry(None, Some(id.to_string()), session, &fixture.usage)
}

#[tokio::test]
async fn a_remote_session_reports_the_remote_and_never_the_local_machine() {
    let fixture = Fixture::new();
    let pane = fixture.pane("claude", "remote");
    report_remote(
        &fixture,
        &pane,
        r#"{"v":1,"host":"devbox","user":"someone","branch":"main"}"#,
    );
    let ServerMessage::Telemetry {
        hostname,
        username,
        git_branch,
        remote,
        ..
    } = telemetry_for(&fixture, &pane)
    else {
        panic!("missing telemetry response")
    };
    assert_eq!(hostname, "devbox", "reported the daemon's own host");
    assert_eq!(username, "someone");
    assert_eq!(git_branch.as_deref(), Some("main"));
    assert_eq!(remote.unwrap().host.as_deref(), Some("devbox"));
}

#[tokio::test]
async fn a_field_the_remote_did_not_report_is_unknown_not_the_local_value() {
    // The whole point. This repository has a branch and this machine has a
    // hostname; neither is true of the machine the work is on.
    let fixture = Fixture::new();
    let pane = fixture.pane("claude", "sparse");
    report_remote(&fixture, &pane, r#"{"v":1,"host":"devbox"}"#);
    let ServerMessage::Telemetry {
        git_branch,
        username,
        ..
    } = telemetry_for(&fixture, &pane)
    else {
        panic!("missing telemetry response")
    };
    assert_eq!(
        git_branch, None,
        "the local branch stood in for the remote's"
    );
    assert_eq!(
        username, "unknown",
        "the local user stood in for the remote's"
    );
}

#[tokio::test]
async fn a_remote_session_cannot_report_context_or_rate() {
    // Both are transcript-derived and the transcript is on the other machine.
    let fixture = Fixture::new();
    let pane = fixture.pane("claude", "nocontext");
    fixture.hook("claude", Some(&pane), 20000).await;
    report_remote(
        &fixture,
        &pane,
        r#"{"v":1,"host":"devbox","agent":"claude"}"#,
    );
    let ServerMessage::Telemetry {
        context_used,
        rate_used,
        agent_key,
        ..
    } = telemetry_for(&fixture, &pane)
    else {
        panic!("missing telemetry response")
    };
    assert_eq!(
        context_used, None,
        "invented a context reading across a transport"
    );
    assert_eq!(rate_used, None);
    // ...but the agent the REMOTE named is still reported.
    assert_eq!(agent_key.as_deref(), Some("claude"));
}

#[tokio::test]
async fn a_local_session_is_completely_unchanged() {
    let fixture = Fixture::new();
    let pane = fixture.pane("claude", "local");
    let ServerMessage::Telemetry {
        remote, hostname, ..
    } = telemetry_for(&fixture, &pane)
    else {
        panic!("missing telemetry response")
    };
    assert!(remote.is_none());
    assert!(!hostname.is_empty());
}

#[tokio::test]
async fn the_remote_block_survives_the_hand_injected_incarnation() {
    // recovery.rs serializes the Telemetry variant and THEN assigns
    // reply["data"]["incarnation"] by hand — a field the enum does not declare.
    // ptyClient rejects any telemetry whose incarnation does not match, so a
    // new field that failed to coexist with that injection would be dropped on
    // the client with no error anywhere.
    let fixture = Fixture::new();
    let pane = fixture.pane("claude", "wire");
    report_remote(
        &fixture,
        &pane,
        r#"{"v":1,"host":"devbox","branch":"main"}"#,
    );
    let message = telemetry_for(&fixture, &pane);

    let mut reply = serde_json::to_value(&message).unwrap();
    reply["data"]["incarnation"] = serde_json::json!("abc");

    assert_eq!(reply["event"], "Telemetry");
    assert_eq!(reply["data"]["incarnation"], "abc");
    assert_eq!(reply["data"]["remote"]["host"], "devbox");
    assert_eq!(reply["data"]["git_branch"], "main");
    // ...and a local session serializes the block as an explicit null rather
    // than omitting it, so the client can tell "local" from "not reported".
    let local = fixture.pane("claude", "wire-local");
    let plain = serde_json::to_value(telemetry_for(&fixture, &local)).unwrap();
    assert!(plain["data"]["remote"].is_null());
}

#[tokio::test]
async fn a_session_that_comes_back_local_stops_reporting_the_remote() {
    // ssh devbox, work, exit. The frame is emitted once per prompt, so a prompt
    // that comes round without one is a shell that is no longer reporting.
    // Without expiry the pane described devbox for the rest of its life: a
    // stale host and branch, and context forced to '--' for a local session.
    let fixture = Fixture::new();
    let pane = fixture.pane("claude", "came-back");
    report_remote(
        &fixture,
        &pane,
        r#"{"v":1,"host":"devbox","branch":"main"}"#,
    );
    let session = fixture.sessions.read().get(&pane).cloned().unwrap();
    assert!(session.remote_enrichment().is_some());

    // Two local prompts with no frame between them.
    for _ in 0..2 {
        session.write(b"\x1b]133;A\x07\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && session.remote_enrichment().is_some() {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    assert!(
        session.remote_enrichment().is_none(),
        "the pane still describes the remote after returning to a local shell"
    );

    let ServerMessage::Telemetry {
        remote, hostname, ..
    } = telemetry_for(&fixture, &pane)
    else {
        panic!("missing telemetry response")
    };
    assert!(remote.is_none());
    assert!(
        !hostname.is_empty(),
        "hostname went unknown on a local session"
    );
}
