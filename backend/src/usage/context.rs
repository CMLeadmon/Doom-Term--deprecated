//! CONTEXT % — how full the running agent's context window is.
//!
//! Read from the agent's own transcript, which is the only place the number
//! exists: no agent CLI reports its token usage to the terminal, and /proc
//! cannot find the file either, because `claude` appends and closes the
//! transcript rather than holding the fd open.
//!
//! This is NOT the same number as USAGE %, and the two must never be blended.
//! USAGE % is the account's rate limit, fetched over HTTPS by `service.rs`;
//! CONTEXT % is one session's window fill, read from a local file. They come
//! from unrelated sources and can move in opposite directions.

/// Context window by model family, in tokens.
///
/// Taken 2026-08-30 from the authoritative model reference. Matched by prefix
/// because the transcript records the id verbatim and it sometimes carries a
/// date suffix (`claude-sonnet-4-6-20260115`).
///
/// Longest prefix first: `claude-haiku-4-5` must be tested before any shorter
/// string that could also match it.
const WINDOWS: &[(&str, u64)] = &[
    ("claude-haiku-4-5", 200_000),
    ("claude-opus-5", 1_000_000),
    ("claude-opus-4-8", 1_000_000),
    ("claude-opus-4-7", 1_000_000),
    ("claude-opus-4-6", 1_000_000),
    ("claude-sonnet-5", 1_000_000),
    ("claude-sonnet-4-6", 1_000_000),
    ("claude-fable-5", 1_000_000),
    ("claude-mythos-5", 1_000_000),
];

/// The context window for a model id, or None when we do not know it.
///
/// None is a real answer and the plate renders it as `--`. Defaulting to some
/// plausible window would turn an unknown into a confident wrong percentage,
/// which is the failure this whole slot exists to avoid — a model with a
/// larger window than we assumed would read as dangerously full.
pub fn context_window(model: &str) -> Option<u64> {
    WINDOWS
        .iter()
        .find(|(family, _)| model.starts_with(family))
        .map(|(_, window)| *window)
}

/// The newest token accounting found in a transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub used: u64,
    pub model: String,
}

/// Parse one transcript line, returning its token total when it is an
/// assistant turn that carries usage.
///
/// `used` is the INPUT side only — `input_tokens` plus both cache counters.
/// Those three are what was sent to the model, and therefore what occupies the
/// window. `output_tokens` is excluded on purpose: the reply is not in the
/// window until it is sent back as part of the next request's input, where it
/// arrives already counted. Adding it here would count it twice.
pub fn snapshot_from_line(line: &str) -> Option<Snapshot> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    let model = message.get("model")?.as_str()?.to_string();

    let cache = |name: &str| match usage.get(name) {
        None => Some(0),
        Some(value) => value.as_u64(),
    };
    let used = usage
        .get("input_tokens")?
        .as_u64()?
        .checked_add(cache("cache_read_input_tokens")?)?
        .checked_add(cache("cache_creation_input_tokens")?)?;

    Some(Snapshot { used, model })
}

/// How much of the transcript to read per step, scanning backwards.
/// The newest usage was in the final 64 KB of a 6.1 MB file when measured.
pub const SCAN_CHUNK: u64 = 65_536;

/// Give up after this much. A transcript whose last several megabytes contain
/// no assistant usage is not one we can describe, and reading a 100 MB file on
/// a 2 Hz poll to discover that would be worse than reporting nothing.
pub const MAX_SCAN: u64 = 4 * 1024 * 1024;

/// The newest token accounting in a transcript, scanning from the end.
pub fn newest_snapshot(path: &std::path::Path) -> Option<Snapshot> {
    scan_back(path, snapshot_from_line)
}

/// Open before checking the descriptor type, without blocking on a FIFO. A
/// separate path.is_file() check would leave a check/open replacement race.
pub fn open_transcript(path: &std::path::Path) -> Option<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    file.metadata().ok()?.is_file().then_some(file)
}

