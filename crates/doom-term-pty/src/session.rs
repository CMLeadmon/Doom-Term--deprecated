use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use crate::demuxer::{DemuxEvent, StreamDemuxer};
use crate::shell_integration::{apply_shell_integration, shell_launch};
use crate::stream::{
    Identity, JournalHub, StreamFault, StreamJournal, StreamMetadata, StreamPayload,
};
use crate::tmux::{self, TmuxHandle};

/**
 * Move off a working directory that can be taken away, once, at startup.
 *
 * Nothing we start should inherit the directory an AppImage happens to run
 * from. `AppRun` chdirs into the mount — `/tmp/.mount_XXXXXXXX/usr` — and the
 * mount goes away when the app exits, while the tmux server we started from it
 * does not: surviving the app is the entire point of the tmux substrate. A
 * server left holding that directory is holding a detached one, and a tmux
 * server whose cwd has been deleted silently ignores `new-session -c` and puts
 * every later pane in the dead directory instead. That is how a new terminal
 * came up at `/tmp/.mount_DoomTeKMdGLL/usr` with `getcwd` failing and six lines
 * of "Transport endpoint is not connected" ahead of its first prompt.
 *
 * `launch_in` in tmux.rs is the guarantee for the pane itself. This is the
 * other half: the helpers we spawn, the servers they start, and
 * `resolve_cwd`'s last resort all read the process's own directory, and after
 * this it is one that exists for as long as the user does.
 *
 * Returns where it landed. Idempotent, and a failure is not fatal — the
 * directory we have is no worse than the one we were trying to leave.
 */
pub fn anchor_working_directory() -> std::path::PathBuf {
    let current = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
    let home = home_dir();
    for candidate in anchor_candidates(home.as_deref()) {
        if candidate == current {
            return current;
        }
        if std::env::set_current_dir(&candidate).is_ok() {
            return candidate;
        }
    }
    current
}

/// Where to anchor, in order of preference. Pure, and pure for the same reason
/// `augment_path` is: `set_current_dir` is process-global, so a test that
/// exercised the real thing would move every other test's spawned child with
/// it — the exact failure the note on `augment_path` describes.
fn anchor_candidates(home: Option<&std::path::Path>) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::with_capacity(2);
    if let Some(home) = home {
        // A user's home outlives the app. It is also `resolve_cwd`'s fallback,
        // so both agree about where "nowhere in particular" is.
        candidates.push(home.to_path_buf());
    }
    // Always reachable, and never a mount we brought with us.
    candidates.push(std::path::PathBuf::from("/"));
    candidates
}

