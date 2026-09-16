//! The process-tree witness.
//!
//! Windows has no foreground process *group*, so there is no `tpgid` to read
//! and no single call that answers "who owns this terminal". It does have a
//! process *tree*, and the convention every Windows terminal emulator uses is
//! that the most recently spawned descendant of the shell is the foreground
//! process. WezTerm documents exactly this for
//! `pane:get_foreground_process_info()`, and it is what we do here.
//!
//! It is a weaker witness than `tpgid` and it is worth being precise about how:
//! the kernel is not being asked who has the terminal, it is being asked who
//! the shell started last. A backgrounded process that outlives a foreground
//! one will be named instead. In practice an agent CLI is the newest descendant
//! for its whole run, which is the case the agent well exists to describe.
//!
//! ── PID REUSE ──────────────────────────────────────────────────────────────
//!
//! Windows recycles PIDs far more eagerly than Linux, so the nonce in
//! `ProcessIdentity` matters more here, not less. The creation `FILETIME` from
//! `GetProcessTimes` is an exact analogue of `/proc/<pid>/stat` start ticks: a
//! 64-bit count that is fixed for the life of a process and different for the
//! next one to hold that pid.
//!
//! The same fact defends the tree walk itself. A snapshot's
//! `th32ParentProcessID` is just a number, and a dead parent's pid can be
//! reused by an unrelated process — which would graft a stranger's subtree onto
//! our shell. A real child cannot have been created before its parent, so a
//! candidate whose creation time precedes its parent's is rejected.

use super::ProcessIdentity;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Ceiling on the process table we will walk in one call.
///
/// This runs on the telemetry poll, several times a second, for every pane. A
/// machine with more live processes than this is one where the walk has become
/// the most expensive thing the daemon does, and an unbounded loop there is
/// worse than an unknown reading.
const MAX_PROCESSES: usize = 4096;

/// Ceiling on how deep a descendant chain we will follow.
///
/// A shell running an agent running a tool is three levels. Anything past this
/// is either a build system or a corrupted parent chain, and neither is the
/// thing the agent well is describing.
const MAX_DEPTH: usize = 16;

/// A handle that is closed however the function it lives in returns.
///
/// Every early exit in this module is a `?`, and a leaked process handle on a
/// path that runs several times a second is a handle leak that takes days to
/// show up and looks like someone else's bug when it does.
struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: self.0 came from OpenProcess or CreateToolhelp32Snapshot and
        // has not been closed; Drop runs exactly once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

impl OwnedHandle {
    fn open_process(pid: u32) -> Option<Self> {
        // SAFETY: a plain FFI call; the returned handle is checked for null
        // before being wrapped.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            // Access denied, or the process is gone. Either way we cannot
            // nonce it, so it is not an identity we are willing to report.
            return None;
        }
        Some(Self(raw))
    }

    fn snapshot() -> Option<Self> {
        // SAFETY: a plain FFI call; failure is INVALID_HANDLE_VALUE, not null.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw == INVALID_HANDLE_VALUE || raw.is_null() {
            return None;
        }
        Some(Self(raw))
    }
}

/// `FILETIME` as one integer: 100-nanosecond intervals since 1601-01-01 UTC.
fn filetime_to_u64(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

/// When this pid was created, as the nonce that makes a pid an identity.
fn created_at(pid: u32) -> Option<u64> {
    let handle = OwnedHandle::open_process(pid)?;
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    // SAFETY: handle is live for the duration of the call and all four
    // out-parameters point at initialised, owned FILETIMEs.
    let ok = unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    Some(filetime_to_u64(creation))
}

/// One row of the process table: who it is, who started it, what it is called.
struct Entry {
    pid: u32,
    parent: u32,
    image: String,
}

/// A wide, NUL-terminated fixed buffer as a `String`.
fn image_name(raw: &[u16]) -> String {
    let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..end])
}