/// The last line of a JSONL file that `parse` accepts, scanning from the end.
///
/// Backwards because the file is append-only and can reach megabytes: the
/// answer is almost always in the last chunk, and a forward read would cost
/// the whole file on every poll. Partial lines at a chunk's leading edge are
/// carried into the next step rather than parsed, so a record split across the
/// boundary is not silently dropped.
///
/// Generic over the parser because Codex's rollout files have exactly the same
/// shape of problem and none of the same fields — one scanner, two schemas, so
/// the boundary-carry logic that is easy to get subtly wrong exists once.
pub fn scan_back<T>(path: &std::path::Path, parse: impl Fn(&str) -> Option<T>) -> Option<T> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = open_transcript(path)?;
    let size = file.metadata().ok()?.len();

    let mut pos = size;
    let mut scanned = 0u64;
    // Bytes from the previous (later) step that began before `pos`.
    let mut carry: Vec<u8> = Vec::new();

    while pos > 0 && scanned < MAX_SCAN {
        let step = SCAN_CHUNK.min(pos);
        pos -= step;
        scanned += step;

        let mut block = vec![0u8; step as usize];
        file.seek(SeekFrom::Start(pos)).ok()?;
        file.read_exact(&mut block).ok()?;
        block.extend_from_slice(&carry);

        let mut lines: Vec<&[u8]> = block.split(|b| *b == b'\n').collect();
        // The first element starts before `pos` unless we reached the top of
        // the file, so it is incomplete and belongs to the next step.
        carry = if pos > 0 {
            let head = lines.remove(0);
            head.to_vec()
        } else {
            Vec::new()
        };

        for raw in lines.iter().rev() {
            let Ok(text) = std::str::from_utf8(raw) else {
                continue;
            };
            if let Some(parsed) = parse(text) {
                return Some(parsed);
            }
        }
    }
    None
}

/// How recently a transcript must have been written to describe a live pane.
///
/// A finished session's file remains on disk indefinitely; reporting its final
/// context would put a number on a pane with no agent in it. Generous enough
/// to cover a user reading output for a while without typing.
#[cfg(test)]
pub const RECENT_WINDOW: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// How many lines to read looking for a transcript's `cwd`.
/// It appears within the first few records; reading further is wasted IO on a
/// file we are about to reject anyway.
#[cfg(test)]
const CWD_PROBE_LINES: usize = 40;

/// The directory a transcript says it was recorded in.
#[cfg(test)]
fn recorded_cwd(path: &std::path::Path) -> Option<String> {
    use std::io::BufRead;
    let file = open_transcript(path)?;
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().take(CWD_PROBE_LINES) {
        // A single unreadable line must not abandon the file: transcripts are
        // appended to live, so a partial write at the moment we read is normal.
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(|c| c.as_str()) {
            return Some(cwd.to_string());
        }
    }
    None
}

/// Every recently-written transcript recorded in `cwd`, newest first.
///
/// Matched on the cwd INSIDE the file rather than on the project directory's
/// name, because that name is lossy — slashes and spaces both become '-', so
/// it cannot be reconstructed from a path and two different paths can produce
/// the same folder. Reading it back is exact and cost 0.8 ms over nine project
/// directories when measured.
#[cfg(test)]
pub fn transcripts_for(
    root: &std::path::Path,
    cwd: &str,
    now: std::time::SystemTime,
) -> Vec<std::path::PathBuf> {
    let mut found: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();

    let Ok(projects) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for entry in files.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
                continue;
            };
            match now.duration_since(modified) {
                Ok(age) if age > RECENT_WINDOW => continue,
                _ => {}
            }
            if recorded_cwd(&path).as_deref() == Some(cwd) {
                found.push((modified, path));
            }
        }
    }

    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, path)| path).collect()
}

/// Where Claude Code keeps its transcripts.
#[cfg(test)]
fn transcript_root() -> Option<std::path::PathBuf> {
    Some(doom_term_pty::home_dir()?.join(".claude").join("projects"))
}

/// What the plate can say about a session's context.
///
/// The model rides along because the transcript is the first place Doom Term
/// has ever been able to learn it. `/proc` yields only a binary name, which is
/// why the plate has had no model field and why inventing one was ruled out —
/// this one is read, not guessed.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub fraction: f64,
    pub model: String,
}

