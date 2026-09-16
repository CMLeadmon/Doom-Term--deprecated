//! The `/proc` witness.
//!
//! /proc/<pid>/stat field 8 (`tpgid`) is the foreground process group of the
//! controlling terminal, and /proc/<tpgid>/comm is the command in it. This is
//! the kernel's own answer and it is the primary source wherever it exists.
//!
//! Compiled on every non-Windows target, not just Linux. On macOS these files
//! simply are not there, every read fails, and each function returns `None` —
//! which is the correct answer, and the reason the tmux fallback in
//! `session.rs` exists. Do not add a `cfg(target_os = "linux")` gate here: a
//! macOS build needs these symbols to exist and to answer honestly.

use super::ProcessIdentity;

/// Field 8 of /proc/<pid>/stat. `comm` (field 2) is parenthesised and may
/// contain ')' and spaces, so split after the LAST ')': the remaining fields
/// are state, ppid, pgrp, session, tty_nr, tpgid — tpgid is index 5.
fn parse_tpgid(stat: &str) -> Option<i32> {
    let after_comm = stat.rsplit_once(')')?.1;
    let tpgid: i32 = after_comm.split_whitespace().nth(5)?.parse().ok()?;
    if tpgid <= 0 {
        None
    } else {
        Some(tpgid)
    }
}

/// Start ticks for a pid: /proc/<pid>/stat field 22, which is field 3 after the
/// final parenthesized comm. None when the process is gone.
fn start_ticks(pid: u32) -> Option<u64> {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()?
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

/// One pid, as an identity. A pid on its own is not one: they are reused.
pub fn identify(pid: u32) -> Option<ProcessIdentity> {
    Some(ProcessIdentity {
        pid,
        start_ticks: start_ticks(pid)?,
    })
}

pub fn foreground_identity(shell_pid: u32) -> Option<ProcessIdentity> {
    let shell_stat = std::fs::read_to_string(format!("/proc/{shell_pid}/stat")).ok()?;
    identify(u32::try_from(parse_tpgid(&shell_stat)?).ok()?)
}

/// How many descriptors we will look at before giving up on a process.
///
/// This runs on the telemetry poll, several times a second. A process holding
/// more open files than this is not one we are going to describe usefully, and
/// walking an unbounded directory there would be the most expensive thing the
/// daemon does.
const MAX_DESCRIPTORS: usize = 512;

/// The regular files this exact process has open, per the kernel.
///
/// ── WHY A DESCRIPTOR AND NOT A DIRECTORY SCAN ──────────────────────────────
///
/// "Which transcript belongs to THIS pane" is an ownership question, and a
/// directory cannot answer it: two agents in one repository write two matching
/// files and nothing outside them can say which is which. A descriptor is the
/// kernel's own bookkeeping — the file is open in that process and no other —
/// so it settles the question the scan could only guess at.
///
/// `identity` is re-checked after the walk, so a pid recycled midway through
/// cannot hand back another process's files. Anything that is not a plain
/// existing file is skipped: sockets, pipes and anon inodes all appear here,
/// and a deleted file's link still resolves to a path that reads as real.
pub fn open_files(identity: ProcessIdentity) -> Vec<std::path::PathBuf> {
    // Cheapest check first: a pid that is already someone else is not worth
    // walking, and the walk is the expensive half.
    if start_ticks(identity.pid) != Some(identity.start_ticks) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(format!("/proc/{}/fd", identity.pid)) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten().take(MAX_DESCRIPTORS) {
        let Ok(path) = std::fs::read_link(entry.path()) else {
            continue;
        };
        if path.is_absolute() && path.is_file() {
            found.push(path);
        }
    }
    // The pid may have been reused between naming it and reading it.
    if start_ticks(identity.pid) != Some(identity.start_ticks) {
        return Vec::new();
    }
    found
}

/// The command currently in the foreground of `shell_pid`'s terminal.
/// Returns None where /proc does not exist, or when the read fails.
pub fn foreground_command(shell_pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{}/stat", shell_pid)).ok()?;
    let tpgid = parse_tpgid(&stat)?;
    let comm = std::fs::read_to_string(format!("/proc/{}/comm", tpgid)).ok()?;
    Some(comm.trim().to_string())
}

/// The working directory of whatever is in the foreground of `shell_pid`'s
/// terminal, falling back to the shell's own.
///
/// ── WHY NOT ASK THE SHELL ──────────────────────────────────────────────────
///
/// Doom Term learned the directory from OSC 7, which the integration script
/// emits from `PROMPT_COMMAND` — that is, once per prompt. `cd somewhere &&
/// claude` never draws another prompt, so the sequence never fires and the app
/// keeps reporting the directory the session started in, indefinitely.
///
/// That is not cosmetic. CONTEXT % is looked up BY directory, so a stale one
/// silently sends the lookup to a path with no transcripts and the plate reads
/// '--' for an agent that is right there. The kernel has the answer, it costs
/// one readlink, and it is true whatever the user's shell does or does not
/// emit.
///
/// The FOREGROUND process is asked first because it is the one the reading is
/// about: an agent may have changed directory since it started, and it is that
/// agent's context we are trying to describe.
pub fn foreground_cwd(shell_pid: u32) -> Option<String> {
    let read = |pid: i64| {
        std::fs::read_link(format!("/proc/{}/cwd", pid))
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    };

    std::fs::read_to_string(format!("/proc/{}/stat", shell_pid))
        .ok()
        .and_then(|stat| parse_tpgid(&stat))
        .and_then(|tpgid| read(tpgid as i64))
        .or_else(|| read(shell_pid as i64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tpgid_from_a_stat_line_whose_comm_contains_spaces_and_parens() {
        // /proc/<pid>/stat field 2 is parenthesised and may itself contain
        // ')' and spaces, so the parse must split after the LAST ')'.
        let stat = "4242 (my )weird( proc) S 4240 4242 4242 34816 9001 4194304 …";
        assert_eq!(parse_tpgid(stat), Some(9001));
    }

    #[test]
    fn a_negative_tpgid_means_no_controlling_terminal() {
        assert_eq!(parse_tpgid("1 (init) S 0 1 1 0 -1 4194560"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn open_files_reports_a_file_this_process_actually_holds_open() {
        // The whole point of reading descriptors rather than scanning a
        // directory: this answer is about ONE process, and the kernel is the
        // one giving it.
        let path = std::env::temp_dir().join("doom-term-open-files-probe.jsonl");
        let handle = std::fs::File::create(&path).expect("probe file");
        let me = identify(std::process::id()).expect("our own identity");

        let open = open_files(me);
        assert!(
            open.iter().any(|found| found == &path),
            "a file we are holding open must appear: {open:?}"
        );

        drop(handle);
        std::fs::remove_file(&path).ok();
        assert!(
            !open_files(me).iter().any(|found| found == &path),
            "a closed file must stop being reported"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn open_files_refuses_to_answer_for_a_process_that_is_not_the_one_named() {
        // Start ticks are what separate a live agent from a recycled pid. A
        // mismatched identity must yield nothing rather than another
        // process's files.
        let imposter = ProcessIdentity {
            pid: std::process::id(),
            start_ticks: u64::MAX,
        };
        assert!(open_files(imposter).is_empty());
    }
}