/// The user's home directory, by whichever name this platform gives it.
///
/// `HOME` is not a Windows variable. cmd.exe and PowerShell set `USERPROFILE`,
/// and only MSYS/Git-Bash-style shells mirror it into `HOME`. Reading `HOME`
/// alone meant every fallback built on it silently took its next branch on
/// Windows: `resolve_cwd` started shells in the daemon's own directory,
/// `credentials.rs` never found the Claude token, and `provision_cli_tools`
/// returned without installing anything — each one looking like a different
/// bug.
///
/// `HOME` is still asked first. A user who sets it means it, and on Unix it is
/// the only answer.
pub fn home_dir() -> Option<std::path::PathBuf> {
    ["HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(std::env::var_os)
        .find(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
}

pub fn expand_path(path_str: &str) -> std::path::PathBuf {
    if path_str == "~" {
        if let Some(home) = home_dir() {
            return home;
        }
    } else if let Some(rest) = path_str.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(path_str)
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
    pub working_dir: String,
    pub shell: String,
    pub is_alive: bool,
}

type OwnedChild = Arc<parking_lot::Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>;

// Not `all(test, unix)`: the module also holds pure-function tests with no OS
// dependency at all, and gating the file hid them from every Windows run.
#[cfg(test)]
mod tests;

#[allow(dead_code)]
pub struct PtySession {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
    master: Arc<parking_lot::Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<parking_lot::Mutex<Box<dyn Write + Send>>>,
    /// Serializes direct-child mode observations with paste admission/delivery.
    paste_mode: Arc<parking_lot::Mutex<bool>>,
    /// The last thing a shell on the far end of a transport said about itself.
    ///
    /// None for a local session, and for a remote one that has not reported
    /// yet. Its presence changes how `metadata::telemetry` reads every other
    /// field, so "has not reported yet" and "is local" must stay the same
    /// answer: both mean nothing has been observed.
    remote: Arc<parking_lot::Mutex<Option<crate::remote::RemoteEnrichment>>>,
    running: Arc<AtomicBool>,
    retired: Arc<AtomicBool>,
    child: OwnedChild,
    threads: parking_lot::Mutex<Vec<thread::JoinHandle<()>>>,
    child_pid: Option<u32>,
    /// The pid of the shell this session owns, when we spawned it directly.
    /// Under tmux the shell is not our child at all; see `shell_pid`.
    shell_pid_direct: Option<u32>,
    journal: StreamJournal,
    /// Serializes adapter observations (not blocking reads or callbacks).
    observations: Arc<parking_lot::Mutex<()>>,
    /// The tmux session backing this pane, when there is one. Its presence is
    /// what makes the shell outlive us.
    tmux: Option<TmuxHandle>,
    /// Why this session is not durable, when it is not. Reported to the UI:
    /// a persistence guarantee that silently is not one is worse than none.
    durability_detail: Option<String>,
    /// Windows only: the job object holding this session's process tree, so
    /// that closing a pane closes what the pane started. See `job.rs` — Unix
    /// gets the same guarantee from `killpg` and needs no field.
    #[cfg(windows)]
    job: Option<crate::job::JobObject>,
}

pub struct DurableRebuild {
    pub session: PtySession,
    pub archive: std::result::Result<tmux::CapturedArchive, String>,
}

/// The directory a session should start in, falling back the way the previous
/// inline version did: requested, then home, then wherever the daemon runs.
fn resolve_cwd(requested: Option<&str>) -> std::path::PathBuf {
    if let Some(dir) = requested {
        let expanded = expand_path(dir);
        if expanded.exists() {
            return expanded;
        }
    }
    if let Some(home) = home_dir() {
        return home;
    }
    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"))
}

type TmuxCommand = (CommandBuilder, Option<TmuxHandle>, Option<String>);

/// How a pane names itself to the programs running inside it.
///
/// Read back by `tools/agent-hooks/doom-term-hook.sh`, which forwards it so an
/// agent's hook event can be attributed to the exact pane that started it
/// rather than to whichever session happens to share its directory.
pub const SESSION_ID_ENV: &str = "DOOM_TERM_SESSION_ID";
pub const SESSION_INCARNATION_ENV: &str = "DOOM_TERM_INCARNATION";

/// Where a bundled tmux would live: beside the daemon executable, which is how
/// Tauri lays sidecars out.
fn sidecar_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell.exe".into()
        } else {
            "/bin/bash".into()
        }
    })
}

fn augmented_path() -> Option<String> {
    augment_path(
        home_dir()?.as_path(),
        &std::env::var_os("PATH").unwrap_or_default(),
    )
}

/// Pure, and pure for a reason.
///
/// This was tested by setting HOME and PATH with `std::env::set_var`, which is
/// process-global and therefore visible to every other test running at the same
/// time. `resolve_cwd` reads HOME, so for the length of that one test every PTY
/// another test spawned was told to start in `/custom/user`; the child chdir'd
/// into a directory that does not exist and died with "No such file or
/// directory" naming a program that was plainly there. That is what made
/// `cargo test -p doom-term-pty` fail in roughly one run in four, on whichever
/// of the three PTY tests happened to overlap. Take the environment as
/// arguments and the test needs no global state at all.
/// Prepend the user's own bin directories, in the platform's own spelling.
///
/// This split and rejoined on ':' and built paths with `format!("{}/...")`,
/// which produces `C:\Users\me/.local/bin` joined with ':' on Windows — a
/// PATH no Windows process can parse, silently handed to every shell we spawn.
/// `split_paths`/`join_paths` and `Path::join` are the same code on Unix and
/// correct on both.
fn augment_path(home: &std::path::Path, current_path: &std::ffi::OsStr) -> Option<String> {
    let local_bin = home.join(".local").join("bin");
    let doom_bin = home.join(".doom-term").join("bin");
    let parts: Vec<std::path::PathBuf> = std::env::split_paths(current_path)
        .filter(|part| !part.as_os_str().is_empty())
        .collect();

    let mut prepend = Vec::new();
    if !parts.contains(&local_bin) {
        prepend.push(local_bin);
    }
    if !parts.contains(&doom_bin) {
        prepend.push(doom_bin);
    }

    if prepend.is_empty() {
        return None;
    }
    prepend.extend(parts);
    std::env::join_paths(prepend)
        .ok()
        .map(|joined| joined.to_string_lossy().into_owned())
}