/// Every live process, as one point-in-time table.
fn process_table() -> Option<Vec<Entry>> {
    let snapshot = OwnedHandle::snapshot()?;
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    // Documented requirement: Process32FirstW fails if dwSize is not set.
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    // SAFETY: snapshot is live, entry is a correctly sized owned struct.
    if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
        return None;
    }

    let mut table = Vec::new();
    loop {
        table.push(Entry {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            image: image_name(&entry.szExeFile),
        });
        if table.len() >= MAX_PROCESSES {
            break;
        }
        // SAFETY: as above; Process32NextW returns 0 at the end of the table.
        if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
            break;
        }
    }
    Some(table)
}

/// The newest descendant of `shell_pid`, with the name it was started from.
///
/// Returns the shell itself when it has no descendants we can verify, which is
/// what `tpgid` reports on Linux when nothing has been launched from the
/// prompt: the answer is the shell, and `classify_agent` will correctly decline
/// to call it an agent.
fn foreground_entry(shell_pid: u32) -> Option<(ProcessIdentity, String)> {
    let shell_created = created_at(shell_pid)?;
    let table = process_table()?;

    let mut best = (
        ProcessIdentity {
            pid: shell_pid,
            start_ticks: shell_created,
        },
        table
            .iter()
            .find(|e| e.pid == shell_pid)
            .map(|e| e.image.clone())
            .unwrap_or_default(),
    );
    let mut newest = shell_created;

    // Breadth-first down the tree, carrying each parent's creation time so a
    // recycled parent pid cannot graft a stranger's subtree onto ours.
    let mut frontier = vec![(shell_pid, shell_created)];
    let mut seen = vec![shell_pid];

    for _ in 0..MAX_DEPTH {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for (parent_pid, parent_created) in frontier.drain(..) {
            for entry in table.iter().filter(|e| e.parent == parent_pid) {
                // A process is not its own parent, and a cycle in a reused
                // parent chain would otherwise loop until MAX_DEPTH.
                if entry.pid == parent_pid || seen.contains(&entry.pid) {
                    continue;
                }
                let Some(created) = created_at(entry.pid) else {
                    // Unopenable: elevated, or exited between the snapshot and
                    // now. We cannot nonce it, so we will not name it.
                    continue;
                };
                if created < parent_created {
                    // Older than its own parent: the parent pid was reused and
                    // this subtree belongs to somebody else.
                    continue;
                }
                seen.push(entry.pid);
                next.push((entry.pid, created));
                if created >= newest {
                    newest = created;
                    best = (
                        ProcessIdentity {
                            pid: entry.pid,
                            start_ticks: created,
                        },
                        entry.image.clone(),
                    );
                }
            }
        }
        frontier = next;
    }

    Some(best)
}

/// One pid, as an identity. A pid on its own is not one: they are reused.
pub fn identify(pid: u32) -> Option<ProcessIdentity> {
    Some(ProcessIdentity {
        pid,
        start_ticks: created_at(pid)?,
    })
}

pub fn foreground_identity(shell_pid: u32) -> Option<ProcessIdentity> {
    foreground_entry(shell_pid).map(|(identity, _)| identity)
}

/// The command currently in the foreground of `shell_pid`'s terminal, in the
/// spelling `classify_agent` expects.
///
/// `classify_agent` matches the bare names the Linux kernel reports in
/// `comm` — "claude", "codex". Windows reports an image file name, so
/// "Claude.exe" is folded to "claude" HERE rather than by loosening the match
/// itself: that keeps the Linux path byte-identical and preserves the property
/// that an unknown binary is not an agent.
///
/// An agent installed as an npm shim runs as `node.exe` and will not classify.
/// That is the correct answer under Axiom 3 — the foreground process genuinely
/// is node, and naming the agent would require reading another process's
/// command line. Tracked separately; it renders `--`, not a guess.
pub fn foreground_command(shell_pid: u32) -> Option<String> {
    let (_, image) = foreground_entry(shell_pid)?;
    let stem = std::path::Path::new(&image)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(image);
    let folded = stem.to_ascii_lowercase();
    if folded.is_empty() {
        None
    } else {
        Some(folded)
    }
}

