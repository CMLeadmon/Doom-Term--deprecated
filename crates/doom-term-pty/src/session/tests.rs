use super::*;
use std::time::{Duration, Instant};

#[test]
fn a_display_client_exit_does_not_close_the_surviving_pane() {
    if std::env::var_os("DOOM_DISPLAY_EXIT_TEST_CHILD").is_none() {
        let dir = tempfile::tempdir().unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "session::tests::a_display_client_exit_does_not_close_the_surviving_pane",
                "--nocapture",
            ])
            .env("DOOM_DISPLAY_EXIT_TEST_CHILD", "1")
            .env("TMUX_TMPDIR", dir.path())
            .env_remove("DOOM_TERM_NO_TMUX")
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
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
        return;
    }
    let session =
        PtySession::create("display".into(), 80, 24, None, Some("/bin/cat".into())).unwrap();
    assert!(session.is_durable());
    let pid = session.shell_pid().unwrap();
    session.child.lock().as_mut().unwrap().kill().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !session.stream().snapshot().ended && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        session.shell_pid(),
        Some(pid),
        "only the owned display client was killed"
    );
    assert!(
        matches!(
            session.stream().snapshot().termination,
            Some(crate::stream::StreamEnd::Fault { .. })
        ),
        "losing the rendering adapter must not become a process-closed tombstone"
    );
    session.kill().unwrap();
}

#[test]
fn a_natural_durable_pane_exit_is_observed_as_process_closure() {
    if std::env::var_os("DOOM_DURABLE_EXIT_TEST_CHILD").is_none() {
        let dir = tempfile::tempdir().unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "session::tests::a_natural_durable_pane_exit_is_observed_as_process_closure",
                "--nocapture",
            ])
            .env("DOOM_DURABLE_EXIT_TEST_CHILD", "1")
            .env("TMUX_TMPDIR", dir.path())
            .env_remove("DOOM_TERM_NO_TMUX")
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
        return;
    }
    // The root must outlive its own bootstrap. `/bin/false` exits in
    // milliseconds and races the display-client handshake in
    // open_durable_adapter, so creation itself intermittently failed with
    // "Durable display attachment failed" - the adapter-loss case this test
    // exists to stay distinct from.
    use std::os::unix::fs::PermissionsExt;
    let script_dir = tempfile::tempdir().unwrap();
    let script = script_dir.path().join("exit-when-told.sh");
    let finish = script_dir.path().join("finish");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nwhile ! test -e '{}'; do sleep 0.01; done\nexit 0\n",
            finish.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let session = PtySession::create(
        "durable-exit".into(),
        80,
        24,
        None,
        Some(script.to_string_lossy().into_owned()),
    )
    .unwrap();
    assert!(session.is_durable());
    std::fs::write(&finish, []).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while session.stream().snapshot().process_exit.is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let snapshot = session.stream().snapshot();
    assert!(
        snapshot.process_exit.is_some(),
        "natural durable exit was mislabeled as adapter loss: {:?}",
        snapshot.termination
    );
    assert_eq!(
        snapshot.process_exit.unwrap().exit_code,
        None,
        "tmux cannot prove the pane root's exit status"
    );
}

#[test]
fn a_reaped_direct_handle_cannot_signal_a_reused_numeric_pid() {
    if std::env::var_os("DOOM_DIRECT_KILL_TEST_CHILD").is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "session::tests::a_reaped_direct_handle_cannot_signal_a_reused_numeric_pid",
                "--nocapture",
            ])
            .env("DOOM_DIRECT_KILL_TEST_CHILD", "1")
            .env("DOOM_TERM_NO_TMUX", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    let mut old =
        PtySession::create("old".into(), 80, 24, None, Some("/bin/false".into())).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !old.stream().snapshot().ended && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        old.child.lock().is_none(),
        "the old process must actually have been reaped"
    );
    let victim =
        PtySession::create("victim".into(), 80, 24, None, Some("/bin/cat".into())).unwrap();
    struct Cleanup<'a>(&'a PtySession);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = self.0.kill();
        }
    }
    let _cleanup = Cleanup(&victim);
    // Model PID reuse with a second real, test-owned process. No user process
    // is targeted and no kernel PID allocator is changed by the fixture.
    old.child_pid = victim.child_pid;
    assert!(
        old.kill().is_err(),
        "a numeric pid without the owned Child is not authority to signal"
    );
    victim.write(b"STILL_OWNED\n").unwrap();
    let journal = victim.stream();
    let mut cursor = crate::stream::Sequence::new(0);
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        while let Some(record) = journal.read_after(cursor).unwrap() {
            cursor = record.sequence;
            if matches!(record.payload, StreamPayload::Event(DemuxEvent::Output { data }) if data.contains("STILL_OWNED"))
            {
                return;
            }
        }
        journal.wait_for_change(cursor, Duration::from_millis(20));
    }
    panic!("the second real process did not survive the stale kill attempt");
}

#[test]
fn augmented_path_prepends_user_bins_when_missing() {
    // Arguments, not `std::env::set_var`. The environment is process-global:
    // this test used to point HOME at `/custom/user` for as long as it ran, and
    // every PTY a concurrently running test spawned inherited that as its
    // working directory and failed to start. See `augment_path`.
    let aug = augment_path("/custom/user", "/usr/bin:/bin").unwrap();
    assert!(aug.starts_with("/custom/user/.local/bin:/custom/user/.doom-term/bin:/usr/bin:/bin"));

    // When already in PATH, returns None
    assert!(augment_path("/custom/user", &aug).is_none());
}

#[test]
fn the_working_directory_is_anchored_somewhere_that_outlives_the_app() {
    /*
     * Nothing we spawn may inherit the directory an AppImage runs from.
     * `AppRun` chdirs into the FUSE mount and the mount is gone once the app
     * exits, while the tmux server started from it is not — surviving the app
     * is the substrate's whole purpose. A tmux server holding a deleted
     * directory silently ignores `new-session -c` and opens every later pane
     * in the dead one, which is how a fresh terminal came up at
     * `/tmp/.mount_DoomTeKMdGLL/usr` with `getcwd` failing.
     *
     * The choice is tested, not the chdir: see the note on the function.
     */
    let home = std::path::Path::new("/home/u");
    assert_eq!(
        anchor_candidates(Some(home)),
        vec![
            std::path::PathBuf::from("/home/u"),
            std::path::PathBuf::from("/"),
        ]
    );
}

#[test]
fn a_user_with_no_home_still_gets_off_the_mount() {
    // Root is always there, and it is never a filesystem we brought with us.
    assert_eq!(
        anchor_candidates(None),
        vec![std::path::PathBuf::from("/")]
    );
}
