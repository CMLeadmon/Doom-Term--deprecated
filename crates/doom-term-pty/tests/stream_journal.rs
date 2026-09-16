use doom_term_pty::stream::{
    Identity, JournalHub, Sequence, StreamError, StreamMetadata, StreamPayload,
};
use doom_term_pty::DemuxEvent;

fn isolated(test: &str) -> bool {
    if std::env::var_os("DOOM_JOURNAL_TEST_CHILD").is_some() {
        return false;
    }
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env("DOOM_JOURNAL_TEST_CHILD", "1")
        .env("DOOM_TERM_NO_TMUX", "1")
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

fn metadata(id: &str) -> StreamMetadata {
    StreamMetadata::new(id.into(), Identity::random().unwrap(), 80, 24, false).unwrap()
}

fn output(text: &str) -> StreamPayload {
    StreamPayload::Event(DemuxEvent::Output { data: text.into() })
}

#[test]
fn retains_more_than_500_events_and_reads_by_contiguous_cursor() {
    let hub = JournalHub::default();
    let stream = hub.open(metadata("shell")).unwrap();
    for _ in 0..600 {
        stream.append(output("x")).unwrap();
    }
    assert_eq!(stream.snapshot().high_water, Sequence::new(600));
    let first = stream.read_after(Sequence::new(0)).unwrap().unwrap();
    assert_eq!(first.sequence, Sequence::new(1));
    let last = stream.read_after(Sequence::new(599)).unwrap().unwrap();
    assert_eq!(last.sequence, Sequence::new(600));
    assert!(stream.read_after(Sequence::new(600)).unwrap().is_none());
    assert_eq!(
        stream.read_after(Sequence::new(601)).unwrap_err(),
        StreamError::FutureCursor
    );
}

#[test]
fn a_cursor_overtaken_by_record_eviction_is_a_gap_not_a_raw_tail() {
    let hub = JournalHub::default();
    let stream = hub.open(metadata("busy")).unwrap();
    for _ in 0..8193 {
        stream.append(output("x")).unwrap();
    }
    assert_eq!(stream.snapshot().retained_records, 8192);
    assert_eq!(stream.snapshot().first_retained, Some(Sequence::new(2)));
    assert_eq!(
        stream.read_after(Sequence::new(0)).unwrap_err(),
        StreamError::Gap
    );
    assert_eq!(
        stream
            .read_after(Sequence::new(1))
            .unwrap()
            .unwrap()
            .sequence,
        Sequence::new(2)
    );
}

#[test]
fn closed_stream_preserves_known_outcome_and_refuses_more_records() {
    let stream = JournalHub::default().open(metadata("closed")).unwrap();
    stream.append(output("last output")).unwrap();
    stream
        .append(StreamPayload::Closed { exit_code: Some(7) })
        .unwrap();
    assert!(stream.snapshot().ended);
    assert!(matches!(
        stream
            .read_after(Sequence::new(1))
            .unwrap()
            .unwrap()
            .payload,
        StreamPayload::Closed { exit_code: Some(7) }
    ));
    assert_eq!(
        stream.append(output("late")).unwrap_err(),
        StreamError::Ended
    );
}

#[test]
fn releasing_the_last_stream_handle_releases_its_retention_budget() {
    let hub = JournalHub::default();
    let stream = hub.open(metadata("owned")).unwrap();
    stream.append(output("sensitive transcript")).unwrap();
    let clone = stream.clone();
    drop(stream);
    assert!(hub.retained_bytes() > 0);
    drop(clone);
    assert_eq!(hub.retained_bytes(), 0);
}

// POSIX fixture, not POSIX behaviour. What this pins — exit-code propagation,
// journal ordering, fault handling — is platform-independent, but the programs
// it drives (`/bin/false`, `/bin/cat`, a `#!/bin/sh` script) have no honest
// one-binary Windows equivalent: CreateProcessW cannot exec a `.cmd`, and
// translating sh into cmd would test the translation. Windows gets its own
// ConPTY-native fixture below rather than a transliteration of this one.
#[cfg(unix)]
#[test]
fn process_exit_is_not_a_fabricated_semantic_command_completion() {
    if isolated("process_exit_is_not_a_fabricated_semantic_command_completion") {
        return;
    }
    let session = doom_term_pty::PtySession::create(
        "exit-only".into(),
        80,
        24,
        None,
        Some("/bin/false".into()),
    )
    .unwrap();
    let journal = session.stream();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !journal.snapshot().ended && std::time::Instant::now() < deadline {
        journal.wait_for_change(
            journal.snapshot().high_water,
            std::time::Duration::from_millis(20),
        );
    }
    assert!(journal.snapshot().ended);
    let mut cursor = Sequence::new(0);
    let mut commands = 0;
    let mut closed = None;
    while let Some(record) = journal.read_after(cursor).unwrap() {
        cursor = record.sequence;
        match record.payload {
            StreamPayload::Event(DemuxEvent::ExecutionEnd { .. }) => commands += 1,
            StreamPayload::Closed { exit_code } => closed = Some(exit_code),
            _ => {}
        }
    }
    assert_eq!(closed, Some(Some(1)));
    assert_eq!(
        commands, 0,
        "process closure is not an observed OSC 133 command boundary"
    );
}

// POSIX fixture, not POSIX behaviour. What this pins — exit-code propagation,
// journal ordering, fault handling — is platform-independent, but the programs
// it drives (`/bin/false`, `/bin/cat`, a `#!/bin/sh` script) have no honest
// one-binary Windows equivalent: CreateProcessW cannot exec a `.cmd`, and
// translating sh into cmd would test the translation. Windows gets its own
// ConPTY-native fixture below rather than a transliteration of this one.
#[cfg(unix)]
#[test]
fn real_pty_output_and_successful_resize_are_in_the_same_stream() {
    if isolated("real_pty_output_and_successful_resize_are_in_the_same_stream") {
        return;
    }
    let session = doom_term_pty::PtySession::create(
        format!("journal-{}", std::process::id()),
        80,
        24,
        None,
        Some("/bin/cat".into()),
    )
    .unwrap();
    let result = || {
        session.write(b"journal-before-resize\n").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        let journal = session.stream();
        let mut cursor = Sequence::default();
        let mut seen = false;
        while std::time::Instant::now() < deadline {
            while let Some(record) = journal.read_after(cursor).unwrap() {
                cursor = record.sequence;
                if matches!(record.payload, StreamPayload::Event(DemuxEvent::Output { ref data }) if data.contains("journal-before-resize"))
                {
                    seen = true;
                }
            }
            if seen {
                break;
            }
            journal.wait_for_change(cursor, std::time::Duration::from_millis(50));
        }
        assert!(seen, "real PTY output did not arrive");
        let before_resize = journal.snapshot().high_water;
        session.resize(100, 35).unwrap();
        let after_resize = journal.snapshot().high_water;
        assert!(after_resize > before_resize);
        let mut cursor = before_resize;
        let mut resize = None;
        while cursor < after_resize {
            let record = journal.read_after(cursor).unwrap().unwrap();
            cursor = record.sequence;
            if let StreamPayload::Resize { cols, rows } = record.payload {
                resize = Some((cols, rows));
            }
        }
        assert_eq!(resize, Some((100, 35)));
        assert_eq!(journal.snapshot().metadata.initial_cols, 80);
    };
    // Always tear down this test-owned pane, including after an assertion.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(result));
    session.kill().unwrap();
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

// POSIX fixture, not POSIX behaviour. What this pins — exit-code propagation,
// journal ordering, fault handling — is platform-independent, but the programs
// it drives (`/bin/false`, `/bin/cat`, a `#!/bin/sh` script) have no honest
// one-binary Windows equivalent: CreateProcessW cannot exec a `.cmd`, and
// translating sh into cmd would test the translation. Windows gets its own
// ConPTY-native fixture below rather than a transliteration of this one.
#[cfg(unix)]
#[test]
fn direct_control_fault_keeps_the_process_alive_but_refuses_further_input() {
    if isolated("direct_control_fault_keeps_the_process_alive_but_refuses_further_input") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fault-child.sh");
    std::fs::write(
        &script,
        r"#!/bin/sh
printf '\033['
head -c 73728 /dev/zero | tr '\000' 1
printf '\aAFTER_FAULT'
exec sleep 30
",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let session = doom_term_pty::PtySession::create(
        "fault-child".into(),
        80,
        24,
        Some(dir.path().display().to_string()),
        Some(script.display().to_string()),
    )
    .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        let journal = session.stream();
        let mut cursor = Sequence::default();
        let mut fault = false;
        while std::time::Instant::now() < deadline {
            while let Ok(Some(record)) = journal.read_after(cursor) {
                cursor = record.sequence;
                if matches!(record.payload, StreamPayload::Fault { .. }) {
                    fault = true;
                }
            }
            if fault {
                break;
            }
            journal.wait_for_change(cursor, std::time::Duration::from_millis(50));
        }
        assert!(fault, "real child must emit an explicit stream fault");
        assert!(session.is_alive(), "fault must not kill the child");
        assert!(session.stream().snapshot().ended);
        assert!(session.write(b"NOT_SENT").is_err());
        assert!(session.paste("NOT_SENT").is_err());
        assert!(session.resize(100, 35).is_err());
        assert!(journal.snapshot().ended);
    }));
    session.kill().unwrap();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