/// Unknown on Windows.
///
/// There is no cheap, supported per-process working directory: it lives in the
/// target's PEB and reading it means `NtQueryInformationProcess` plus
/// `ReadProcessMemory` against a semi-documented layout that differs under
/// WOW64. The directory arrives instead from OSC 7, which the PowerShell shell
/// integration emits — see `shell_integration.rs`.
pub fn foreground_cwd(_shell_pid: u32) -> Option<String> {
    None
}

/// Unknown on Windows.
///
/// The `/proc/<pid>/fd` equivalent is
/// `NtQuerySystemInformation(SystemExtendedHandleInformation)`, which needs a
/// worker thread to survive `NtQueryObject` blocking forever on a synchronous
/// file handle. macOS has had this same gap since launch and ships with it.
///
/// The consequence is bounded and honest: Codex's rollout file is found by the
/// hook's own `transcript_path` when a hook is installed, and reads `--` when
/// one is not. Returning an empty vector is what `codex::open_rollout` already
/// expects from a platform that cannot answer.
pub fn open_files(_identity: ProcessIdentity) -> Vec<std::path::PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_its_own_identity_and_the_nonce_is_stable() {
        let me = std::process::id();
        let first = identify(me).expect("we can always identify ourselves");
        let second = identify(me).expect("and again");
        assert_eq!(first.pid, me);
        assert_ne!(first.start_ticks, 0, "a creation time of 0 is not a nonce");
        assert_eq!(
            first, second,
            "a process identity must not change under its own feet"
        );
    }

    #[test]
    fn a_pid_that_does_not_exist_has_no_identity() {
        // 0 is the System Idle Process: never openable for query.
        assert!(identify(0).is_none());
    }

    #[test]
    fn the_process_table_contains_this_process_and_its_image_name() {
        let table = process_table().expect("a snapshot of our own machine");
        let me = table
            .iter()
            .find(|e| e.pid == std::process::id())
            .expect("we are in our own process table");
        assert!(
            !me.image.is_empty(),
            "every row must carry an image name: {:?}",
            me.pid
        );
    }

    #[test]
    fn a_spawned_child_becomes_the_foreground_of_this_process() {
        // The whole contract in one test: start something, and the tree walk
        // must name it rather than naming us.
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "ping -n 4 127.0.0.1 > NUL"])
            .spawn()
            .expect("cmd.exe is present on every Windows runner");

        let found = foreground_command(std::process::id());
        let identity = foreground_identity(std::process::id());

        child.kill().ok();
        child.wait().ok();

        assert_eq!(
            found.as_deref(),
            Some("cmd"),
            "the newest descendant is the foreground process, folded to a bare name"
        );
        let identity = identity.expect("a foreground process has an identity");
        assert_ne!(
            identity.pid,
            std::process::id(),
            "the child, not the parent, is in the foreground"
        );
    }

    #[test]
    fn a_process_with_no_descendants_reports_itself() {
        // Mirrors what tpgid reports on Linux at a bare prompt: the shell. The
        // caller's classify_agent then correctly declines to call it an agent.
        let identity =
            foreground_identity(std::process::id()).expect("we are always our own fallback answer");
        assert!(identity.start_ticks > 0);
    }

    #[test]
    fn open_files_is_empty_rather_than_wrong() {
        let me = identify(std::process::id()).expect("our own identity");
        assert!(
            open_files(me).is_empty(),
            "an unanswerable question must return nothing, never a guess"
        );
    }

    #[test]
    fn foreground_cwd_is_unknown_rather_than_the_daemons_own_directory() {
        assert_eq!(foreground_cwd(std::process::id()), None);
    }
}