fn prepare_command(cmd: &mut CommandBuilder, id: &str) {
    cmd.env_remove("TMUX");
    cmd.env_remove("TMUX_PANE");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("DOOM_TERM", "1");
    cmd.env(SESSION_ID_ENV, id);
    if let Some(path) = augmented_path() {
        cmd.env("PATH", path);
    }
}

fn available_tmux() -> std::result::Result<std::path::PathBuf, String> {
    available_tmux_before(std::time::Instant::now() + std::time::Duration::from_secs(2))
}
fn available_tmux_before(
    deadline: std::time::Instant,
) -> std::result::Result<std::path::PathBuf, String> {
    let exe = tmux::resolve_tmux(sidecar_dir().as_deref())
        .ok_or_else(|| "tmux unavailable or disabled".to_string())?;
    let timeout = deadline
        .saturating_duration_since(std::time::Instant::now())
        .min(std::time::Duration::from_secs(2));
    if timeout.is_zero() {
        return Err("tmux bootstrap deadline expired".into());
    }
    let version = crate::process_io::run(&exe, &["-V".into()], &[], timeout)
        .map_err(|_| "tmux version check failed".to_string())?;
    if !tmux::version_supported(&String::from_utf8_lossy(&version)) {
        return Err("tmux 3.7 or newer is required".into());
    }
    Ok(exe)
}