/// The same guarantee as the three tests above, with a fixture built for ConPTY
/// instead of translated from sh.
///
/// This is the only place Windows exercises a real PTY end to end. ConPTY
/// creation, the reader thread, the demuxer's UTF-8 reassembly and the
/// journal's ordering all have to work for `journal-probe` to come back, so a
/// regression in any of them fails here rather than on a user's desktop.
#[cfg(windows)]
#[test]
fn real_conpty_output_and_successful_resize_are_in_the_same_stream() {
    if isolated("real_conpty_output_and_successful_resize_are_in_the_same_stream") {
        return;
    }
    let session = doom_term_pty::PtySession::create(
        format!("conpty-{}", std::process::id()),
        80,
        24,
        None,
        // cmd.exe is on every Windows installation and, unlike a .cmd script,
        // is directly executable by CreateProcessW.
        Some("cmd.exe".into()),
    )
    .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        session.write(b"echo journal-probe\r\n").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let journal = session.stream();
        let mut cursor = Sequence::default();
        let mut seen = false;
        while std::time::Instant::now() < deadline {
            while let Some(record) = journal.read_after(cursor).unwrap() {
                cursor = record.sequence;
                if matches!(record.payload, StreamPayload::Event(DemuxEvent::Output { ref data }) if data.contains("journal-probe"))
                {
                    seen = true;
                }
            }
            if seen {
                break;
            }
            journal.wait_for_change(cursor, std::time::Duration::from_millis(50));
        }
        assert!(seen, "real ConPTY output did not arrive");

        let before_resize = journal.snapshot().high_water;
        session.resize(100, 35).unwrap();
        let after_resize = journal.snapshot().high_water;
        assert!(after_resize > before_resize);
        let mut cursor = before_resize;
        let mut resize = None;
        while cursor < after_resize {
            let record = journal.read_after(cursor).unwrap().unwrap();
            cursor = record.sequence;
            if let StreamPayload::Resize { cols, rows } = record.payload {
                resize = Some((cols, rows));
            }
        }
        assert_eq!(resize, Some((100, 35)));
        assert_eq!(journal.snapshot().metadata.initial_cols, 80);
    }));
    session.kill().unwrap();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

