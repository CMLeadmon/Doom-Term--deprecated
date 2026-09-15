#![cfg(unix)]

use doom_term_pty::{
    stream::{Sequence, StreamPayload},
    DemuxEvent, PtySession,
};
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

fn isolated(test: &str, tmux: bool) -> bool {
    if std::env::var_os("DOOM_PASTE_TEST_CHILD").is_some() {
        return false;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--nocapture"])
        .env("DOOM_PASTE_TEST_CHILD", "1")
        .env("TMUX_TMPDIR", dir.path())
        .env_remove("TMUX")
        .env_remove("TMUX_PANE");
    if tmux {
        command.env_remove("DOOM_TERM_NO_TMUX");
    } else {
        command.env("DOOM_TERM_NO_TMUX", "1");
    }
    let result = command.output().unwrap();
    if tmux {
        let _ = std::process::Command::new("tmux")
            .env("TMUX_TMPDIR", dir.path())
            .args(["-L", "doom-term", "kill-server"])
            .output();
    }
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    true
}

struct Fixture {
    session: PtySession,
    dir: tempfile::TempDir,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.session.kill();
    }
}

impl Fixture {
    fn new(id: &str, mode: &str, expected_len: usize) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("paste-child.sh");
        std::fs::write(&script, format!(
            "#!/bin/sh\nstty raw -echo\nprintf '{mode}READY'\ndd bs=1 count={expected_len} of=received 2>/dev/null\nprintf DONE\nsleep 30\n"
        )).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let session = PtySession::create(
            id.into(),
            80,
            24,
            Some(dir.path().display().to_string()),
            Some(script.display().to_string()),
        )
        .unwrap();
        let fixture = Self { session, dir };
        fixture.wait_for("READY");
        fixture
    }

    fn wait_for(&self, marker: &str) {
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut output = String::new();
        let journal = self.session.stream();
        let mut cursor = Sequence::default();
        while Instant::now() < deadline {
            while let Some(record) = journal.read_after(cursor).unwrap() {
                cursor = record.sequence;
                if let StreamPayload::Event(DemuxEvent::Output { data }) = record.payload {
                    output.push_str(&data);
                }
            }
            if output.contains(marker) {
                return;
            }
            journal.wait_for_change(cursor, Duration::from_millis(50));
        }
        panic!("child did not report {marker}: {output:?}");
    }

    fn received(&self) -> Vec<u8> {
        self.wait_for("DONE");
        std::fs::read(self.dir.path().join("received")).unwrap()
    }
}

#[test]
fn direct_paste_checks_child_mode_and_preserves_literal_bytes() {
    if isolated(
        "direct_paste_checks_child_mode_and_preserves_literal_bytes",
        false,
    ) {
        return;
    }
    for (i, mode) in ["", "\\033[?2004h\\033[?2004l", "\\033[?2004h\\033c"]
        .iter()
        .enumerate()
    {
        let fixture = Fixture::new(&format!("direct-off-{i}"), mode, 2);
        assert!(fixture.session.paste("SHOULD_NOT_ARRIVE\rnext").is_err());
        fixture.session.paste("\x00\x03\x1b").unwrap();
        fixture.session.paste("OK").unwrap();
        assert_eq!(fixture.received(), b"OK");
    }
    let expected = b"\x1b[200~'\"\xe4\xb8\x89\tA\nB[201~\x1b[201~";
    let fixture = Fixture::new("direct-on", "\\033[?2004h", expected.len());
    fixture.session.paste("'\"三\tA\r\nB\x03\x1b[201~").unwrap();
    assert_eq!(fixture.received(), expected);
    let fixture = Fixture::new("direct-single-on", "\\033[?2004h", 14);
    fixture.session.paste("OK").unwrap();
    assert_eq!(fixture.received(), b"\x1b[200~OK\x1b[201~");
}

#[test]
fn tmux_paste_checks_inner_mode_targets_exact_pane_and_cleans_buffers() {
    if isolated(
        "tmux_paste_checks_inner_mode_targets_exact_pane_and_cleans_buffers",
        true,
    ) {
        return;
    }
    let off = Fixture::new("paste-off", "\\033[?2004l", 2);
    let expected = b"\x1b[200~'\"\xe4\xb8\x89\tA\nB[201~\x1b[201~";
    let on = Fixture::new("paste-on", "\\033[?2004h", expected.len());
    assert!(off.session.is_durable(), "real tmux is required");
    assert!(on.session.is_durable());
    let error = off.session.paste("NOT_SENT\rnext").unwrap_err();
    assert!(
        error.to_string().contains("Multiline paste blocked"),
        "{error:#}"
    );
    assert_no_buffers();
    on.session.paste("'\"三\tA\r\nB\x03\x1b[201~").unwrap();
    assert_eq!(on.received(), expected);
    assert_no_buffers();
    off.session.paste("OK").unwrap();
    assert_eq!(off.received(), b"OK");
    assert_no_buffers();
}

fn assert_no_buffers() {
    let result = std::process::Command::new("tmux")
        .args(["-L", "doom-term", "list-buffers", "-F", "#{buffer_name}"])
        .output()
        .unwrap();
    assert!(result.status.success());
    assert!(
        result.stdout.is_empty(),
        "paste leaked a tmux buffer: {:?}",
        result.stdout
    );
}

#[test]
fn tmux_paste_failure_cleans_only_its_buffer_and_never_matches_a_session_prefix() {
    if isolated(
        "tmux_paste_failure_cleans_only_its_buffer_and_never_matches_a_session_prefix",
        true,
    ) {
        return;
    }
    let keeper = Fixture::new("keeper", "", 2);
    let target = Fixture::new("paste-target-long", "\\033[?2004h", 2);
    let exe = doom_term_pty::tmux::resolve_tmux(None).unwrap();
    let missing = doom_term_pty::tmux::TmuxHandle::named(exe.clone(), "doom-paste-target".into());
    assert!(missing.paste("not sent").is_err());
    assert_no_buffers();
    assert!(std::process::Command::new(&exe)
        .args(["-L", "doom-term", "set-buffer", "-b", "foreign", "keep"])
        .status()
        .unwrap()
        .success());
    let wrapper = keeper.dir.path().join("tmux-failure.sh");
    std::fs::write(&wrapper, format!(
        "#!/bin/sh\n'{}' \"$@\" || exit $?\nif [ \"$4\" = load-buffer ]; then\n'{}' -L doom-term kill-session -t '=doom-paste-target-long'\nfi\n",
        exe.display(), exe.display()
    )).unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let failed = doom_term_pty::tmux::TmuxHandle::named(wrapper, "doom-paste-target-long".into());
    assert!(failed.paste("not sent").is_err());
    let buffers = std::process::Command::new(&exe)
        .args(["-L", "doom-term", "list-buffers", "-F", "#{buffer_name}"])
        .output()
        .unwrap();
    assert_eq!(buffers.stdout, b"foreign\n");
    let foreign = std::process::Command::new(&exe)
        .args(["-L", "doom-term", "save-buffer", "-b", "foreign", "-"])
        .output()
        .unwrap();
    assert_eq!(foreign.stdout, b"keep");
    drop(target);
}