impl PtySession {
    pub fn discover_durable() -> Result<Vec<tmux::DiscoveredPane>> {
        let exe = available_tmux().map_err(anyhow::Error::msg)?;
        tmux::discover_owned(&exe)
    }
    /// Explicit identity assignment only. No root, display client, journal or
    /// input ownership is created; the caller must subsequently Attach.
    pub fn identify_legacy(id: &str, pane: &str, root_pid: u32) -> Result<Identity> {
        let exe = available_tmux().map_err(anyhow::Error::msg)?;
        let handle = TmuxHandle::recover_legacy(exe, id, pane, root_pid)?;
        Ok(handle
            .incarnation()
            .expect("recovery resolves an owned pane")
            .clone())
    }
    /// One bounded cold bootstrap, with history kept outside the new journal.
    pub fn rebuild_durable(
        id: String,
        incarnation: &Identity,
        previous: Option<&Self>,
    ) -> Result<DurableRebuild> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let exe = available_tmux_before(deadline).map_err(anyhow::Error::msg)?;
        let handle = TmuxHandle::resolve_owned_before(exe, &id, incarnation, deadline)?;
        let (cols, rows) = handle.geometry_before(deadline)?;
        let archive = handle
            .capture_archive_before(deadline)
            .map_err(|_| "History unavailable: bounded capture failed".to_string());
        if let Some(previous) = previous {
            let meta = previous.stream().snapshot().metadata;
            anyhow::ensure!(
                meta.session_id == id && &meta.incarnation == incarnation && meta.durable,
                "Rebuild cannot retire a different process incarnation"
            );
            previous.retire_adapter_before(deadline)?;
        }
        let session = Self::open_durable_adapter(id, cols, rows, handle, deadline)?;
        Ok(DurableRebuild { session, archive })
    }
    /// V2 creation opens a journal-owned display stream, without callbacks.
    /// Durable creation conflicts are errors, never an attach or direct fallback.
    pub fn create(
        id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell_cmd: Option<String>,
    ) -> Result<Self> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        anyhow::ensure!(cols > 0 && rows > 0, "Terminal dimensions must be positive");
        let shell = shell_cmd.unwrap_or_else(default_shell);
        let working_dir = resolve_cwd(cwd.as_deref());
        let built = match available_tmux() {
            Ok(exe) => {
                let mut launch = shell_launch(&shell);
                launch.env.push((SESSION_ID_ENV.into(), id.clone()));
                launch.env.push(("TERM".into(), "xterm-256color".into()));
                launch.env.push(("COLORTERM".into(), "truecolor".into()));
                launch.env.push(("DOOM_TERM".into(), "1".into()));
                if let Some(path) = augmented_path() {
                    launch.env.push(("PATH".into(), path));
                }
                let handle = TmuxHandle::create_owned(
                    exe,
                    &id,
                    cols,
                    rows,
                    &working_dir,
                    &launch.env,
                    &shell,
                    &launch.args,
                    deadline,
                )?;
                return Self::open_durable_adapter(id, cols, rows, handle, deadline);
            }
            Err(reason) => {
                let mut cmd = CommandBuilder::new(&shell);
                apply_shell_integration(&mut cmd, &shell);
                prepare_command(&mut cmd, &id);
                cmd.cwd(working_dir);
                (cmd, None, Some(reason))
            }
        };
        Self::start_adapter(id, cols, rows, built, Identity::random()?)
    }

    /// No shell, cwd, create-or-attach, or fallback may enter this path.
    pub fn attach_durable(
        id: String,
        incarnation: &Identity,
        cols: u16,
        rows: u16,
    ) -> Result<Self> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let exe = available_tmux_before(deadline).map_err(anyhow::Error::msg)?;
        let handle = TmuxHandle::resolve_owned_before(exe, &id, incarnation, deadline)?;
        Self::open_durable_adapter(id, cols, rows, handle, deadline)
    }

    fn open_durable_adapter(
        id: String,
        cols: u16,
        rows: u16,
        handle: TmuxHandle,
        deadline: std::time::Instant,
    ) -> Result<Self> {
        // Reserve the final three seconds for owned-client/thread retirement.
        let display_deadline = deadline - std::time::Duration::from_secs(3);
        anyhow::ensure!(
            std::time::Instant::now() < display_deadline,
            "Durable bootstrap timed out before display creation"
        );
        let incarnation = handle
            .incarnation()
            .context("Unidentified durable pane")?
            .clone();
        let mut cmd = CommandBuilder::new(&handle.exe);
        cmd.args(handle.attach_args()?);
        prepare_command(&mut cmd, &id);
        let session = Self::start_adapter(
            id,
            cols,
            rows,
            (cmd, Some(handle.clone()), None),
            incarnation,
        )?;
        while session.is_alive() && std::time::Instant::now() < display_deadline {
            match session
                .child_pid
                .map(|pid| handle.has_display_client(pid, display_deadline))
            {
                Some(Ok(true)) => return Ok(session),
                Some(Ok(false)) => {}
                _ => break,
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        session.retire_adapter_before(deadline)?;
        anyhow::bail!("Durable display attachment failed; the pane was not replaced or restarted")
    }

    pub fn capture_archive(&self) -> Result<tmux::CapturedArchive> {
        self.tmux
            .as_ref()
            .context("Direct PTY has no durable history archive")?
            .capture_archive()
    }

    pub fn paste(&self, text: &str) -> Result<()> {
        self.paste_checked(text, || Ok(()))
    }
    pub fn paste_checked(
        &self,
        text: &str,
        mut authorize: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        let clean = crate::paste::prepare_paste(text)?;
        let mut writer = self
            .writer
            .try_lock_for(std::time::Duration::from_secs(2))
            .context("PTY input is busy; paste was not sent")?;
        authorize()?;
        anyhow::ensure!(self.is_alive(), "Session is closed; paste was not sent");
        anyhow::ensure!(
            !self.journal.snapshot().ended,
            "Rendering stream has ended; paste was not sent"
        );
        if clean.is_empty() {
            return Ok(());
        }
        if let Some(handle) = &self.tmux {
            return handle.paste_checked(&clean, authorize);
        }
        let enabled = self.paste_mode.lock();
        authorize()?;
        anyhow::ensure!(
            *enabled || !clean.contains('\n'),
            "Multiline paste blocked: child has not enabled bracketed paste"
        );
        let result = (|| -> std::io::Result<()> {
            if *enabled {
                writer.write_all(b"\x1b[200~")?;
            }
            writer.write_all(clean.as_bytes())?;
            if *enabled {
                writer.write_all(b"\x1b[201~")?;
            }
            writer.flush()
        })();
        result.map_err(|_| anyhow::anyhow!("Paste delivery failed; delivery may be incomplete"))
    }

    fn start_adapter(
        id: String,
        cols: u16,
        rows: u16,
        built: TmuxCommand,
        incarnation: Identity,
    ) -> Result<Self> {
        let (mut cmd, tmux_handle, durability_detail) = built;
        cmd.env(SESSION_INCARNATION_ENV, incarnation.as_str());
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Failed to open PTY pair")?;
        // Establish identity/retention before launching a process. Validation
        // failure must not leave an untracked child behind.
        let journal = JournalHub::shared().open(StreamMetadata::new(
            id.clone(),
            incarnation,
            cols,
            rows,
            tmux_handle.is_some(),
        )?)?;
        // Under tmux our child is the tmux CLIENT, so its status describes a
        // detach, not the user's shell. Only a directly spawned shell can be
        // reported on honestly; see the reader thread's close arm.
        let child_status_is_meaningful = tmux_handle.is_none();
        let mut reader = pair
            .master
            .try_clone_reader()
            .context("Failed to clone PTY reader")?;
        let writer = Arc::new(parking_lot::Mutex::new(
            pair.master
                .take_writer()
                .context("Failed to take PTY writer")?,
        ));
        // Complete all fallible descriptor setup before starting the process.
        // Name the program in the error: "No such file or directory" with no
        // subject is not a diagnosis, and this is the one failure a user hits
        // when their shell, or tmux, is not where we were told it would be.
        let program = cmd.get_argv().first().cloned().unwrap_or_default();
        // The directory goes in too. The child chdir()s into it before it
        // execs, so a working directory that has gone away reports itself as
        // "No such file or directory" against a program that is plainly there.
        let in_dir = cmd
            .get_cwd()
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        let child = pair.slave.spawn_command(cmd).with_context(|| {
            format!(
                "Failed to spawn {} in PTY (cwd {})",
                std::path::Path::new(&program).display(),
                in_dir.display()
            )
        })?;
        let child_pid = child.process_id();
        let shell_pid_direct = child_pid;
        // Windows has no process group to signal, so the tree is held by a job
        // object instead; see `job.rs`. This is the earliest seam
        // `portable-pty` exposes — the race that leaves is documented there.
        //
        // A failure here must not fail the session: an unplaceable child is a
        // pane that still works and still reports honestly, where refusing to
        // start would be a terminal that does not open.
        #[cfg(windows)]
        let job = child_pid.and_then(|pid| match crate::job::JobObject::create_for(pid) {
            Ok(job) => Some(job),
            Err(error) => {
                log::warn!("Session {id} could not be placed in a job object: {error:#}");
                None
            }
        });
        let child: OwnedChild = Arc::new(parking_lot::Mutex::new(Some(child)));
        let reader_child = child.clone();
        let reader_tmux = tmux_handle.clone();
        let master = Arc::new(parking_lot::Mutex::new(pair.master));
        let paste_mode = Arc::new(parking_lot::Mutex::new(false));
        let reader_paste_mode = paste_mode.clone();
        let remote: Arc<parking_lot::Mutex<Option<crate::remote::RemoteEnrichment>>> =
            Arc::new(parking_lot::Mutex::new(None));
        let reader_remote = remote.clone();

        let running = Arc::new(AtomicBool::new(true));
        let running_clone = running.clone();
        let retired = Arc::new(AtomicBool::new(false));
        let reader_retired = retired.clone();
        let mut threads = Vec::new();

        let reader_journal = journal.clone();
        let observations = Arc::new(parking_lot::Mutex::new(()));
        let reader_observations = observations.clone();

        // The reader answers the terminal's own mail. A program that asks what
        // colour we are, or where the cursor sits, blocks on a timeout until it
        // hears back — so the reply has to go out on this thread, before the
        // events are forwarded to the UI.
        let responder = writer.clone();

        // The alternate-screen poll. Emits only on change: the frontend treats
        // TuiMode as a state report, and a repeated one would re-render the
        // pane twice a second for no reason.
        if let Some(handle) = tmux_handle.clone() {
            let running_poll = running.clone();
            let poll_journal = journal.clone();
            let poll_observations = observations.clone();
            threads.push(thread::spawn(move || {
                let mut last: Option<bool> = None;
                while running_poll.load(Ordering::Relaxed) {
                    if let Some(active) = handle.alternate_on() {
                        if !running_poll.load(Ordering::Relaxed) {
                            break;
                        }
                        if last != Some(active) {
                            last = Some(active);
                            {
                                let _order = poll_observations.lock();
                                if poll_journal
                                    .append(StreamPayload::Event(DemuxEvent::TuiMode { active }))
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                    thread::sleep(tmux::ALT_POLL);
                }
            }));
        }

        threads.push(thread::spawn(move || {
            let mut demuxer = StreamDemuxer::new();
            let mut buffer = [0u8; 8192];

            while running_clone.load(Ordering::Relaxed) {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let order = reader_observations.lock();
                        // A fault invalidates rendering, not the user's process.
                        // Continue draining the PTY without accumulating a tail.
                        if reader_journal.snapshot().ended {
                            continue;
                        }
                        let events = demuxer.process_bytes(&buffer[..n]);
                        // Apply the last mode in this read before input admission.
                        if let Some(enabled) = events.iter().rev().find_map(|event| match event {
                            DemuxEvent::BracketedPasteMode { enabled } => Some(*enabled),
                            _ => None,
                        }) {
                            *reader_paste_mode.lock() = enabled;
                        }
                        // Last one wins: the frame is emitted once per prompt,
                        // so the newest is the only one that still describes
                        // where the shell is.
                        if let Some(data) = events.iter().rev().find_map(|event| match event {
                            DemuxEvent::RemoteEnrichment { data } => Some(data.clone()),
                            _ => None,
                        }) {
                            *reader_remote.lock() = Some(data);
                        }

                        for event in events {
                            let payload = match &event {
                                DemuxEvent::StreamFault { reason } => {
                                    StreamPayload::Fault { reason: *reason }
                                }
                                _ => StreamPayload::Event(event.clone()),
                            };
                            if reader_journal.append(payload).is_err() {
                                break;
                            }
                        }
                        let replies = demuxer.take_responses();
                        drop(order);
                        if !replies.is_empty() {
                            let mut w = responder.lock();
                            if w.write_all(&replies).and_then(|_| w.flush()).is_err() {
                                log::warn!("Failed to answer terminal query");
                            }
                        }
                    }
                    Err(e) => {
                        log::error!("PTY read error: {:?}", e);
                        break;
                    }
                }
            }

            running_clone.store(false, Ordering::Relaxed);

            // Ask the kernel what happened rather than asserting it went well.
            //
            // This used to be an unconditional `Some(0)`. EOF on the pty says
            // the session ended, and nothing whatsoever about how: a shell that
            // died on a signal, a command that exited 1, and a clean logout all
            // arrived at the UI as a green PASS. `--` is the honest answer when
            // we cannot know, per the never-invent-telemetry rule.
            // Reap display clients too. Keeping the owned Child under this
            // lock prevents retirement from signalling a recycled process id.
            let status = loop {
                let mut slot = reader_child.lock();
                let Some(child) = slot.as_mut() else {
                    break None;
                };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        slot.take();
                        break Some(status);
                    }
                    Err(error) => {
                        log::warn!("Could not reap PTY child: {error}");
                        break None;
                    }
                    Ok(None) => {}
                }
                drop(slot);
                thread::sleep(std::time::Duration::from_millis(5));
            };
            // Retiring our display stream says nothing about the shell exit.
            if reader_retired.load(Ordering::Relaxed) {
                return;
            }
            let exit_code = if child_status_is_meaningful {
                status.map(|s| s.exit_code() as i32)
            } else {
                None
            };

            {
                let _order = reader_observations.lock();
                // Process closure is not an observed OSC 133 command boundary.
                if child_status_is_meaningful {
                    reader_journal.observe_process_exit(exit_code);
                } else if reader_tmux
                    .as_ref()
                    .and_then(TmuxHandle::pane_pid)
                    .is_none()
                {
                    // The owned display ended and its exact pane is no longer
                    // observable. tmux cannot give us the root's exit status
                    // after removing the pane, but it can prove the process
                    // incarnation no longer exists.
                    reader_journal.observe_process_exit(None);
                } else {
                    // The display client is our child; the durable root is
                    // not. Its exit status cannot certify the pane's exit.
                    let _ = reader_journal.append(StreamPayload::Fault {
                        reason: StreamFault::AdapterLost,
                    });
                }
            }
        }));

        Ok(Self {
            id,
            cols,
            rows,
            master,
            writer,
            paste_mode,
            remote,
            running,
            retired,
            child,
            threads: parking_lot::Mutex::new(threads),
            child_pid,
            shell_pid_direct,
            journal,
            observations,
            tmux: tmux_handle,
            durability_detail,
            #[cfg(windows)]
            job,
        })
    }

    /// The pid whose /proc entry names the foreground command.
    ///
    /// Under tmux this is the pane's shell, not the client we spawned: the
    /// client is what sits in the foreground of OUR pty, so asking about it
    /// reports tmux forever and the agent well never lights up. The name and
    /// signature are unchanged so callers do not have to know which case holds.
    pub fn shell_pid(&self) -> Option<u32> {
        match &self.tmux {
            Some(handle) => handle.pane_pid(),
            None => self.shell_pid_direct,
        }
    }

    /// What is actually running in this session's terminal, by name.
    ///
    /// The kernel first: `/proc/<pid>/stat` field 8 is the foreground process
    /// group of the controlling terminal, which is the precise answer and the
    /// one this app has always used. It is also Linux-only.
    ///
    /// tmux second, and only when the kernel route yields nothing. On macOS
    /// there is no /proc at all, so without this fallback the agent well,
    /// CONTEXT %, USAGE % and keyboard pass-through would all stay dark on a
    /// machine where every other part of the terminal works. Ordering it second
    /// rather than first is deliberate: Linux behaviour stays byte-identical to
    /// what shipped, and the new path only runs where the old one cannot.
    pub fn foreground_command(&self) -> Option<String> {
        if let Some(comm) = self
            .shell_pid()
            .and_then(crate::foreground::foreground_command)
        {
            return Some(comm);
        }
        self.tmux
            .as_ref()
            .and_then(|handle| handle.pane_current_command())
    }

    /// Where this session actually is, per the kernel.
    ///
    /// Under tmux the pane's own record is the fallback: it tracks `cd` even
    /// when /proc is unreadable, and it is what `list-panes` reports.
    /// What the far end last reported, or None for a local session.
    pub fn remote_enrichment(&self) -> Option<crate::remote::RemoteEnrichment> {
        self.remote.lock().clone()
    }

    pub fn current_cwd(&self) -> Option<String> {
        if let Some(dir) = self.shell_pid().and_then(crate::foreground::foreground_cwd) {
            return Some(dir);
        }
        self.tmux
            .as_ref()
            .and_then(|handle| handle.pane_current_path())
    }

    pub fn is_durable(&self) -> bool {
        self.tmux.is_some()
    }

    pub fn durability_detail(&self) -> Option<String> {
        self.durability_detail.clone()
    }

    pub fn stream(&self) -> StreamJournal {
        self.journal.clone()
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        self.write_checked(data, || Ok(()))
    }
    pub fn write_checked(
        &self,
        data: &[u8],
        mut authorize: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        let mut writer = self
            .writer
            .try_lock_for(std::time::Duration::from_secs(2))
            .context("PTY input is busy; this input was not sent")?;
        // A job admitted before disconnection may wait behind another writer.
        // Recheck its socket lease after that wait, immediately before delivery.
        authorize()?;
        anyhow::ensure!(
            !self.journal.snapshot().ended,
            "Rendering stream has ended; input was not sent"
        );
        if let Some(handle) = self
            .tmux
            .as_ref()
            .filter(|handle| handle.incarnation().is_some())
        {
            return handle.write_checked(data, authorize);
        }
        writer.write_all(data).context("Failed to write to PTY")?;
        writer.flush().context("Failed to flush PTY writer")?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.resize_checked(cols, rows, || Ok(()))
    }
    pub fn resize_checked(
        &self,
        cols: u16,
        rows: u16,
        authorize: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        anyhow::ensure!(cols > 0 && rows > 0, "Terminal dimensions must be positive");
        let _order = self.observations.lock();
        authorize()?;
        anyhow::ensure!(!self.journal.snapshot().ended, "Rendering stream has ended");
        let owned = self
            .tmux
            .as_ref()
            .filter(|handle| handle.incarnation().is_some());
        if let Some(handle) = owned {
            handle.resize_owned(cols, rows)?;
        }
        let master = self.master.lock();
        let result = master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Failed to resize PTY");
        if result.is_err() && owned.is_some() {
            // The pane may already have resized, but the display did not.
            // Continuing that stream would fabricate a valid replay geometry.
            let _ = self.journal.append(StreamPayload::Fault {
                reason: StreamFault::AdapterLost,
            });
        }
        result?;
        self.journal.append(StreamPayload::Resize { cols, rows })?;
        Ok(())
    }

    pub fn send_signal(&self, sig: &str) -> Result<()> {
        self.send_signal_checked(sig, || Ok(()))
    }
    pub fn send_signal_checked(
        &self,
        sig: &str,
        mut authorize: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        match sig {
            "SIGINT" | "INT" | "ctrl+c" => {
                // The terminal line discipline owns ISIG and foreground-group
                // delivery. A raw-mode agent must receive the byte without an
                // extra killpg interrupting the application or its parent shell.
                self.write_checked(&[0x03], authorize)?;
            }
            "SIGTSTP" | "TSTP" | "ctrl+z" => {
                self.write_checked(&[0x1a], authorize)?;
            }
            "EOF" | "ctrl+d" => {
                self.write_checked(&[0x04], authorize)?;
            }
            "SIGKILL" | "KILL" => {
                authorize()?;
                self.kill()?;
            }
            _ => {
                log::warn!("Unsupported signal: {}", sig);
            }
        }
        Ok(())
    }

    /// Whether the reader thread is still attached to a live process.
    ///
    /// Whether this adapter's owned reader is still live.
    pub fn is_alive(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    pub fn kill(&self) -> Result<()> {
        // Under tmux, killing our own child only detaches the client and the
        // shell keeps running with nothing attached to it — a leak the user
        // cannot see or reach. Closing a tab has to close the session.
        if let Some(handle) = &self.tmux {
            anyhow::ensure!(
                handle.kill_session(),
                "Durable pane is missing or replaced; kill refused"
            );
            {
                let _order = self.observations.lock();
                self.journal.observe_process_exit(None);
            }
            return self.retire_adapter();
        }
        // The owned, unreaped Child is authority; a cached numeric pid is not.
        // Hold this slot through signalling so the reader cannot reap the root
        // and allow its pid to be reused between the check and the signal.
        let mut slot = self.child.lock();
        let child = slot
            .as_mut()
            .context("Direct PTY is already closed; kill refused")?;
        anyhow::ensure!(
            child.try_wait()?.is_none(),
            "Direct PTY is already closed; kill refused"
        );
        #[cfg(unix)]
        {
            let pid = child
                .process_id()
                .context("Direct PTY process identity is unavailable")?;
            nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGKILL,
            )
            .context("Failed to kill the owned PTY process group")?;
        }
        // The job object is the process group Windows does not have: every
        // descendant the shell started is in it, so this is what stops a closed
        // pane from leaving a running agent nobody can reach. `child.kill()`
        // below stays as the fallback for a session that could not be placed.
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate()?;
        }
        #[cfg(not(unix))]
        child.kill()?;
        self.running.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// Retire/reap only our display client and threads, never the pane/server.
    /// A direct child cannot be retired without killing the user's process.
    pub fn retire_adapter(&self) -> Result<()> {
        self.retire_adapter_before(std::time::Instant::now() + std::time::Duration::from_secs(3))
    }
    fn retire_adapter_before(&self, deadline: std::time::Instant) -> Result<()> {
        anyhow::ensure!(self.is_durable(), "Direct PTY adapter cannot be retired");
        self.retired.store(true, Ordering::Relaxed);
        self.running.store(false, Ordering::Relaxed);
        {
            let _order = self.observations.lock();
            let _ = self.journal.append(StreamPayload::Fault {
                reason: StreamFault::AdapterRetired,
            });
        }
        {
            let mut slot = self.child.lock();
            if let Some(child) = slot.as_mut() {
                if child.try_wait()?.is_some() {
                    slot.take();
                } else {
                    #[cfg(unix)]
                    if let Some(pid) = child.process_id() {
                        nix::sys::signal::kill(
                            nix::unistd::Pid::from_raw(pid as i32),
                            nix::sys::signal::Signal::SIGKILL,
                        )?;
                    }
                    #[cfg(not(unix))]
                    child.kill()?;
                }
            }
        }
        let deadline = deadline.min(std::time::Instant::now() + std::time::Duration::from_secs(3));
        let mut threads = self.threads.lock();
        while threads.iter().any(|thread| !thread.is_finished()) {
            anyhow::ensure!(
                std::time::Instant::now() < deadline,
                "Display adapter retirement timed out"
            );
            thread::sleep(std::time::Duration::from_millis(5));
        }
        for thread in threads.drain(..) {
            thread
                .join()
                .map_err(|_| anyhow::anyhow!("Display adapter thread failed"))?;
        }
        Ok(())
    }
}
