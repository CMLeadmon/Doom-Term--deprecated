//! Closing a pane has to close what the pane started.
//!
//! On Unix a session's shell gets its own process group and `kill()` signals
//! the group, so a pipeline, a subshell and an agent CLI all go with it. That
//! is what `session.rs` means by "Closing a tab has to close the session".
//!
//! Windows has no process groups to signal, and `portable-pty` does not supply
//! a substitute: `win/psuedocon.rs` calls `CreateProcessW` with only
//! `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT` — no job object,
//! no `CREATE_NEW_PROCESS_GROUP` — and `win/mod.rs` kills with
//! `TerminateProcess` against one handle. So closing a pane running an agent
//! killed the shell and left the agent running: no terminal, no window, no way
//! back to it, still holding its API session. Exactly the leak the Unix path
//! exists to prevent, in the platform that had no equivalent.
//!
//! A job object is that equivalent. Every process the shell starts inherits
//! membership, and `TerminateJobObject` ends the tree in one call.
//!
//! ── WHY KILL_ON_JOB_CLOSE ──────────────────────────────────────────────────
//!
//! The daemon owns the only handle to the job, so if the daemon dies the job
//! closes and the tree goes with it. That is deliberate. Windows has no durable
//! substrate — the ConPTY dies with the daemon either way — so an agent that
//! survived would have nothing attached to it and nothing able to show it to
//! you. Outliving the only thing that could reach you is a leak, not
//! durability.
//!
//! ── THE RACE, STATED PLAINLY ───────────────────────────────────────────────
//!
//! Assignment happens after `CreateProcessW` returns, because that is the only
//! seam `portable-pty` exposes. A grandchild spawned in the window between the
//! two escapes the job. The window is microseconds and a shell does not spawn
//! that fast, but it is real, and the honest fix is upstream: `portable-pty`
//! should accept a job handle and assign it inside the `CREATE_SUSPENDED`
//! window it already has. Until then this closes the case that actually bites.
//!
//! Nested jobs (Windows 8 and later) make assignment safe even when the
//! process is already in somebody else's job, which is the normal state inside
//! a CI runner or a Windows container.

use anyhow::{Context, Result};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// A job object holding one session's process tree.
pub struct JobObject(HANDLE);

// The handle is owned, and every use is an FFI call that takes it by value.
unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl Drop for JobObject {
    fn drop(&mut self) {
        // Closing the last handle is what triggers KILL_ON_JOB_CLOSE, so this
        // is not merely hygiene: it is the teardown path for a session whose
        // owner went away without calling kill().
        // SAFETY: self.0 came from CreateJobObjectW and Drop runs exactly once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

impl JobObject {
    /// Create a job whose closure kills its members, and put `pid` in it.
    pub fn create_for(pid: u32) -> Result<Self> {
        // SAFETY: both arguments are documented as optional and null is the
        // documented way to omit them.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        anyhow::ensure!(!handle.is_null(), "Failed to create a job object");
        let job = Self(handle);

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is an owned, fully initialised struct of exactly the
        // size declared, and the class matches its type.
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        anyhow::ensure!(
            ok != 0,
            "Failed to set kill-on-close on the job object: {}",
            std::io::Error::last_os_error()
        );

        job.assign(pid)?;
        Ok(job)
    }

    fn assign(&self, pid: u32) -> Result<()> {
        // SAFETY: a plain FFI call; the handle is checked before use.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        anyhow::ensure!(
            !process.is_null(),
            "Failed to open the spawned process to place it in a job: {}",
            std::io::Error::last_os_error()
        );
        // SAFETY: both handles are live for the duration of the call.
        let ok = unsafe { AssignProcessToJobObject(self.0, process) };
        // The process handle has done its job whatever the outcome.
        // SAFETY: `process` is live and unclosed.
        unsafe {
            CloseHandle(process);
        }
        anyhow::ensure!(
            ok != 0,
            "Failed to place the spawned process in a job: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }

    /// End every process in this job.
    pub fn terminate(&self) -> Result<()> {
        // SAFETY: self.0 is live until Drop.
        let ok = unsafe { TerminateJobObject(self.0, 1) };
        if ok == 0 {
            return Err(anyhow::anyhow!(std::io::Error::last_os_error()))
                .context("Failed to terminate the owned PTY job object");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wait for `pid`'s newest descendant to appear, using the same witness the
    /// agent well uses.
    fn grandchild_of(pid: u32) -> Option<crate::foreground::ProcessIdentity> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if let Some(found) = crate::foreground::foreground_identity(pid) {
                if found.pid != pid {
                    return Some(found);
                }
            }
            if std::time::Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    fn gone(identity: crate::foreground::ProcessIdentity) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if crate::foreground::identify(identity.pid) != Some(identity) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    /// The whole point, as one test: a grandchild must not survive the pane.
    ///
    /// This is precisely what was broken before job objects — the shell died
    /// and whatever it had started kept running, unreachable. Asserting on the
    /// direct child alone would not have caught that, so the assertion is on
    /// the grandchild.
    #[test]
    fn terminating_a_job_kills_a_grandchild_not_just_the_child() {
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "ping -n 60 127.0.0.1 > NUL"])
            .spawn()
            .expect("cmd.exe is present on every Windows runner");
        let child_pid = child.id();
        let job = JobObject::create_for(child_pid).expect("a job for our own child");

        let grandchild = grandchild_of(child_pid).expect("cmd.exe started ping as a grandchild");

        job.terminate().expect("terminate the tree");
        child.wait().ok();

        assert!(
            gone(grandchild),
            "the grandchild outlived the job it belonged to"
        );
    }

    /// Closing the last handle is the teardown path for a daemon that went away
    /// without calling kill(). KILL_ON_JOB_CLOSE is what makes that leave
    /// nothing behind, so it is worth pinning separately from terminate().
    #[test]
    fn dropping_the_last_job_handle_ends_the_tree() {
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "ping -n 60 127.0.0.1 > NUL"])
            .spawn()
            .expect("cmd.exe");
        let child_pid = child.id();
        let job = JobObject::create_for(child_pid).expect("a job");
        let grandchild = grandchild_of(child_pid).expect("ping started");

        drop(job);
        child.wait().ok();

        assert!(
            gone(grandchild),
            "closing the last handle must end the members"
        );
    }

    #[test]
    fn a_pid_that_is_gone_cannot_be_placed_in_a_job() {
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "exit 0"])
            .spawn()
            .expect("cmd.exe");
        let pid = child.id();
        child.wait().expect("reaped");
        // Not an assertion about pid reuse: OpenProcess on a reaped pid fails,
        // and a job we cannot populate must report that rather than pretend.
        assert!(JobObject::create_for(pid).is_err());
    }
}
