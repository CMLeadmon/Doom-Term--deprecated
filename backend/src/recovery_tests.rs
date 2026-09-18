//! Real loopback sockets. Process fixtures use private profiles/tmux roots only.
use crate::gateway::Gateway;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
struct Fixture {
    url: String,
    server: Arc<Gateway>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        let owned: Vec<_> = self.server.sessions.read().values().cloned().collect();
        for session in owned {
            let _ = session.kill();
        }
    }
}

#[cfg(unix)]
fn isolated(test: &str) -> bool {
    if std::env::var_os("DOOM_RECOVERY_TEST_CHILD").is_some() {
        return false;
    }
    let dir = tempfile::tempdir().unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("recovery_tests::{test}"), "--nocapture"])
        .env("DOOM_RECOVERY_TEST_CHILD", "1")
        .env("DOOM_TERM_NO_TMUX", "1")
        .env("DOOM_TERM_NO_SHELL_INTEGRATION", "1")
        .env("TMUX_TMPDIR", dir.path())
        .env_remove("ENV")
        .env_remove("BASH_ENV")
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    true
}

#[cfg(unix)]
fn isolated_durable(test: &str) -> bool {
    if std::env::var_os("DOOM_RECOVERY_DURABLE_CHILD").is_some() {
        return false;
    }
    let dir = tempfile::tempdir().unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("recovery_tests::{test}"), "--nocapture"])
        .env("DOOM_RECOVERY_DURABLE_CHILD", "1")
        .env("TMUX_TMPDIR", dir.path())
        .env("DOOM_TERM_NO_SHELL_INTEGRATION", "1")
        .env_remove("DOOM_TERM_NO_TMUX")
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .env_remove("ENV")
        .env_remove("BASH_ENV")
        .output()
        .unwrap();
    let _ = std::process::Command::new("tmux")
        .env("TMUX_TMPDIR", dir.path())
        .args(["-N", "-L", "doom-term", "kill-server"])
        .output();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    true
}

async fn connect(fixture: &Fixture) -> Socket {
    let (mut ws, _) = tokio_tungstenite::connect_async(&fixture.url)
        .await
        .unwrap();
    assert_eq!(receive(&mut ws).await["event"], "AuthResult");
    send(
        &mut ws,
        json!({"action":"Auth","payload":{"token":"fixture-secret"}}),
    )
    .await;
    assert_eq!(receive(&mut ws).await["data"]["success"], true);
    assert_eq!(receive(&mut ws).await["event"], "Protocol");
    send(
        &mut ws,
        json!({"action":"Negotiate","payload":{"version":2}}),
    )
    .await;
    assert_eq!(receive(&mut ws).await["event"], "Negotiated");
    ws
}

async fn event(ws: &mut Socket, wanted: &str) -> Value {
    for _ in 0..100 {
        let value = receive(ws).await;
        if value["event"] == wanted {
            return value["data"].clone();
        }
        assert!(
            matches!(
                value["event"].as_str(),
                Some("StreamRecord" | "StreamBegin")
            ),
            "expected {wanted}, got {value}"
        );
    }
    panic!("no {wanted} within bounded stream prefix")
}

