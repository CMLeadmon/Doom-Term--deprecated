//! Who is actually running in the terminal.
//!
//! The only honest answer comes from the kernel: /proc/<pid>/stat field 8
//! (`tpgid`) is the foreground process group of the controlling terminal, and
//! /proc/<tpgid>/comm is the command in it. Never guess from a tab title.

/// What the plate needs to render an agent. There is deliberately no `model`
/// field: no agent CLI reports its model to the terminal, so any model string
/// here would be invented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentIdentity {
    pub key: &'static str,
    pub name: &'static str,
}

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

/// PID plus kernel start ticks distinguish an agent restart and PID reuse.
/// Unknown off Linux: a name or a pane id alone is not a process identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_ticks: u64,
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
/// Returns None off Linux, or when the shell itself is in the foreground.
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

/// Map a real process name to a plate identity. Unknown binaries are not
/// agents — a plain command must never light up the agent well.
pub fn classify_agent(comm: &str) -> Option<AgentIdentity> {
    // The key selects which mark and which colour the plate draws, so it has to
    // name the vendor whose agent this actually is. Borrowing another vendor's
    // key puts their logo in the well: `agy` used to resolve to "gemini" and so
    // drew Gemini's star, and `aider` resolved to "claude" and drew Anthropic's
    // burst. Antigravity and Gemini CLI are different products, and aider is
    // nobody's but its own.
    let (key, name) = match comm {
        "claude" => ("claude", "CLAUDE CODE"),
        "codex" => ("codex", "CODEX"),
        "gemini" => ("gemini", "GEMINI CLI"),
        "agy" | "antigravity" => ("antigravity", "ANTIGRAVITY"),
        "aider" => ("aider", "AIDER"),
        "opencode" => ("opencode", "OPENCODE"),
        "grok" => ("grok", "GROK CLI"),
        "copilot" => ("copilot", "GITHUB COPILOT"),
        _ => return None,
    };
    Some(AgentIdentity { key, name })
}

/// Isolation is reported, never assumed. The daemon spawns onto the host, so
/// the only true "sandbox" is the whole process being containerised.
pub fn detect_isolation() -> &'static str {
    let contained = std::path::Path::new("/run/.containerenv").exists()
        || std::path::Path::new("/.dockerenv").exists();
    if contained {
        "sandbox"
    } else {
        "host"
    }
}

/// Whether `dir` sits anywhere inside a Git worktree checkout.
///
/// A worktree's `.git` is a file, not a directory — but only at the checkout
/// root. Testing `<cwd>/.git` alone reports `worktree` from the root and
/// `host` from one directory deeper, so the plate named a different
/// environment for the same session depending on where the shell had cd'd.
/// Walking up to the repo root makes the answer depend on the repository, not
/// on the cursor's depth in it.
///
/// A submodule also has a `.git` file, so the file's own `gitdir:` decides:
/// worktrees live under `.git/worktrees/`, submodules under `.git/modules/`.
pub fn detect_worktree(dir: &std::path::Path) -> bool {
    for ancestor in dir.ancestors() {
        let dot_git = ancestor.join(".git");
        if dot_git.is_dir() {
            return false; // The ordinary case: a repo's own main checkout.
        }
        if dot_git.is_file() {
            return std::fs::read_to_string(&dot_git)
                .ok()
                .and_then(|body| {
                    body.lines()
                        .find_map(|line| line.trim().strip_prefix("gitdir:"))
                        .map(|target| {
                            std::path::Path::new(target.trim())
                                .components()
                                .any(|c| c.as_os_str() == "worktrees")
                        })
                })
                .unwrap_or(false);
        }
    }
    false
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

    #[test]
    fn a_shell_in_the_foreground_of_its_own_terminal_is_not_an_agent() {
        assert!(classify_agent("bash").is_none());
        assert!(classify_agent("zsh").is_none());
        assert!(classify_agent("ls").is_none());
    }

    #[test]
    fn known_agent_binaries_are_identified_without_inventing_a_model() {
        let claude = classify_agent("claude").expect("claude is an agent");
        assert_eq!(claude.key, "claude");
        assert_eq!(claude.name, "CLAUDE CODE");
        assert_eq!(classify_agent("codex").unwrap().name, "CODEX");
        assert_eq!(classify_agent("gemini").unwrap().name, "GEMINI CLI");
    }

    #[test]
    fn no_agent_borrows_another_vendors_key() {
        // The key picks the mark and the colour, so a shared key draws the wrong
        // vendor's logo in the well. Antigravity is not Gemini CLI, and aider is
        // not Claude Code, however similar their plumbing.
        let agy = classify_agent("agy").expect("agy is an agent");
        assert_eq!(agy.key, "antigravity");
        assert_eq!(agy.name, "ANTIGRAVITY");
        assert_eq!(classify_agent("antigravity").unwrap().key, "antigravity");
        assert_ne!(agy.key, classify_agent("gemini").unwrap().key);
        assert_ne!(
            classify_agent("aider").unwrap().key,
            classify_agent("claude").unwrap().key
        );

        // Every distinct binary that maps to an identity keeps a distinct key.
        // agy and antigravity are the one legitimate pair — two names, one product.
        let bins = [
            "claude",
            "codex",
            "gemini",
            "agy",
            "antigravity",
            "aider",
            "opencode",
            "grok",
            "copilot",
        ];
        let mut keys: Vec<&str> = bins
            .iter()
            .filter_map(|b| classify_agent(b))
            .map(|a| a.key)
            .collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(
            keys.len(),
            before - 1,
            "only agy/antigravity may share a key"
        );
    }

    #[test]
    fn a_negative_tpgid_means_no_controlling_terminal() {
        assert_eq!(parse_tpgid("1 (init) S 0 1 1 0 -1 4194560"), None);
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("doom-term-worktree-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_worktree_is_still_a_worktree_from_a_nested_directory() {
        let root = tmp("nested");
        std::fs::write(root.join(".git"), "gitdir: /repo/.git/worktrees/feature\n").unwrap();
        let deep = root.join("src/core");
        std::fs::create_dir_all(&deep).unwrap();

        assert!(detect_worktree(&root));
        assert!(
            detect_worktree(&deep),
            "cwd depth must not change the reported environment"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_submodule_is_not_a_worktree_even_though_its_dot_git_is_a_file() {
        let root = tmp("submodule");
        std::fs::write(root.join(".git"), "gitdir: ../.git/modules/vendor\n").unwrap();

        assert!(!detect_worktree(&root));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_ordinary_checkout_with_a_dot_git_directory_is_not_a_worktree() {
        let root = tmp("plain");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let deep = root.join("src");
        std::fs::create_dir_all(&deep).unwrap();

        assert!(!detect_worktree(&deep));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_directory_in_no_repository_at_all_is_not_a_worktree() {
        let root = tmp("norepo");
        assert!(!detect_worktree(&root));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
