use super::*;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

async fn server() -> (SocketAddr, HookState, tokio::task::JoinHandle<()>) {
    server_with_token(None).await
}

async fn server_with_token(
    token: Option<String>,
) -> (SocketAddr, HookState, tokio::task::JoinHandle<()>) {
    // These security tests never enumerate the user's private tmux server.
    std::env::set_var("DOOM_TERM_NO_TMUX", "1");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = Arc::new(recovery::RecoveryServer::new().unwrap());
    let retained = server.hooks.clone();
    let task = tokio::spawn(async move {
        let (stream, peer) = listener.accept().await.unwrap();
        handle_connection_authenticated(stream, peer, server, token).await;
    });
    (addr, retained, task)
}

#[tokio::test]
async fn security_gates_commands_and_retained_hooks_on_authentication() {
    let (addr, state, task) = server_with_token(Some("fixture-secret".into())).await;
    remember_hook_state(
        &state,
        &ServerMessage::AgentEvent {
            agent: "claude".into(),
            event: "PermissionRequest".into(),
            cwd: Some("/fixture".into()),
            agent_session_id: None,
            doom_session_id: Some("fixture".into()),
        },
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .unwrap();
    let first = ws.next().await.unwrap().unwrap().into_text().unwrap();
    assert!(first.contains("Authentication required"));
    for command in [
        r#"{"action":"Paste","payload":{"request_id":"no-paste","id":"missing","text":"SECRET"}}"#,
        r#"{"action":"ListSessions","payload":{"request_id":"no"}}"#,
        r#"{"action":"Auth","payload":{"token":"incorrect"}}"#,
    ] {
        ws.send(Message::Text(command.into())).await.unwrap();
        let reply = ws.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(reply.contains("AuthResult") && reply.contains("\"success\":false"));
    }
    ws.send(Message::Text(
        r#"{"action":"Auth","payload":{"token":"fixture-secret"}}"#.into(),
    ))
    .await
    .unwrap();
    assert!(ws
        .next()
        .await
        .unwrap()
        .unwrap()
        .into_text()
        .unwrap()
        .contains("\"success\":true"));
    assert!(ws
        .next()
        .await
        .unwrap()
        .unwrap()
        .into_text()
        .unwrap()
        .contains("Protocol"));
    ws.send(Message::Text(
        r#"{"action":"Negotiate","payload":{"version":2}}"#.into(),
    ))
    .await
    .unwrap();
    assert!(ws
        .next()
        .await
        .unwrap()
        .unwrap()
        .into_text()
        .unwrap()
        .contains("Negotiated"));
    let restored: serde_json::Value =
        serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(restored["event"], "AgentEvent");
    assert_eq!(restored["data"]["phase"], "catch-up");
    assert!(
        serde_json::from_value::<pty::stream::Identity>(restored["data"]["event_id"].clone())
            .is_ok()
    );
    ws.send(Message::Text(
        r#"{"action":"ListSessions","payload":{"request_id":"yes"}}"#.into(),
    ))
    .await
    .unwrap();
    assert!(ws
        .next()
        .await
        .unwrap()
        .unwrap()
        .into_text()
        .unwrap()
        .contains("SessionListing"));
    ws.close(None).await.unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn security_accepts_native_hooks() {
    let (addr, state, task) = server().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let body = r#"{"cwd":"/security-fixture","event":"PermissionRequest"}"#;
    stream.write_all(format!("POST /hook/claude HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    task.await.unwrap();
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 204"));
    assert_eq!(state.subscribe().0.len(), 1);
}

#[tokio::test]
async fn security_rejects_foreign_origin_and_rebinding_host() {
    for (origin, host) in [
        ("http://attacker.invalid", None),
        ("null", None),
        ("http://localhost:1420", Some("attacker.invalid:1421")),
    ] {
        let (addr, _, task) = server().await;
        let mut request = format!("ws://{addr}").into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
        if let Some(host) = host {
            request.headers_mut().insert("Host", host.parse().unwrap());
        }
        let response = tokio_tungstenite::connect_async(request).await;
        task.abort();
        assert!(
            response.is_err(),
            "untrusted handshake was accepted: {origin} {host:?}"
        );
    }
}

#[tokio::test]
async fn security_rejects_browser_hook_without_changing_retained_state() {
    let (addr, state, task) = server().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let body = r#"{"cwd":"/security-fixture","event":"PermissionRequest"}"#;
    stream.write_all(format!("POST /hook/claude HTTP/1.1\r\nHost: {addr}\r\nOrigin: http://attacker.invalid\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    task.await.unwrap();
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 403"));
    assert!(state.subscribe().0.is_empty());
}

#[tokio::test]
async fn security_accepts_fragmented_trusted_upgrade() {
    let (addr, _, task) = server().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    stream.write_all(format!("Host: {addr}\r\nOrigin: http://localhost:1420\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").as_bytes()).await.unwrap();
    let mut buf = [0; 1024];
    let n = stream.read(&mut buf).await.unwrap();
    task.abort();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 101"));
}

// Bind-address coverage. These assert the daemon's production defaults, which a
// fixture binding to 127.0.0.1:0 does not exercise. They were lost when the
// legacy `mod tests` was disabled behind `#[cfg(any())]`; `listen_addr` and
// `loopback_host` are both still live code.

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

#[test]
fn a_non_loopback_doom_host_is_refused_before_it_can_bind() {
    for remote in [
        "0.0.0.0",
        "::",
        "192.168.1.10",
        "example.com",
        "10.0.0.1",
        "169.254.169.254",
    ] {
        assert!(
            !security::loopback_host(remote),
            "{remote} must not be accepted as a loopback bind host"
        );
    }
    for local in ["localhost", "127.0.0.1", "::1", "[::1]"] {
        assert!(security::loopback_host(local), "{local} is loopback");
    }
}

#[tokio::test]
async fn artifact_post_and_get_endpoints_work() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = Arc::new(recovery::RecoveryServer::new().unwrap());
    let server_clone = server.clone();
    tokio::spawn(async move {
        while let Ok((stream, peer)) = listener.accept().await {
            handle_connection_authenticated(stream, peer, server_clone.clone(), None).await;
        }
    });

    let body = r##"{"id":"test-pr-1","title":"PR Walkthrough","type":"markdown","content":"# Summary\nAll tests pass."}"##;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(
            format!(
                "POST /artifact HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();

    let mut resp = Vec::new();
    stream.read_to_end(&mut resp).await.unwrap();
    let resp_str = String::from_utf8_lossy(&resp);
    assert!(resp_str.starts_with("HTTP/1.1 200 OK"));
    assert!(resp_str.contains("test-pr-1"));

    // Now GET /artifact/test-pr-1
    let mut stream2 = TcpStream::connect(addr).await.unwrap();
    stream2
        .write_all(
            format!(
                "GET /artifact/test-pr-1 HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut resp2 = Vec::new();
    stream2.read_to_end(&mut resp2).await.unwrap();
    let resp_str2 = String::from_utf8_lossy(&resp2);
    assert!(resp_str2.starts_with("HTTP/1.1 200 OK"));
    assert!(resp_str2.contains("PR Walkthrough"));
    assert!(resp_str2.contains("All tests pass."));

    // Now GET /artifact/test-pr-1/raw
    let mut stream3 = TcpStream::connect(addr).await.unwrap();
    stream3
        .write_all(
            format!(
                "GET /artifact/test-pr-1/raw HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut resp3 = Vec::new();
    stream3.read_to_end(&mut resp3).await.unwrap();
    let resp_str3 = String::from_utf8_lossy(&resp3);
    assert!(resp_str3.starts_with("HTTP/1.1 200 OK"));
    assert!(resp_str3.contains("# Summary\nAll tests pass."));
}

#[tokio::test]
async fn security_serves_cli_artifact_and_hook_scripts() {
    let (addr, _, task) = server().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(
            format!(
                "GET /doom-term-artifact HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf);
    assert!(text.starts_with("HTTP/1.1 200 OK"));
    assert!(text.contains("Content-Type: text/x-shellscript"));
    assert!(text.contains("Doom Term Artifact Publisher"));
    task.await.unwrap();
}

#[test]
fn provision_cli_tools_creates_executable_helpers() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_str().unwrap().to_string();
    let orig_home = std::env::var("HOME").ok();
    std::env::set_var("HOME", &home);

    provision_cli_tools();

    if let Some(h) = orig_home {
        std::env::set_var("HOME", h);
    }

    let artifact_bin = tmp
        .path()
        .join(".local")
        .join("bin")
        .join("doom-term-artifact");
    assert!(artifact_bin.exists());
    let content = std::fs::read_to_string(&artifact_bin).unwrap();
    assert!(content.contains("Doom Term Artifact Publisher"));

    let doom_bin = tmp
        .path()
        .join(".doom-term")
        .join("bin")
        .join("doom-term-artifact");
    assert!(doom_bin.exists());

    // Named by the same constant the daemon provisions from: this file is
    // doom-term-hook.ps1 on Windows, and a literal here would assert the wrong
    // name on the one platform where the name is the interesting part.
    let hook_file = tmp
        .path()
        .join(".doom-term")
        .join("agent-hooks")
        .join(HOOK_SCRIPT_NAME);
    assert!(hook_file.exists());
    let hook_content = std::fs::read_to_string(&hook_file).unwrap();
    assert!(hook_content.contains("Doom Term agent hook"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&artifact_bin)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
    }
}

/// Accepts every connection on its own task: the artifact event stream is
/// long-lived, so a sequential accept loop would wedge behind it.
async fn concurrent_server() -> SocketAddr {
    std::env::set_var("DOOM_TERM_NO_TMUX", "1");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = Arc::new(recovery::RecoveryServer::new().unwrap());
    tokio::spawn(async move {
        while let Ok((stream, peer)) = listener.accept().await {
            let server = server.clone();
            tokio::spawn(async move {
                handle_connection_authenticated(stream, peer, server, None).await;
            });
        }
    });
    addr
}

async fn post_artifact(addr: SocketAddr, id: &str, content: &str) {
    let body = serde_json::json!({
        "id": id,
        "title": "Live Reload Fixture",
        "type": "markdown",
        "content": content,
    })
    .to_string();
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(
            format!(
                "POST /artifact HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200 OK"));
}

/// Reads one byte at a time so the stream is never consumed past `delim`.
async fn read_until(stream: &mut TcpStream, delim: &str) -> String {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let mut byte = [0u8; 1];
        let read = tokio::time::timeout_at(deadline, stream.read(&mut byte))
            .await
            .unwrap_or_else(|_| panic!("timed out; got {:?}", String::from_utf8_lossy(&out)))
            .expect("event stream read failed");
        if read == 0 {
            break;
        }
        out.push(byte[0]);
        if out.ends_with(delim.as_bytes()) {
            break;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::test]
async fn artifact_event_stream_wakes_only_the_page_that_owns_the_artifact() {
    let addr = concurrent_server().await;
    post_artifact(addr, "live-1", "# v1").await;
    post_artifact(addr, "other-1", "# unrelated").await;

    let mut events = TcpStream::connect(addr).await.unwrap();
    events
        .write_all(
            format!("GET /artifact/live-1/events HTTP/1.1\r\nHost: {addr}\r\nAccept: text/event-stream\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();

    let head = read_until(&mut events, "\r\n\r\n").await;
    assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
    assert!(head.contains("Content-Type: text/event-stream"), "{head}");
    // No CORS grant: a site the user happens to be browsing must not be able to
    // watch which artifacts a local agent is publishing.
    assert!(
        !head
            .to_ascii_lowercase()
            .contains("access-control-allow-origin"),
        "{head}"
    );

    // Primed with the version held right now, so a page that reconnects after a
    // missed update still settles on the truth.
    let primed = read_until(&mut events, "\n\n").await;
    assert!(primed.contains("\"version\":1"), "{primed}");

    // An unrelated artifact must not wake this stream; its own must.
    post_artifact(addr, "other-1", "# unrelated v2").await;
    post_artifact(addr, "live-1", "# v2").await;

    let event = read_until(&mut events, "\n\n").await;
    assert!(event.contains("\"id\":\"live-1\""), "{event}");
    assert!(event.contains("\"version\":2"), "{event}");
    assert!(!event.contains("other-1"), "{event}");
}

#[tokio::test]
async fn artifact_event_stream_is_not_found_for_an_unknown_artifact() {
    let addr = concurrent_server().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(
            format!("GET /artifact/no-such-thing/events HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 404"));
}

#[tokio::test]
async fn the_daemons_own_origin_still_cannot_open_the_terminal_socket() {
    // An `html` artifact is agent-authored JavaScript running on the daemon's
    // own origin. Live reload must never be bought by admitting that origin to
    // the socket that drives PTYs.
    let (addr, _, task) = server().await;
    let mut request = format!("ws://{addr}").into_client_request().unwrap();
    request.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{}", addr.port()).parse().unwrap(),
    );
    let response = tokio_tungstenite::connect_async(request).await;
    task.abort();
    assert!(
        response.is_err(),
        "the artifact origin was admitted to the terminal socket"
    );
}
