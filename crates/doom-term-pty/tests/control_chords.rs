//! Control chords must remain terminal input. In raw mode the application,
//! not the terminal frontend, decides whether Ctrl+C or Ctrl+Z is a signal.
#![cfg(unix)]

use doom_term_pty::{
    stream::{Sequence, StreamPayload},
    DemuxEvent, PtySession,
};
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

#[test]
fn raw_mode_receives_control_bytes_without_an_out_of_band_signal() {
    if std::env::var_os("DOOM_CONTROL_TEST_CHILD").is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "raw_mode_receives_control_bytes_without_an_out_of_band_signal",
                "--nocapture",
            ])
            .env("DOOM_CONTROL_TEST_CHILD", "1")
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

    let fixture = tempfile::tempdir().unwrap();
    let script = fixture.path().join("raw-child.sh");
    std::fs::write(
        &script,
        concat!(
            "#!/bin/sh\n",
            "stty raw -echo\n",
            "trap 'printf SIGNALLED; exit 9' INT TSTP\n",
            "printf READY\n",
            "value=$(dd bs=1 count=1 2>/dev/null | od -An -tu1)\n",
            "printf '\\nBYTE=%s\\n' \"$value\"\n",
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();

    for (chord, byte) in [("ctrl+c", 3u8), ("ctrl+z", 26u8), ("ctrl+d", 4u8)] {
        let session = PtySession::create(
            format!("control-fixture-{byte}"),
            80,
            24,
            Some(fixture.path().display().to_string()),
            Some(script.display().to_string()),
        )
        .unwrap();
        let journal = session.stream();
        let mut cursor = Sequence::default();
        let mut output = String::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !output.contains("READY") && Instant::now() < deadline {
            while let Some(record) = journal.read_after(cursor).unwrap() {
                cursor = record.sequence;
                if let StreamPayload::Event(DemuxEvent::Output { data }) = record.payload {
                    output.push_str(&data);
                }
            }
            journal.wait_for_change(cursor, Duration::from_millis(50));
        }
        if !output.contains("READY") {
            let _ = session.kill();
        }
        assert!(
            output.contains("READY"),
            "raw fixture did not start: {output:?}"
        );
        session.send_signal(chord).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            while let Some(record) = journal.read_after(cursor).unwrap() {
                cursor = record.sequence;
                match record.payload {
                    StreamPayload::Event(DemuxEvent::Output { data }) => output.push_str(&data),
                    StreamPayload::Closed { .. } => break,
                    _ => {}
                }
            }
            if journal.snapshot().ended {
                break;
            }
            journal.wait_for_change(cursor, Duration::from_millis(50));
        }
        if session.is_alive() {
            let _ = session.kill();
        }
        let received = output
            .lines()
            .find_map(|line| line.strip_prefix("BYTE="))
            .and_then(|value| value.trim().parse::<u8>().ok());
        assert_eq!(
            received,
            Some(byte),
            "{chord} must be delivered as input, not a forced signal: {output:?}"
        );
        assert!(
            !output.contains("SIGNALLED"),
            "raw-mode app received an unsolicited signal"
        );
    }
}
