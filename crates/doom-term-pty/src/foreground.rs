//! Who is actually running in the terminal.
//!
//! The only honest answer comes from the operating system, never from a tab
//! title — and which answer the OS can give differs by platform. This module is
//! the shared vocabulary; the witness itself lives in one of two submodules.
//!
//! ── THE TWO WITNESSES ──────────────────────────────────────────────────────
//!
//! `procfs` reads /proc/<pid>/stat field 8 (`tpgid`), the kernel's own record
//! of which process group owns the controlling terminal. It is exact, and it is
//! the primary source wherever /proc exists. It compiles on macOS too, where
//! every read fails and every answer is `None` — which is why `session.rs`
//! falls back to tmux's `pane_current_command` there.
//!
//! `windows` walks the process tree and takes the shell's most recently spawned
//! descendant. Windows has no foreground process group to ask about, so this is
//! a different question with a usually-identical answer. It is weaker and the
//! module says exactly how.
//!
//! What both must preserve: an unknown answer is `None`, all the way up. Every
//! caller — `metadata.rs`, `hint.rs`, the plate's `pct()` — is built to render
//! that as `--`. A witness that coerces "I cannot tell" into a name or a zero
//! breaks Axiom 3 at the source, before any of those guards can catch it.

#[cfg(not(windows))]
mod procfs;
#[cfg(not(windows))]
pub use procfs::{foreground_command, foreground_cwd, foreground_identity, identify, open_files};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{foreground_command, foreground_cwd, foreground_identity, identify, open_files};

/// What the plate needs to render an agent. There is deliberately no `model`
/// field: no agent CLI reports its model to the terminal, so any model string
/// here would be invented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentIdentity {
    pub key: &'static str,
    pub name: &'static str,
}

/// A pid plus a per-spawn nonce. A pid alone is not an identity: they are
/// reused, and a reused one would attribute a dead agent's transcript to
/// whatever took its number.
///
/// `start_ticks` is whatever the platform offers that is fixed for the life of
/// a process and different for the next one to hold that pid: kernel start
/// ticks from /proc/<pid>/stat on Linux, the creation `FILETIME` from
/// `GetProcessTimes` on Windows. It is only ever compared for equality, never
/// displayed or interpreted, so the two need not share a unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_ticks: u64,
}

/// Map a real process name to a plate identity. Unknown binaries are not
/// agents — a plain command must never light up the agent well.
///
/// Matching is exact, on the bare name the platform reports. Windows folds
/// "Claude.exe" to "claude" before calling here rather than loosening these
/// arms, so that a new platform cannot quietly widen what counts as an agent.
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
///
/// Both marker paths are absent on Windows, so a Windows container reports
/// `host`. That is the same position Linux takes when the files are missing:
/// no evidence of containment is not evidence of containment.
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
    fn a_shell_in_the_foreground_of_its_own_terminal_is_not_an_agent() {
        assert!(classify_agent("bash").is_none());
        assert!(classify_agent("zsh").is_none());
        assert!(classify_agent("ls").is_none());
    }

    #[test]
    fn a_windows_image_name_is_not_an_agent_until_it_has_been_folded() {
        // The fold belongs to the Windows witness, not to this match. If these
        // ever start resolving, a platform has widened what counts as an agent
        // by loosening the shared table instead of normalising its own input.
        assert!(classify_agent("claude.exe").is_none());
        assert!(classify_agent("Claude").is_none());
        assert!(classify_agent("CODEX.EXE").is_none());
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