/// Fast line output must not lose lines between the child and the journal.
///
/// The browser recovery fixture writes 510 numbered lines at 5 ms intervals and
/// two or three of them, always around CELL_458, never reach the rendered rows -
/// in the uninterrupted control run, with no disconnect involved. This pins
/// which side of the socket loses them.
#[cfg(unix)]
#[test]
fn rapid_numbered_lines_all_reach_the_journal() {
    if std::env::var_os("DOOM_RAPID_LINES_CHILD").is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "rapid_numbered_lines_all_reach_the_journal",
                "--nocapture",
            ])
            .env("DOOM_RAPID_LINES_CHILD", "1")
            .env("DOOM_TERM_NO_TMUX", "1")
            .env("DOOM_TERM_NO_SHELL_INTEGRATION", "1")
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
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("cells.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\ni=0\nwhile [ $i -lt 510 ]; do printf 'CELL_%03d\\n' $i; i=$((i+1)); done\nprintf 'CELLS_DONE\\n'\nsleep 5\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let session = doom_term_pty::session::PtySession::create(
        "rapid".into(),
        80,
        24,
        None,
        Some(script.to_string_lossy().into_owned()),
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut text = String::new();
    let mut cursor = doom_term_pty::stream::Sequence::default();
    while std::time::Instant::now() < deadline && !text.contains("CELLS_DONE") {
        while let Ok(Some(record)) = session.stream().read_after(cursor) {
            cursor = record.sequence;
            if let doom_term_pty::stream::StreamPayload::Event(
                doom_term_pty::demuxer::DemuxEvent::Output { data },
            ) = &record.payload
            {
                text.push_str(data);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let missing: Vec<String> = (0..510)
        .map(|i| format!("CELL_{i:03}"))
        .filter(|cell| !text.contains(cell.as_str()))
        .collect();
    let _ = session.kill();
    assert!(
        missing.is_empty(),
        "the journal lost {} of 510 lines: {:?}",
        missing.len(),
        missing
    );
}

/// The same burst, paced like the browser fixture.
///
/// Writing as fast as possible coalesces into a handful of large reads. The
/// recovery fixture pauses 5 ms between lines, so the demuxer sees ~510 separate
/// small reads instead - a different regime, and the one that loses lines.
#[cfg(unix)]
#[test]
fn paced_numbered_lines_all_reach_the_journal() {
    if std::env::var_os("DOOM_PACED_LINES_CHILD").is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "paced_numbered_lines_all_reach_the_journal",
                "--nocapture",
            ])
            .env("DOOM_PACED_LINES_CHILD", "1")
            .env("DOOM_TERM_NO_TMUX", "1")
            .env("DOOM_TERM_NO_SHELL_INTEGRATION", "1")
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
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("paced.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\ni=0\nwhile [ $i -lt 510 ]; do printf 'CELL_%03d\\n' $i; i=$((i+1)); sleep 0.005; done\nprintf 'CELLS_DONE\\n'\nsleep 5\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let session = doom_term_pty::session::PtySession::create(
        "paced".into(),
        80,
        24,
        None,
        Some(script.to_string_lossy().into_owned()),
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let mut text = String::new();
    let mut records = 0usize;
    let mut cursor = doom_term_pty::stream::Sequence::default();
    while std::time::Instant::now() < deadline && !text.contains("CELLS_DONE") {
        while let Ok(Some(record)) = session.stream().read_after(cursor) {
            cursor = record.sequence;
            records += 1;
            if let doom_term_pty::stream::StreamPayload::Event(
                doom_term_pty::demuxer::DemuxEvent::Output { data },
            ) = &record.payload
            {
                text.push_str(data);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let missing: Vec<String> = (0..510)
        .map(|i| format!("CELL_{i:03}"))
        .filter(|cell| !text.contains(cell.as_str()))
        .collect();
    let _ = session.kill();
    assert!(
        missing.is_empty(),
        "the journal lost {} of 510 paced lines across {records} records: {:?}",
        missing.len(),
        missing
    );
}