#[cfg(unix)]
#[tokio::test]
async fn recovery_create_attach_and_exact_cut_fence_real_child_input_between_two_controllers() {
    if isolated(
        "recovery_create_attach_and_exact_cut_fence_real_child_input_between_two_controllers",
    ) {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = fixture().await;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("receiver.sh");
    let received = dir.path().join("received.txt");
    std::fs::write(&script, format!("#!/bin/sh\nstty -echo\nprintf 'RECEIVER_READY\\n'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\" >> '{}'; done\n", received.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut first = connect(&fixture).await;
    let mut second = connect(&fixture).await;
    let create = json!({"action":"Create","payload":{"request_id":"create","id":"owned","cols":80,"rows":24,"cwd":dir.path(),"shell":script}});
    send(&mut first, create.clone()).await;
    let created = event(&mut first, "CreateResult").await;
    assert!(created["error"].is_null(), "{created}");
    let incarnation = created["incarnation"].clone();
    let child = fixture.server.sessions.read().get("owned").unwrap().clone();
    let pid = child.shell_pid().unwrap();
    send(&mut second, create).await;
    assert_eq!(
        event(&mut second, "CreateResult").await["error"]["code"],
        "conflict"
    );
    assert_eq!(fixture.server.sessions.read().len(), 1);
    assert_eq!(child.shell_pid(), Some(pid));
    let attach = json!({"action":"Attach","payload":{"request_id":"attach","id":"owned","incarnation":incarnation,"resume":null}});
    send(&mut first, attach.clone()).await;
    let attached = event(&mut first, "AttachResult").await;
    assert_eq!(attached["outcome"], "replay-from-start");
    let token = attached["attachment_id"].clone();
    let caught = event(&mut first, "StreamCaughtUp").await;
    let cut: u64 = caught["sequence"].as_str().unwrap().parse().unwrap();
    let write = |token: Value, text: &str| json!({"action":"Write","payload":{"id":"owned","incarnation":incarnation,"attachment_id":token,"data":text}});
    send(&mut first, write(token.clone(), "BEFORE_READY\n")).await;
    assert_eq!(
        event(&mut first, "OperationError").await["code"],
        "not-ready"
    );
    let ack = |sequence: String| json!({"action":"StreamApplied","payload":{"id":"owned","incarnation":incarnation,"attachment_id":token,"sequence":sequence}});
    send(&mut first, ack((cut + 1).to_string())).await;
    assert_eq!(
        event(&mut first, "OperationError").await["code"],
        "invalid-cut"
    );
    send(&mut second, attach.clone()).await;
    assert_eq!(event(&mut second, "AttachResult").await["outcome"], "busy");
    send(&mut first, ack(cut.to_string())).await;
    assert_eq!(
        event(&mut first, "AttachmentReady").await["attachment_id"],
        token
    );
    send(&mut second, write(token.clone(), "WRONG_SOCKET\n")).await;
    assert_eq!(event(&mut second, "OperationError").await["code"], "stale");
    send(&mut first, write(token.clone(), "ACCEPTED\n")).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while std::fs::read_to_string(&received).unwrap_or_default() != "ACCEPTED\n" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(child.is_alive());
    first.close(None).await.unwrap();
    let next = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            send(&mut second, attach.clone()).await;
            let next = event(&mut second, "AttachResult").await;
            if next["outcome"] != "busy" {
                break next;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(next["outcome"], "replay-from-start");
    assert_ne!(next["attachment_id"], token);
    assert_eq!(child.shell_pid(), Some(pid));
    let _ = event(&mut second, "StreamCaughtUp").await;
    send(&mut second, write(token, "OLD_TOKEN\n")).await;
    assert_eq!(event(&mut second, "OperationError").await["code"], "stale");
    assert_eq!(std::fs::read_to_string(received).unwrap(), "ACCEPTED\n");
}

async fn fixture() -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = Arc::new(Gateway::new().unwrap());
    let shared = server.clone();
    let task = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        connections.spawn(shared.clone().maintain());
        loop {
            tokio::select! {
                incoming = listener.accept() => {
                    let (stream, peer) = incoming.unwrap();
                    let server = shared.clone();
                    connections.spawn(async move {
                        crate::handle_connection_authenticated(stream, peer, server, Some("fixture-secret".into())).await;
                    });
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        }
    });
    Fixture {
        url: format!("ws://{addr}"),
        server,
        task,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn hooks_keep_source_identity_across_live_delivery_and_public_listener_reconnect() {
    if isolated("hooks_keep_source_identity_across_live_delivery_and_public_listener_reconnect") {
        return;
    }
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fixture = fixture().await;
    let incarnation = "a".repeat(32);
    let post = |event: &'static str| {
        let address = fixture.url.trim_start_matches("ws://").to_string();
        let incarnation = incarnation.clone();
        async move {
            let mut stream = TcpStream::connect(&address).await.unwrap();
            let body = json!({"event":event,"cwd":"/fixture"}).to_string();
            stream.write_all(format!("POST /hook/claude HTTP/1.1\r\nHost: {address}\r\nX-Doom-Term-Session: hook-pane\r\nX-Doom-Term-Incarnation: {incarnation}\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            let mut reply = String::new();
            stream.read_to_string(&mut reply).await.unwrap();
            assert!(reply.starts_with("HTTP/1.1 204"));
        }
    };
    post("PermissionRequest").await;
    let mut first = connect(&fixture).await;
    let ask = event(&mut first, "AgentEvent").await;
    assert_eq!(ask["phase"], "catch-up");
    assert_eq!(ask["incarnation"], incarnation);
    let mut second = connect(&fixture).await;
    let same_ask = event(&mut second, "AgentEvent").await;
    assert_eq!(same_ask["event_id"], ask["event_id"]);
    post("Stop").await;
    let first_stop = event(&mut first, "AgentEvent").await;
    let second_stop = event(&mut second, "AgentEvent").await;
    assert_eq!(first_stop["phase"], "live");
    assert_eq!(first_stop["event"], "Stop");
    assert_eq!(first_stop["event_id"], second_stop["event_id"]);
    assert_ne!(first_stop["event_id"], ask["event_id"]);
    second.close(None).await.unwrap();
    let mut again = connect(&fixture).await;
    let restored_stop = event(&mut again, "AgentEvent").await;
    assert_eq!(restored_stop["phase"], "catch-up");
    assert_eq!(restored_stop["event_id"], first_stop["event_id"]);
}

#[cfg(unix)]
#[tokio::test]
async fn metadata_requires_negotiation_and_returns_correlated_directory_and_unknown_telemetry() {
    if isolated(
        "metadata_requires_negotiation_and_returns_correlated_directory_and_unknown_telemetry",
    ) {
        return;
    }
    let fixture = fixture().await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("folder")).unwrap();
    std::fs::write(dir.path().join("visible.txt"), b"fixture").unwrap();
    std::fs::write(dir.path().join(".hidden"), b"fixture").unwrap();
    let browse =
        json!({"action":"BrowseDirectory","payload":{"request_id":"browse-one","path":dir.path()}});
    let telemetry = json!({"action":"GetTelemetry","payload":{"cwd":dir.path(),"session_id":"missing","incarnation":"1".repeat(32)}});
    let worktree = json!({"action":"CreateWorktree","payload":{"request_id":"worktree-no","cwd":dir.path(),"branch":"must-not-create"}});
    let (mut ws, _) = tokio_tungstenite::connect_async(&fixture.url)
        .await
        .unwrap();
    assert_eq!(receive(&mut ws).await["event"], "AuthResult");
    for command in [&browse, &telemetry, &worktree] {
        send(&mut ws, command.clone()).await;
        assert_eq!(receive(&mut ws).await["event"], "AuthResult");
    }
    send(
        &mut ws,
        json!({"action":"Auth","payload":{"token":"fixture-secret"}}),
    )
    .await;
    assert_eq!(receive(&mut ws).await["data"]["success"], true);
    assert_eq!(receive(&mut ws).await["event"], "Protocol");
    for command in [&browse, &telemetry, &worktree] {
        send(&mut ws, command.clone()).await;
        assert_eq!(receive(&mut ws).await["event"], "Incompatible");
    }
    send(
        &mut ws,
        json!({"action":"Negotiate","payload":{"version":2}}),
    )
    .await;
    assert_eq!(receive(&mut ws).await["event"], "Negotiated");
    send(&mut ws, browse).await;
    let listing = event(&mut ws, "DirectoryListing").await;
    assert_eq!(listing["request_id"], "browse-one");
    assert_eq!(listing["current_path"], dir.path().to_str().unwrap());
    let entries = listing["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["name"], "folder");
    assert_eq!(entries[1]["name"], "visible.txt");
    assert_eq!(listing["truncated"], false);
    send(&mut ws, telemetry).await;
    let telemetry = event(&mut ws, "Telemetry").await;
    assert_eq!(telemetry["session_id"], "missing");
    assert_eq!(telemetry["incarnation"], "1".repeat(32));
    assert_eq!(telemetry["current_dir"], dir.path().to_str().unwrap());
    for key in [
        "agent_key",
        "agent_name",
        "context_used",
        "rate_used",
        "agent_model",
        "git_branch",
    ] {
        assert!(telemetry[key].is_null(), "unobserved {key}: {telemetry}");
    }
    assert!(
        fixture.server.sessions.read().is_empty(),
        "metadata cannot create a process"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn metadata_directory_listing_has_a_wire_budget_and_reports_incompleteness() {
    if isolated("metadata_directory_listing_has_a_wire_budget_and_reports_incompleteness") {
        return;
    }
    let fixture = fixture().await;
    let mut ws = connect(&fixture).await;
    let dir = tempfile::tempdir().unwrap();
    for index in 0..2100 {
        std::fs::write(
            dir.path()
                .join(format!("file-{index:04}-{}", "a".repeat(180))),
            b"",
        )
        .unwrap();
    }
    send(
        &mut ws,
        json!({"action":"BrowseDirectory","payload":{"request_id":"bounded","path":dir.path()}}),
    )
    .await;
    let listing = event(&mut ws, "DirectoryListing").await;
    assert_eq!(listing["request_id"], "bounded");
    assert_eq!(listing["truncated"], true);
    assert!(!listing["entries"].as_array().unwrap().is_empty());
    assert!(listing["entries"].as_array().unwrap().len() <= 2048);
    assert!(serde_json::to_vec(&listing).unwrap().len() <= 256 * 1024);
    send(&mut ws, json!({"action":"Ping"})).await;
    assert_eq!(receive(&mut ws).await["event"], "Pong");
}

#[cfg(unix)]
#[tokio::test]
async fn metadata_worktree_replies_are_correlated_and_duplicate_requests_preserve_existing_work() {
    if isolated(
        "metadata_worktree_replies_are_correlated_and_duplicate_requests_preserve_existing_work",
    ) {
        return;
    }
    let fixture = fixture().await;
    let mut ws = connect(&fixture).await;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir(&source).unwrap();
    for args in [
        vec!["init", "-b", "trunk"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    ] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }
    use std::os::unix::fs::PermissionsExt;
    let hook = source.join(".git/hooks/post-checkout");
    std::fs::write(&hook, "#!/bin/sh\nsleep 0.4\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    for request in ["first", "duplicate"] {
        send(&mut ws, json!({"action":"CreateWorktree","payload":{"request_id":request,"cwd":source,"branch":"fixture/recovery"}})).await;
        if request == "first" {
            send(&mut ws, json!({"action":"Ping"})).await;
            let pong = tokio::time::timeout(Duration::from_millis(250), receive(&mut ws)).await;
            assert_eq!(
                pong.expect("metadata cannot stall ordinary socket dispatch")["event"],
                "Pong"
            );
        }
        let reply = event(&mut ws, "WorktreeCreated").await;
        assert_eq!(reply["request_id"], request);
        if request == "first" {
            assert!(reply["error"].is_null(), "{reply}");
            assert_eq!(reply["branch"], "fixture/recovery");
            assert!(std::path::Path::new(reply["path"].as_str().unwrap())
                .join(".git")
                .is_file());
        } else {
            assert!(reply["error"].is_string());
        }
    }
    assert!(dir
        .path()
        .join("source-worktree-fixture-recovery/.git")
        .is_file());
}

#[cfg(unix)]
#[tokio::test]
async fn recovery_cold_attach_rebuilds_only_the_surviving_durable_incarnation() {
    if isolated_durable("recovery_cold_attach_rebuilds_only_the_surviving_durable_incarnation") {
        return;
    }
    let original =
        doom_term_pty::PtySession::create("survivor".into(), 91, 27, None, Some("/bin/cat".into()))
            .unwrap();
    let before = original.stream().snapshot();
    let pid = original.shell_pid().unwrap();
    original.retire_adapter().unwrap();
    let fixture = fixture().await;
    let mut ws = connect(&fixture).await;
    let attach = json!({"action":"Attach","payload":{"request_id":"cold","id":"survivor","incarnation":before.metadata.incarnation}});
    send(
        &mut ws,
        json!({"action":"ListSessions","payload":{"request_id":"discover"}}),
    )
    .await;
    let discovered = event(&mut ws, "SessionListing").await;
    assert_eq!(discovered["request_id"], "discover");
    assert_eq!(discovered["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(discovered["sessions"][0]["id"], "survivor");
    assert_eq!(
        discovered["sessions"][0]["incarnation"],
        before.metadata.incarnation.as_str()
    );
    assert_eq!(discovered["sessions"][0]["root_pid"], pid);
    assert!(
        discovered["sessions"][0]["stream"].is_null(),
        "daemon loss cannot invent a stream checkpoint"
    );
    send(&mut ws, attach.clone()).await;
    let result = event(&mut ws, "AttachResult").await;
    assert_eq!(
        result["outcome"], "rebuild",
        "cold attach cannot create, silently miss, or pretend to resume"
    );
    let token = result["attachment_id"].clone();
    assert_eq!(
        result["descriptor"]["incarnation"],
        before.metadata.incarnation.as_str()
    );
    assert_ne!(
        result["descriptor"]["stream_epoch"],
        before.metadata.stream_epoch.as_str()
    );
    assert_eq!(result["descriptor"]["initial_cols"], 91);
    assert_eq!(result["descriptor"]["initial_rows"], 27);
    assert_eq!(receive(&mut ws).await["event"], "StreamBegin");
    let cut = loop {
        let message = receive(&mut ws).await;
        let data = &message["data"];
        match message["event"].as_str().unwrap() {
            "StreamRecord" => {}
            "StreamCaughtUp" => break data["sequence"].clone(),
            other => panic!("unexpected recovery event {other}: {message}"),
        }
    };
    let attached = fixture
        .server
        .sessions
        .read()
        .get("survivor")
        .unwrap()
        .clone();
    assert_eq!(attached.shell_pid(), Some(pid));
    send(&mut ws, json!({"action":"StreamApplied","payload":{"id":"survivor","incarnation":before.metadata.incarnation,"attachment_id":token,"sequence":cut}})).await;
    event(&mut ws, "AttachmentReady").await;
    send(&mut ws, json!({"action":"Write","payload":{"id":"survivor","incarnation":before.metadata.incarnation,"attachment_id":token,"data":"SAME_ROOT\n"}})).await;
    let output = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let message = receive(&mut ws).await;
            if message.to_string().contains("SAME_ROOT") {
                break message;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(output["event"], "StreamRecord");
    let mut second = connect(&fixture).await;
    send(&mut second, attach).await;
    assert_eq!(event(&mut second, "AttachResult").await["outcome"], "busy");
    assert_eq!(attached.shell_pid(), Some(pid));
}

#[cfg(unix)]
#[tokio::test]
async fn recovery_lost_lease_during_paste_preparation_never_delivers_its_private_buffer() {
    if isolated_durable(
        "recovery_lost_lease_during_paste_preparation_never_delivers_its_private_buffer",
    ) {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let real = doom_term_pty::tmux::resolve_tmux(None).unwrap();
    let wrapper = dir.path().join("tmux");
    let loaded = dir.path().join("loaded");
    let release = dir.path().join("release");
    let received = dir.path().join("received");
    std::fs::write(&wrapper, format!("#!/bin/sh\nif [ \"$4\" = load-buffer ]; then\n'{}' \"$@\" || exit $?\n: > '{}'\nwhile ! test -e '{}'; do sleep 0.01; done\nexit 0\nfi\nexec '{}' \"$@\"\n", real.display(), loaded.display(), release.display(), real.display())).unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut paths = vec![dir.path().to_path_buf()];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
    std::env::set_var("PATH", std::env::join_paths(paths).unwrap());
    let script = dir.path().join("receiver.sh");
    std::fs::write(&script, format!("#!/bin/sh\nstty -echo\nprintf '\\033[?2004hREADY'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\" >> '{}'; done\n", received.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = fixture().await;
    let mut first = connect(&fixture).await;
    let mut second = connect(&fixture).await;
    send(&mut first, json!({"action":"Create","payload":{"request_id":"create","id":"paste-race","cols":80,"rows":24,"shell":script}})).await;
    let incarnation = event(&mut first, "CreateResult").await["incarnation"].clone();
    let attach = json!({"action":"Attach","payload":{"request_id":"attach","id":"paste-race","incarnation":incarnation}});
    send(&mut first, attach.clone()).await;
    let token = event(&mut first, "AttachResult").await["attachment_id"].clone();
    let cut = event(&mut first, "StreamCaughtUp").await["sequence"].clone();
    send(&mut first, json!({"action":"StreamApplied","payload":{"id":"paste-race","incarnation":incarnation,"attachment_id":token,"sequence":cut}})).await;
    event(&mut first, "AttachmentReady").await;
    let handle = doom_term_pty::tmux::TmuxHandle::resolve_owned(
        real.clone(),
        "paste-race",
        &serde_json::from_value(incarnation.clone()).unwrap(),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while handle.query("#{bracket_paste_flag}").as_deref() != Some("1") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    send(&mut first, json!({"action":"Paste","payload":{"request_id":"lost","id":"paste-race","incarnation":incarnation,"attachment_id":token,"text":"OLD_LEASE\n"}})).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !loaded.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    first.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            send(&mut second, attach.clone()).await;
            if event(&mut second, "AttachResult").await["outcome"] != "busy" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    std::fs::write(&release, []).unwrap();
    // Wait for the bounded worker's private-buffer cleanup, not merely a
    // delay that might assert before the old command actually ran.
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let output = std::process::Command::new(&real)
                .args([
                    "-N",
                    "-L",
                    "doom-term",
                    "list-buffers",
                    "-F",
                    "#{buffer_name}",
                ])
                .output()
                .unwrap();
            if !String::from_utf8_lossy(&output.stdout).contains("doom-paste-") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        std::fs::read(&received).unwrap_or_default(),
        b"",
        "a prepared paste must recheck its lease before delivery"
    );
}

#[tokio::test]
async fn recovery_rejects_an_oversized_wire_frame_before_json_dispatch() {
    let fixture = fixture().await;
    let mut ws = connect(&fixture).await;
    // Too large even for the maximum escaped 1 MiB paste. The transport must
    // close, not allocate/parse it and report an ordinary protocol refusal.
    if let Err(error) = ws
        .send(Message::Text("x".repeat(7 * 1024 * 1024).into()))
        .await
    {
        assert!(
            matches!(error, tokio_tungstenite::tungstenite::Error::Io(_)),
            "unexpected local send failure: {error}"
        );
        assert!(fixture.server.sessions.read().is_empty());
        return; // Server may refuse from the declared frame length alone.
    }
    let next = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .unwrap();
    assert!(
        !matches!(next, Some(Ok(Message::Text(_)))),
        "oversized frame reached the JSON dispatcher: {next:?}"
    );
    assert!(fixture.server.sessions.read().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn recovery_disconnect_releases_ownership_even_while_an_accepted_write_is_blocked() {
    if isolated("recovery_disconnect_releases_ownership_even_while_an_accepted_write_is_blocked") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = fixture().await;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("not-reading.sh");
    let release = dir.path().join("release");
    std::fs::write(&script, format!("#!/bin/sh\nstty raw -echo\nprintf 'NOT_READING'\nwhile ! test -e '{}'; do sleep 0.01; done\ndd bs=65536 count=1 iflag=fullblock of=/dev/null 2>/dev/null\nprintf 'DRAINED'\nsleep 30\n", release.display()))
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut first = connect(&fixture).await;
    let mut second = connect(&fixture).await;
    send(&mut first, json!({"action":"Create","payload":{"request_id":"create","id":"blocked","cols":80,"rows":24,"shell":script}})).await;
    let incarnation = event(&mut first, "CreateResult").await["incarnation"].clone();
    let child = fixture
        .server
        .sessions
        .read()
        .get("blocked")
        .unwrap()
        .clone();
    // A cancelled spawn_blocking join cannot cancel a kernel write. Drain this
    // test-owned pipe before killing the fixture, on success AND assertion
    // failure, so Tokio runtime shutdown itself cannot hang the test harness.
    struct Unblock {
        release: std::path::PathBuf,
        child: Arc<doom_term_pty::PtySession>,
    }
    impl Drop for Unblock {
        fn drop(&mut self) {
            let _ = std::fs::write(&self.release, []);
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let journal = self.child.stream();
            let mut cursor = doom_term_pty::stream::Sequence::default();
            while std::time::Instant::now() < deadline {
                if let Ok(Some(record)) = journal.read_after(cursor) {
                    cursor = record.sequence;
                    if matches!(&record.payload, doom_term_pty::stream::StreamPayload::Event(doom_term_pty::DemuxEvent::Output { data }) if data.contains("DRAINED"))
                    {
                        break;
                    }
                } else {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            let _ = self.child.kill();
        }
    }
    let _unblock = Unblock {
        release,
        child: child.clone(),
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let journal = child.stream();
            let mut sequence = doom_term_pty::stream::Sequence::default();
            while let Some(record) = journal.read_after(sequence).unwrap() {
                sequence = record.sequence;
                if matches!(&record.payload, doom_term_pty::stream::StreamPayload::Event(doom_term_pty::DemuxEvent::Output { data }) if data.contains("NOT_READING")) { return; }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let attach = json!({"action":"Attach","payload":{"request_id":"attach","id":"blocked","incarnation":incarnation}});
    send(&mut first, attach.clone()).await;
    let token = event(&mut first, "AttachResult").await["attachment_id"].clone();
    let cut = event(&mut first, "StreamCaughtUp").await["sequence"].clone();
    send(&mut first, json!({"action":"StreamApplied","payload":{"id":"blocked","incarnation":incarnation,"attachment_id":token,"sequence":cut}})).await;
    event(&mut first, "AttachmentReady").await;
    // The raw-mode child never consumes input, so write_all fills the actual
    // kernel PTY buffer. A later queued Kill must not survive socket loss.
    send(&mut first, json!({"action":"Write","payload":{"id":"blocked","incarnation":incarnation,"attachment_id":token,"data":"x".repeat(65536)}})).await;
    send(&mut first, json!({"action":"Kill","payload":{"request_id":"discarded","id":"blocked","incarnation":incarnation,"attachment_id":token}})).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    first.close(None).await.unwrap();
    let next = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            send(&mut second, attach.clone()).await;
            let next = event(&mut second, "AttachResult").await;
            if next["outcome"] != "busy" {
                return next;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("disconnect must not wait for a blocked child write");
    assert_eq!(next["outcome"], "replay-from-start");
    assert_ne!(next["attachment_id"], token);
    assert!(
        child.is_alive(),
        "disconnect must neither replay the queued kill nor kill the process"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn recovery_can_kill_an_owned_root_after_it_closes_its_terminal_descriptors() {
    if isolated("recovery_can_kill_an_owned_root_after_it_closes_its_terminal_descriptors") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("closed-descriptors.sh");
    std::fs::write(&script, "#!/bin/sh\nexec 0<&- 1>&- 2>&-\nexec sleep 30\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = fixture().await;
    let mut ws = connect(&fixture).await;
    send(&mut ws, json!({"action":"Create","payload":{"request_id":"create","id":"no-terminal","cols":80,"rows":24,"shell":script}})).await;
    let incarnation = event(&mut ws, "CreateResult").await["incarnation"].clone();
    let child = fixture
        .server
        .sessions
        .read()
        .get("no-terminal")
        .unwrap()
        .clone();
    tokio::time::timeout(Duration::from_secs(3), async {
        while child.is_alive() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("test-owned root must actually close its PTY descriptors");
    assert!(child.stream().snapshot().process_exit.is_none());
    send(&mut ws, json!({"action":"Attach","payload":{"request_id":"attach","id":"no-terminal","incarnation":incarnation}})).await;
    let attached = event(&mut ws, "AttachResult").await;
    assert_eq!(attached["outcome"], "unreconstructable");
    send(&mut ws, json!({"action":"Kill","payload":{"request_id":"kill","id":"no-terminal","incarnation":incarnation,"attachment_id":attached["attachment_id"]}})).await;
    assert!(event(&mut ws, "KillResult").await["error"].is_null());
    tokio::time::timeout(Duration::from_secs(2), async {
        while child.stream().snapshot().process_exit.is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("explicit kill must reach the still-owned root without rendering readiness");
}

#[cfg(unix)]
#[tokio::test]
async fn recovery_paste_resize_signal_and_read_only_kill_keep_their_ownership_fences() {
    if isolated("recovery_paste_resize_signal_and_read_only_kill_keep_their_ownership_fences") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = fixture().await;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("paste.sh");
    let received = dir.path().join("paste.received");
    std::fs::write(&script, format!("#!/bin/sh\nstty raw -echo\nprintf '\\033[?2004hREADY'\ndd bs=1 count=15 of='{}' 2>/dev/null\nprintf DONE\nsleep 30\n", received.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut ws = connect(&fixture).await;
    send(&mut ws, json!({"action":"Create","payload":{"request_id":"create","id":"paste","cols":80,"rows":24,"cwd":dir.path(),"shell":script}})).await;
    let incarnation = event(&mut ws, "CreateResult").await["incarnation"].clone();
    send(&mut ws, json!({"action":"Attach","payload":{"request_id":"attach","id":"paste","incarnation":incarnation,"resume":null}})).await;
    let token = event(&mut ws, "AttachResult").await["attachment_id"].clone();
    let caught = event(&mut ws, "StreamCaughtUp").await;
    let envelope = |action: &str, extra: Value| {
        let mut payload = json!({"id":"paste","incarnation":incarnation,"attachment_id":token});
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({"action":action,"payload":payload})
    };
    for (action, extra, expected) in [
        (
            "Paste",
            json!({"request_id":"blocked","text":"A\r\nB"}),
            "PasteResult",
        ),
        ("Resize", json!({"cols":90,"rows":30}), "OperationError"),
        ("Signal", json!({"signal":"SIGINT"}), "OperationError"),
    ] {
        send(&mut ws, envelope(action, extra)).await;
        let reply = event(&mut ws, expected).await;
        if action == "Paste" {
            assert_eq!(reply["request_id"], "blocked");
            assert_eq!(reply["session_id"], "paste");
            assert!(reply["error"].as_str().unwrap().contains("not-ready"));
        } else {
            assert_eq!(reply["code"], "not-ready");
        }
    }
    send(
        &mut ws,
        envelope("StreamApplied", json!({"sequence":caught["sequence"]})),
    )
    .await;
    let _ = event(&mut ws, "AttachmentReady").await;
    send(
        &mut ws,
        envelope(
            "Paste",
            json!({"request_id":"oversize","text":"SECRET".repeat(200000)}),
        ),
    )
    .await;
    let oversized = event(&mut ws, "PasteResult").await;
    assert_eq!(oversized["request_id"], "oversize");
    assert_eq!(oversized["session_id"], "paste");
    let error = oversized["error"].as_str().unwrap();
    assert!(error.contains("1 MiB") && !error.contains("SECRET"));
    // Ensure the child has actually enabled bracketed paste, independently of
    // the frontend's catch-up mode. The daemon's PTY observation authorizes it.
    let child = fixture.server.sessions.read().get("paste").unwrap().clone();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let journal = child.stream();
            let mut cursor = doom_term_pty::stream::Sequence::new(0);
            let mut ready = false;
            while let Some(record) = journal.read_after(cursor).unwrap() {
                cursor = record.sequence;
                if matches!(
                    record.payload,
                    doom_term_pty::stream::StreamPayload::Event(
                        doom_term_pty::DemuxEvent::BracketedPasteMode { enabled: true }
                    )
                ) {
                    ready = true;
                }
            }
            if ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    send(&mut ws, envelope("Resize", json!({"cols":90,"rows":30}))).await;
    loop {
        let record = event(&mut ws, "StreamRecord").await;
        if record["record"]["payload"]["type"] == "Resize" {
            assert_eq!(
                record["record"]["payload"]["payload"],
                json!({"cols":90,"rows":30})
            );
            break;
        }
    }
    send(
        &mut ws,
        envelope("Paste", json!({"request_id":"delivered","text":"A\r\nB"})),
    )
    .await;
    let pasted = event(&mut ws, "PasteResult").await;
    assert_eq!(pasted["request_id"], "delivered");
    assert_eq!(pasted["session_id"], "paste");
    assert!(pasted["error"].is_null());
    tokio::time::timeout(Duration::from_secs(3), async {
        while std::fs::read(&received).unwrap_or_default() != b"\x1b[200~A\nB\x1b[201~" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // A rendering fault blocks input, but an explicit correlated kill remains
    // possible with the current ownership token.
    child
        .stream()
        .append(doom_term_pty::stream::StreamPayload::Fault {
            reason: doom_term_pty::stream::StreamFault::ControlTooLong,
        })
        .unwrap();
    send(&mut ws, envelope("Kill", json!({"request_id":"kill"}))).await;
    let killed = event(&mut ws, "KillResult").await;
    assert_eq!(killed["request_id"], "kill");
    assert_eq!(killed["session_id"], "paste");
    assert!(killed["error"].is_null());
    assert!(!child.is_alive());
}
async fn send(ws: &mut Socket, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn receive(ws: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match ws.next().await.unwrap().unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(_) | Message::Pong(_) => {
                    ws.flush().await.unwrap();
                }
                frame => panic!("Unexpected frame {frame:?}"),
            }
        }
    })
    .await
    .expect("bounded reply")
}

#[tokio::test]
async fn recovery_authentication_precedes_protocol_advertisement_and_discovery() {
    #[cfg(unix)]
    if isolated("recovery_authentication_precedes_protocol_advertisement_and_discovery") {
        return;
    }
    let fixture = fixture().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&fixture.url)
        .await
        .unwrap();
    let first = receive(&mut ws).await;
    assert_eq!(first["event"], "AuthResult");
    assert_eq!(first["data"]["success"], false);
    for command in [
        json!({"action":"ListSessions","payload":{"request_id":"no-discovery"}}),
        json!({"action":"Negotiate","payload":{"version":2}}),
        json!({"action":"Auth","payload":{"token":"incorrect"}}),
    ] {
        send(&mut ws, command).await;
        let reply = receive(&mut ws).await;
        assert_eq!(reply["event"], "AuthResult");
        assert_eq!(reply["data"]["success"], false);
    }
    send(
        &mut ws,
        json!({"action":"Auth","payload":{"token":"fixture-secret"}}),
    )
    .await;
    assert_eq!(receive(&mut ws).await["data"]["success"], true);
    let advertised = receive(&mut ws).await;
    assert_eq!(advertised["event"], "Protocol");
    assert_eq!(advertised["data"]["version"], 2);
    assert_eq!(
        advertised["data"]["daemon_epoch"].as_str().unwrap().len(),
        32
    );
    for command in [
        json!({"action":"ListSessions","payload":{"request_id":"not-negotiated"}}),
        json!({"action":"Spawn","payload":{"id":"must-not-exist","cols":80,"rows":24}}),
        json!({"action":"Write","payload":{"id":"must-not-exist","data":"do not run"}}),
        json!({"action":"Negotiate","payload":{"version":1}}),
    ] {
        send(&mut ws, command).await;
        assert_eq!(receive(&mut ws).await["event"], "Incompatible");
        assert!(fixture.server.sessions.read().is_empty());
    }
    send(
        &mut ws,
        json!({"action":"Negotiate","payload":{"version":2}}),
    )
    .await;
    let ready = receive(&mut ws).await;
    assert_eq!(ready["event"], "Negotiated");
    assert_eq!(
        ready["data"]["daemon_epoch"],
        advertised["data"]["daemon_epoch"]
    );
    send(
        &mut ws,
        json!({"action":"ListSessions","payload":{"request_id":"negotiated"}}),
    )
    .await;
    let listing = receive(&mut ws).await;
    assert_eq!(listing["event"], "SessionListing");
    assert_eq!(listing["data"]["request_id"], "negotiated");
    assert_eq!(listing["data"]["sessions"], json!([]));
    ws.close(None).await.unwrap();
}

#[tokio::test]
async fn recovery_transport_pings_and_expires_a_peer_that_stops_responding() {
    let fixture = fixture().await;
    let mut ws = connect(&fixture).await;
    let started = std::time::Instant::now();
    // Do not poll: tungstenite must not automatically answer the server's ping.
    // While the peer is silent, the server itself must enforce its deadline.
    tokio::time::sleep(Duration::from_secs(31)).await;
    // Inspect the actual wire without tungstenite auto-writing queued pongs to
    // the already-closed server. Doing so obscures the close with BrokenPipe.
    use tokio::io::AsyncReadExt;
    let mut wire = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(2),
        ws.get_mut().take(4096).read_to_end(&mut wire),
    )
    .await
    .expect("silent socket must already be closed")
    .unwrap();
    let mut pings = 0;
    let mut closed = None;
    let mut offset = 0;
    while offset < wire.len() {
        let opcode = wire[offset];
        let length = usize::from(wire[offset + 1]);
        assert!(
            length <= 125,
            "server control frames must be short and unmasked"
        );
        let payload = &wire[offset + 2..offset + 2 + length];
        match opcode {
            0x89 => pings += 1,
            0x88 => {
                assert_eq!(&payload[..2], &[3, 240]);
                closed = Some(String::from_utf8(payload[2..].to_vec()).unwrap());
            }
            _ => panic!("unexpected control frame opcode {opcode}"),
        }
        offset += 2 + length;
    }
    assert!(pings >= 2, "heartbeat must run before the 30-second expiry");
    assert!(closed.unwrap().contains("Liveness"));
    assert!(started.elapsed() < Duration::from_secs(33));
}

/// Concurrent creation of one id, and reservation release.
///
/// The existing two-controller test only sends its duplicate *after* the first
/// create has replied, so it is rejected by the finished sessions map and never
/// reaches `catalog.creating`. That reservation is what makes creation safe
/// while a spawn is still in flight, and it had no coverage.
#[cfg(unix)]
#[tokio::test]
async fn recovery_concurrent_creates_reserve_one_id_and_a_failed_create_releases_it() {
    if isolated("recovery_concurrent_creates_reserve_one_id_and_a_failed_create_releases_it") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = fixture().await;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("idle.sh");
    let finish = dir.path().join("finish");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nwhile ! test -e '{}'; do sleep 0.01; done\n",
            finish.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();

    // Every request is in flight before any reply is read, so the losers race
    // the winner's spawn rather than observing a finished session.
    let mut sockets = Vec::new();
    for _ in 0..4 {
        sockets.push(connect(&fixture).await);
    }
    let create = json!({"action":"Create","payload":{
        "request_id":"create","id":"reserved","cols":80,"rows":24,"shell":script,"cwd":null
    }});
    for ws in sockets.iter_mut() {
        send(ws, create.clone()).await;
    }

    let mut winners = Vec::new();
    let mut conflicts = 0;
    for ws in sockets.iter_mut() {
        let reply = event(ws, "CreateResult").await;
        if reply["error"].is_null() {
            winners.push(reply["incarnation"].clone());
        } else {
            assert_eq!(reply["error"]["code"], "conflict", "{reply}");
            conflicts += 1;
        }
    }
    assert_eq!(winners.len(), 1, "exactly one creator may win an id");
    assert_eq!(conflicts, 3, "every loser must be told conflict");
    assert_eq!(
        fixture.server.sessions.read().len(),
        1,
        "a lost race must not leave a second process behind"
    );
    // The surviving process is the winner's, not a loser's replacement.
    let live = fixture
        .server
        .sessions
        .read()
        .get("reserved")
        .unwrap()
        .clone();
    assert_eq!(
        json!(live.stream().snapshot().metadata.incarnation),
        winners[0],
        "the live pane must be the one whose create succeeded"
    );

    // A create that fails must release its reservation, or the id is poisoned
    // for the rest of the daemon's life.
    let failing = json!({"action":"Create","payload":{
        "request_id":"bad","id":"retry","cols":80,"rows":24,
        "shell":dir.path().join("does-not-exist"),"cwd":null
    }});
    send(&mut sockets[0], failing).await;
    let refused = event(&mut sockets[0], "CreateResult").await;
    assert!(
        !refused["error"].is_null(),
        "a missing shell cannot be created: {refused}"
    );
    assert!(
        !fixture.server.sessions.read().contains_key("retry"),
        "a failed create must not register a session"
    );
    let retry = json!({"action":"Create","payload":{
        "request_id":"retry","id":"retry","cols":80,"rows":24,"shell":script,"cwd":null
    }});
    send(&mut sockets[0], retry).await;
    let created = event(&mut sockets[0], "CreateResult").await;
    assert!(
        created["error"].is_null(),
        "a failed create must release its reservation: {created}"
    );
    std::fs::write(&finish, []).unwrap();
}

/// An evicted resume cursor must be an explicit refusal, never a silent skip.
///
/// Spec gate 4 requires bounded retention to produce *explicit* gaps while the
/// child keeps running. The journal reports `StreamError::Gap` below its
/// retained window, but nothing asserted what the daemon does with it: a
/// resume that silently continued from the wrong place would hand the frontend
/// a transcript with a hole in it and no way to know.
#[cfg(unix)]
#[tokio::test]
async fn recovery_an_evicted_resume_cursor_is_an_explicit_gap_not_a_silent_skip() {
    if isolated("recovery_an_evicted_resume_cursor_is_an_explicit_gap_not_a_silent_skip") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = fixture().await;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("idle.sh");
    let finish = dir.path().join("finish");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nwhile ! test -e '{}'; do sleep 0.01; done\n",
            finish.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut ws = connect(&fixture).await;
    send(
        &mut ws,
        json!({"action":"Create","payload":{
            "request_id":"create","id":"gapped","cols":80,"rows":24,"shell":script,"cwd":null
        }}),
    )
    .await;
    let created = event(&mut ws, "CreateResult").await;
    assert!(created["error"].is_null(), "{created}");
    let incarnation = created["incarnation"].clone();
    send(
        &mut ws,
        json!({"action":"Attach","payload":{
            "request_id":"attach","id":"gapped","incarnation":incarnation,"resume":null
        }}),
    )
    .await;
    let attached = event(&mut ws, "AttachResult").await;
    let epoch = attached["descriptor"]["stream_epoch"].clone();
    assert!(
        !epoch.is_null(),
        "attach must describe its stream: {attached}"
    );

    let child = fixture
        .server
        .sessions
        .read()
        .get("gapped")
        .unwrap()
        .clone();
    // Push the retained window past sequence 1 using the production record
    // bound, so the cursor below is genuinely evicted rather than merely old.
    for i in 0..9_000u32 {
        child
            .stream()
            .append(doom_term_pty::stream::StreamPayload::Event(
                doom_term_pty::demuxer::DemuxEvent::Output {
                    data: format!("line {i}\n"),
                },
            ))
            .unwrap();
    }
    assert!(
        child
            .stream()
            .read_after(doom_term_pty::stream::Sequence::new(1))
            .is_err(),
        "the fixture must actually evict sequence 1"
    );

    ws.close(None).await.unwrap();
    let mut next = connect(&fixture).await;
    let resume = json!({"action":"Attach","payload":{
        "request_id":"resume","id":"gapped","incarnation":incarnation,
        "resume":{"stream_epoch":epoch,"after_sequence":"1"}
    }});
    let outcome = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            send(&mut next, resume.clone()).await;
            let reply = event(&mut next, "AttachResult").await;
            if reply["outcome"] != "busy" {
                break reply;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the released lease must become attachable");
    assert_eq!(
        outcome["outcome"], "unreconstructable",
        "an evicted cursor must be refused explicitly, not resumed: {outcome}"
    );
    assert!(
        child.is_alive(),
        "a lost transcript is not a reason to end the child"
    );
    std::fs::write(&finish, []).unwrap();
}

/// A pane opens where it was told, even when the tmux server is in no
/// position to put it there.
///
/// `new-session -c <dir>` is an instruction, not a guarantee: a tmux SERVER
/// whose own working directory has been deleted discards it and starts every
/// new pane in that dead directory instead. The server is per-user and
/// deliberately outlives the app, and under an AppImage the app runs from a
/// FUSE mount that is torn down on exit — so a server left holding a detached
/// directory is the NORMAL state of the second launch, not an edge case. Every
/// terminal after that came up somewhere the user never asked for, with
/// `getcwd` failing and the shell printing "Transport endpoint is not
/// connected" before its first prompt.
///
/// This runs in the isolated child so it can move the process's own working
/// directory and then delete it, which is the only way to reproduce the
/// server's state, and is exactly what the harness exists for.
#[cfg(unix)]
#[tokio::test]
async fn a_pane_opens_in_the_requested_directory_even_when_the_server_lost_its_own() {
    if isolated_durable("a_pane_opens_in_the_requested_directory_even_when_the_server_lost_its_own")
    {
        return;
    }
    use std::os::unix::fs::PermissionsExt;

    let home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let doomed = home.path().join("gone");
    std::fs::create_dir(&doomed).unwrap();

    let reporter = |path: &std::path::Path| {
        let script = workspace.path().join(format!(
            "report-{}.sh",
            path.file_name().unwrap().to_string_lossy()
        ));
        // -P, because `pwd` without it prints $PWD, and $PWD in a tmux pane is
        // inherited from the server's environment rather than observed.
        std::fs::write(
            &script,
            format!("#!/bin/sh\npwd -P > '{}'\nexec cat\n", path.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        script
    };

    // Start the tmux server from a directory that is about to stop existing.
    std::env::set_current_dir(&doomed).unwrap();
    let fixture = fixture().await;
    let mut ws = connect(&fixture).await;
    let first_out = workspace.path().join("first");
    send(
        &mut ws,
        json!({"action":"Create","payload":{"request_id":"first","id":"first","cols":80,"rows":24,
            "cwd":workspace.path(),"shell":reporter(&first_out)}}),
    )
    .await;
    assert!(
        event(&mut ws, "CreateResult").await["error"].is_null(),
        "the first session must open"
    );

    // Now take it away. The server keeps running; its cwd is detached.
    std::env::set_current_dir("/").unwrap();
    std::fs::remove_dir(&doomed).unwrap();

    let second_out = workspace.path().join("second");
    send(
        &mut ws,
        json!({"action":"Create","payload":{"request_id":"second","id":"second","cols":80,"rows":24,
            "cwd":workspace.path(),"shell":reporter(&second_out)}}),
    )
    .await;
    assert!(event(&mut ws, "CreateResult").await["error"].is_null());

    let observed = |path: &std::path::Path| {
        for _ in 0..200 {
            if let Ok(text) = std::fs::read_to_string(path) {
                let text = text.trim().to_string();
                if !text.is_empty() {
                    return text;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("child never reported its directory: {}", path.display());
    };

    let wanted = std::fs::canonicalize(workspace.path()).unwrap();
    assert_eq!(std::path::Path::new(&observed(&first_out)), wanted);
    // The one that matters. Before the shell did its own chdir this was the
    // deleted directory, reported by the kernel as `…/gone (deleted)`.
    assert_eq!(std::path::Path::new(&observed(&second_out)), wanted);
}