/// Fraction 0..1 of the context window filled for the agent running in `cwd`.
///
/// None whenever the answer is not knowable, and that includes the ambiguous
/// case: two agents in one directory cannot be told apart from the outside, so
/// we report nothing rather than attribute one pane's context to another. The
/// plate draws '--' and is honest; a number here would look authoritative and
/// be wrong half the time.
pub fn context_fraction(
    cwd: &str,
    session_id: Option<&str>,
    process: Option<doom_term_pty::foreground::ProcessIdentity>,
) -> Option<Reading> {
    // Even a unique directory match cannot prove pane ownership. Scanning is
    // diagnostic-only; live readings require the hook's exact pane identity.
    let path = super::hint::transcript_for("claude", cwd, session_id, process)?;
    let snapshot = newest_snapshot(&path)?;
    let window = context_window(&snapshot.model)?;
    Some(Reading {
        fraction: snapshot.used as f64 / window as f64,
        model: snapshot.model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_current_families_all_carry_a_million_token_window() {
        assert_eq!(context_window("claude-opus-5"), Some(1_000_000));
        assert_eq!(context_window("claude-opus-4-8"), Some(1_000_000));
        assert_eq!(context_window("claude-sonnet-5"), Some(1_000_000));
        assert_eq!(context_window("claude-fable-5"), Some(1_000_000));
    }

    #[test]
    fn haiku_is_the_one_that_is_not() {
        // The whole reason this is a table and not a constant.
        assert_eq!(context_window("claude-haiku-4-5"), Some(200_000));
        assert_eq!(context_window("claude-haiku-4-5-20251001"), Some(200_000));
    }

    #[test]
    fn a_model_we_do_not_know_has_no_window_rather_than_a_guessed_one() {
        // A wrong denominator produces a confident, wrong percentage — worse
        // than the '--' the plate draws for None. Never default the divisor.
        assert_eq!(context_window("claude-opus-9"), None);
        assert_eq!(context_window("gpt-5"), None);
        assert_eq!(context_window(""), None);
    }

    #[test]
    fn a_dated_snapshot_matches_its_family() {
        // Ids arrive from the transcript verbatim and sometimes carry a date.
        assert_eq!(
            context_window("claude-sonnet-4-6-20260115"),
            Some(1_000_000)
        );
    }

    #[test]
    fn reads_the_input_side_token_total_from_an_assistant_line() {
        // Shape confirmed against a real transcript on 2026-08-30.
        let line = r#"{"type":"assistant","message":{"model":"claude-opus-5",
            "usage":{"input_tokens":2,"cache_creation_input_tokens":1905,
            "cache_read_input_tokens":335468,"output_tokens":2217}}}"#;
        let snap = snapshot_from_line(line).expect("an assistant usage line");
        // 2 + 1905 + 335468. The output tokens are deliberately NOT counted:
        // this measures what was SENT, which is what fills the window on the
        // next request. Including the reply would double-count it a turn later.
        assert_eq!(snap.used, 337_375);
        assert_eq!(snap.model, "claude-opus-5");
    }

    #[test]
    fn tolerates_a_usage_block_missing_the_cache_fields() {
        // An uncached first turn has no cache_read/cache_creation at all.
        let line = r#"{"type":"assistant","message":{"model":"claude-opus-5",
            "usage":{"input_tokens":1200,"output_tokens":30}}}"#;
        assert_eq!(snapshot_from_line(line).unwrap().used, 1200);
    }

    #[test]
    fn missing_or_invalid_token_accounting_is_unknown_not_zero() {
        for usage in [
            r#"{}"#,
            r#"{"input_tokens":null}"#,
            r#"{"input_tokens":5,"cache_read_input_tokens":"wrong"}"#,
        ] {
            let line = format!(
                r#"{{"type":"assistant","message":{{"model":"claude-haiku-4-5","usage":{usage}}}}}"#
            );
            assert!(
                snapshot_from_line(&line).is_none(),
                "invalid accounting accepted: {usage}"
            );
        }
    }

    #[test]
    fn overflowing_token_accounting_is_rejected_without_panicking() {
        let line = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":18446744073709551615,"cache_read_input_tokens":1}}}"#;
        assert!(snapshot_from_line(line).is_none());
    }

    #[test]
    fn ignores_lines_that_are_not_an_assistant_turn_with_usage() {
        // A transcript is mostly user turns, tool results and metadata. Only
        // an assistant message carries the token accounting.
        assert!(snapshot_from_line(r#"{"type":"user","message":{"content":"hi"}}"#).is_none());
        assert!(snapshot_from_line(r#"{"type":"assistant","message":{"model":"m"}}"#).is_none());
        assert!(snapshot_from_line("not json at all").is_none());
        assert!(snapshot_from_line("").is_none());
    }

    #[test]
    fn a_usage_block_without_a_model_is_unusable() {
        // Without the model there is no denominator, so there is no percentage.
        let line = r#"{"type":"assistant","message":{"usage":{"input_tokens":10}}}"#;
        assert!(snapshot_from_line(line).is_none());
    }

    /// Write a transcript to a unique temp path and hand back the path.
    fn write_transcript(name: &str, body: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("doom-term-ctx-{}.jsonl", name));
        std::fs::write(&path, body).expect("temp transcript");
        path
    }

    /// One assistant turn carrying usage. Used by this task and by Task 4.
    fn assistant_line(model: &str, input: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"model":"{}","usage":{{"input_tokens":{}}}}}}}"#,
            model, input
        )
    }

    #[test]
    fn finds_the_last_usage_not_the_first() {
        // The newest turn is the current state of the window; an earlier one
        // describes a context that has since grown.
        let path = write_transcript(
            "ordering",
            &format!(
                "{}\n{}\n{}\n",
                assistant_line("claude-opus-5", 100),
                r#"{"type":"user","message":{"content":"next"}}"#,
                assistant_line("claude-opus-5", 900),
            ),
        );
        assert_eq!(newest_snapshot(&path).unwrap().used, 900);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn finds_a_usage_line_that_straddles_a_chunk_boundary() {
        // The scan reads fixed-size blocks backwards from the end, so a record
        // split across a boundary arrives as two halves and must be rejoined.
        // Placed deliberately: the trailing padding is sized so the final
        // chunk BEGINS in the middle of the usage line. A test that merely
        // exceeds one chunk does not exercise this — the answer would sit in
        // the last block and the carry path would never run.
        let usage = format!("{}\n", assistant_line("claude-opus-5", 4242));
        let filler = format!("{}\n", r#"{"type":"user","message":{"content":"x"}}"#);

        let suffix_bytes = SCAN_CHUNK as usize - usage.len() / 2;
        let mut suffix = filler.repeat(suffix_bytes / filler.len() + 1);
        suffix.truncate(suffix_bytes); // exact, so the boundary lands where we want
        let prefix = filler.repeat(10);
        let body = format!("{}{}{}", prefix, usage, suffix);

        let path = write_transcript("straddle", &body);
        let size = std::fs::metadata(&path).unwrap().len();
        let last_chunk_starts = size - SCAN_CHUNK;
        let usage_starts = prefix.len() as u64;
        assert!(
            last_chunk_starts > usage_starts
                && last_chunk_starts < usage_starts + usage.len() as u64,
            "the boundary must fall inside the usage line for this test to mean anything"
        );

        assert_eq!(newest_snapshot(&path).unwrap().used, 4242);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_transcript_with_no_usage_yields_nothing() {
        let path = write_transcript(
            "empty",
            concat!(r#"{"type":"user","message":{"content":"hi"}}"#, "\n"),
        );
        assert!(newest_snapshot(&path).is_none());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_missing_file_yields_nothing_rather_than_panicking() {
        // The agent can exit and its transcript be moved between the poll that
        // found it and the poll that reads it.
        assert!(newest_snapshot(std::path::Path::new("/nonexistent/x.jsonl")).is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fifo_cannot_block_the_transcript_reader() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        assert!(std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let (tx, rx) = std::sync::mpsc::channel();
        let fifo = path.clone();
        let reader = std::thread::spawn(move || tx.send(newest_snapshot(&fifo)).unwrap());
        let answer = rx.recv_timeout(std::time::Duration::from_millis(300));
        // Unblock the old implementation before reporting red, without leaving
        // a stuck thread behind. Linux permits opening both ends of our FIFO.
        if answer.is_err() {
            drop(
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)
                    .unwrap(),
            );
        }
        reader.join().unwrap();
        assert_eq!(
            answer,
            Ok(None),
            "non-regular transcript paths must fail promptly"
        );
    }

    /// Build a fake ~/.claude/projects tree: (dir, file, body) triples.
    fn fake_projects(name: &str, entries: &[(&str, &str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("doom-term-projects-{}", name));
        std::fs::remove_dir_all(&root).ok();
        for (dir, file, body) in entries {
            let d = root.join(dir);
            std::fs::create_dir_all(&d).expect("project dir");
            std::fs::write(d.join(file), body).expect("transcript");
        }
        root
    }

    #[test]
    fn matches_the_directory_the_transcript_recorded_not_a_reconstructed_name() {
        // The project directory name is lossy: slashes AND spaces both become
        // '-', so `/a/Doom Term` and `/a/Doom/Term` produce the same folder.
        // Reading the cwd back out of the file is exact instead of guessing.
        let root = fake_projects(
            "match",
            &[(
                "-var-home-me-Projects-Doom-Term",
                "s1.jsonl",
                &format!(
                    "{}\n{}\n",
                    r#"{"type":"user","cwd":"/var/home/me/Projects/Doom Term"}"#,
                    assistant_line("claude-opus-5", 500_000)
                ),
            )],
        );
        let now = std::time::SystemTime::now();
        let found = transcripts_for(&root, "/var/home/me/Projects/Doom Term", now);
        assert_eq!(found.len(), 1, "the recorded cwd must match exactly");
        assert!(transcripts_for(&root, "/var/home/me/Projects/Doom", now).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ignores_transcripts_for_other_directories() {
        let root = fake_projects(
            "others",
            &[
                ("-a", "s1.jsonl", r#"{"type":"user","cwd":"/a"}"#),
                ("-b", "s2.jsonl", r#"{"type":"user","cwd":"/b"}"#),
            ],
        );
        let now = std::time::SystemTime::now();
        assert_eq!(transcripts_for(&root, "/a", now).len(), 1);
        assert!(transcripts_for(&root, "/zzz", now).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_stale_transcript_does_not_describe_a_live_pane() {
        // A finished session's file sits there forever. Reporting its final
        // context as the current one would show a number for a pane that has
        // no agent in it at all.
        let root = fake_projects(
            "stale",
            &[("-a", "old.jsonl", r#"{"type":"user","cwd":"/a"}"#)],
        );
        let ancient =
            std::time::SystemTime::now() + RECENT_WINDOW + std::time::Duration::from_secs(60);
        assert!(
            transcripts_for(&root, "/a", ancient).is_empty(),
            "anything older than RECENT_WINDOW is not current"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn two_agents_in_one_directory_are_reported_as_ambiguous() {
        // The single case discovery cannot resolve. Returning both lets the
        // caller render '--' rather than pick one and attribute another pane's
        // context to this one.
        let root = fake_projects(
            "ambiguous",
            &[
                ("-a", "s1.jsonl", r#"{"type":"user","cwd":"/a"}"#),
                ("-a", "s2.jsonl", r#"{"type":"user","cwd":"/a"}"#),
            ],
        );
        let now = std::time::SystemTime::now();
        assert_eq!(transcripts_for(&root, "/a", now).len(), 2);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    #[ignore = "reads the real ~/.claude/projects; run by hand"]
    fn probes_the_live_transcripts() {
        let root = transcript_root().expect("HOME");
        // cargo runs tests from the manifest directory, which is `backend/` and
        // has no agent in it. Point this at the directory that does.
        let cwd = std::env::var("DOOM_TERM_PROBE_CWD").unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string()
        });
        let found = transcripts_for(&root, &cwd, std::time::SystemTime::now());
        println!("transcripts for {cwd}: {}", found.len());
        for path in &found {
            if let Some(s) = newest_snapshot(path) {
                let window = context_window(&s.model);
                println!(
                    "  {:?} used={} model={} window={:?}",
                    path.file_name().unwrap(),
                    s.used,
                    s.model,
                    window
                );
            }
        }
    }
}
