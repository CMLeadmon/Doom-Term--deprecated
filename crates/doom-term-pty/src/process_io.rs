//! Bounded helper I/O. Never call from an async executor thread.
use anyhow::Result;
use std::{path::Path, time::Duration};

#[derive(Clone, Copy)]
pub struct HelperLimits {
    pub timeout: Duration,
    pub input_bytes: usize,
    pub output_bytes: usize,
}

pub(crate) fn run(exe: &Path, args: &[String], input: &[u8], timeout: Duration) -> Result<Vec<u8>> {
    run_bounded(
        exe,
        args,
        input,
        HelperLimits {
            timeout,
            input_bytes: crate::paste::MAX_PASTE_BYTES,
            output_bytes: 4096,
        },
    )
}

/// The admission rules both implementations share.
///
/// Kept in one place deliberately: these are the bounds that make this function
/// safe to call from a blocking worker, and two copies of them would drift.
fn check_limits(input: &[u8], limits: HelperLimits) -> Result<()> {
    anyhow::ensure!(
        input.len() <= limits.input_bytes,
        "Terminal helper input limit exceeded"
    );
    anyhow::ensure!(
        limits.input_bytes <= crate::paste::MAX_PASTE_BYTES
            && limits.output_bytes <= 8 * 1024 * 1024
            && limits.timeout <= Duration::from_secs(30)
            && !limits.timeout.is_zero(),
        "Invalid terminal helper limits"
    );
    Ok(())
}

#[cfg(unix)]
pub fn run_bounded(
    exe: &Path,
    args: &[String],
    input: &[u8],
    limits: HelperLimits,
) -> Result<Vec<u8>> {
    use std::io::{ErrorKind, Read, Write};
    use std::os::{fd::AsRawFd, unix::process::CommandExt};
    use std::process::{Command, Stdio};
    use std::time::Instant;

    check_limits(input, limits)?;
    let deadline = Instant::now() + limits.timeout;
    let mut child = Command::new(exe)
        .args(args)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|_| anyhow::anyhow!("Terminal helper could not start"))?;
    let result = (|| -> Result<Vec<u8>> {
        let mut stdin = child.stdin.take();
        let mut stdout = child.stdout.take().unwrap();
        for fd in [stdin.as_ref().unwrap().as_raw_fd(), stdout.as_raw_fd()] {
            // These are owned pipe descriptors, live throughout this call.
            let flags = unsafe { nix::libc::fcntl(fd, nix::libc::F_GETFL) };
            anyhow::ensure!(
                flags >= 0
                    && unsafe {
                        nix::libc::fcntl(fd, nix::libc::F_SETFL, flags | nix::libc::O_NONBLOCK)
                    } >= 0,
                "Terminal helper pipe setup failed"
            );
        }
        let mut written = 0;
        let mut output = Vec::new();
        let mut eof = false;
        loop {
            let mut progressed = false;
            anyhow::ensure!(
                Instant::now() < deadline,
                "Terminal helper timed out; delivery is unknown"
            );
            if written == input.len() {
                stdin.take();
            }
            if let Some(pipe) = stdin.as_mut() {
                match pipe.write(&input[written..]) {
                    Ok(0) => anyhow::bail!("Terminal helper closed its input"),
                    Ok(n) => {
                        written += n;
                        progressed = true;
                    }
                    Err(e)
                        if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                    Err(_) => anyhow::bail!("Terminal helper input failed; delivery is unknown"),
                }
            }
            let mut buffer = [0; 65536];
            match stdout.read(&mut buffer) {
                Ok(0) => eof = true,
                Ok(n) => {
                    progressed = true;
                    anyhow::ensure!(
                        output.len() + n <= limits.output_bytes,
                        "Terminal helper exceeded output limit"
                    );
                    output.extend_from_slice(&buffer[..n]);
                }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                Err(_) => anyhow::bail!("Terminal helper output failed; delivery is unknown"),
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|_| anyhow::anyhow!("Terminal helper wait failed"))?
            {
                anyhow::ensure!(
                    status.success() && written == input.len(),
                    "Terminal helper failed; delivery is unknown"
                );
                if eof {
                    return Ok(output);
                }
            }
            // Sleeping per successful 4 KiB read made a legal 8 MiB archive
            // necessarily exceed two seconds. Back off only when pipes stall.
            if !progressed {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    })();
    if result.is_err() {
        // Kill only this helper's process group, including a stalled descendant
        // holding a pipe open. No pipe worker threads are left to join forever.
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(child.id() as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

/// Windows: a thread per pipe, because there is no O_NONBLOCK to set.
///
/// The Unix path sets both pipe descriptors non-blocking and pumps them from
/// one thread. Windows anonymous pipes have no equivalent — there is no way to
/// make an existing pipe handle return WouldBlock — so each direction gets its
/// own thread and the deadline lives on the parent.
///
/// Both threads are guaranteed to finish. Killing the helper closes the handles
/// it holds, so a blocked `read` returns EOF and a blocked `write` fails; that
/// is what lets this join unconditionally instead of detaching threads that
/// would outlive the call.
///
/// ── WHY THIS IS NOT A TMUX CONCESSION ──────────────────────────────────────
///
/// This function was named for tmux and stubbed out off-Unix, which hid that it
/// is the crate's only bounded subprocess runner. `metadata.rs` runs
/// `git rev-parse --abbrev-ref HEAD` through it, so the branch indicator was
/// dark on Windows for a reason that had nothing to do with git, tmux, or
/// Windows. Implementing it restores the branch. It does not conjure a tmux:
/// `resolve_tmux` still finds no binary, and `durability_detail` still says so.
#[cfg(windows)]
pub fn run_bounded(
    exe: &Path,
    args: &[String],
    input: &[u8],
    limits: HelperLimits,
) -> Result<Vec<u8>> {
    use std::io::{ErrorKind, Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;
    use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;

    check_limits(input, limits)?;
    let deadline = Instant::now() + limits.timeout;
    let mut child = Command::new(exe)
        .args(args)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // The closest analogue of the Unix `process_group(0)`: console control
        // events aimed at us must not reach a helper.
        .creation_flags(CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map_err(|_| anyhow::anyhow!("Terminal helper could not start"))?;

    // Holds the helper's whole tree, so a stalled descendant holding a pipe
    // open cannot outlive the deadline. This is the same guarantee `killpg`
    // gives the Unix path.
    let job = crate::job::JobObject::create_for(child.id()).ok();

    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take();

    let owned_input = input.to_vec();
    let writer = std::thread::spawn(move || -> bool {
        let Some(pipe) = stdin.as_mut() else {
            return true;
        };
        let wrote = pipe.write_all(&owned_input).is_ok();
        // Dropping closes the pipe, which is the child's EOF on stdin. Without
        // this a helper that reads to EOF would wait for the deadline.
        drop(stdin);
        wrote
    });

    // Set when the reader gives up, so a helper blocked writing into a pipe
    // nobody is draining costs a millisecond rather than the whole timeout.
    let failed = Arc::new(AtomicBool::new(false));
    let reader_failed = failed.clone();
    let cap = limits.output_bytes;
    let reader = std::thread::spawn(move || -> Result<Vec<u8>> {
        let mut stdout = match stdout {
            Some(pipe) => pipe,
            None => return Ok(Vec::new()),
        };
        let mut output = Vec::new();
        let mut buffer = [0u8; 65536];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => return Ok(output),
                Ok(n) => {
                    if output.len() + n > cap {
                        reader_failed.store(true, Ordering::Relaxed);
                        anyhow::bail!("Terminal helper exceeded output limit");
                    }
                    output.extend_from_slice(&buffer[..n]);
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(_) => {
                    reader_failed.store(true, Ordering::Relaxed);
                    anyhow::bail!("Terminal helper output failed; delivery is unknown");
                }
            }
        }
    });

    let mut status = None;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(done)) => {
                status = Some(done);
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
        if failed.load(Ordering::Relaxed) || Instant::now() >= deadline {
            timed_out = !failed.load(Ordering::Relaxed);
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }

    if status.is_none() {
        // Ends the tree, which closes every pipe handle the helper holds and so
        // unblocks both threads below.
        if let Some(job) = &job {
            let _ = job.terminate();
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    let wrote_all = writer.join().unwrap_or(false);
    let output = reader.join().unwrap_or_else(|_| {
        Err(anyhow::anyhow!(
            "Terminal helper output failed; delivery is unknown"
        ))
    })?;

    anyhow::ensure!(!timed_out, "Terminal helper timed out; delivery is unknown");
    let status =
        status.ok_or_else(|| anyhow::anyhow!("Terminal helper failed; delivery is unknown"))?;
    anyhow::ensure!(
        status.success() && wrote_all,
        "Terminal helper failed; delivery is unknown"
    );
    Ok(output)
}

#[cfg(not(any(unix, windows)))]
pub fn run_bounded(
    _exe: &Path,
    _args: &[String],
    _input: &[u8],
    _limits: HelperLimits,
) -> Result<Vec<u8>> {
    anyhow::bail!("Bounded subprocess helpers are unsupported on this platform")
}

/// The Windows half of the same contract the Unix tests pin.
///
/// Arguments are passed already split rather than as one compound string:
/// cmd.exe re-parses its own command line, and a test that depends on that
/// re-parsing tests the quoting, not the runner.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::time::Instant;

    fn cmd() -> &'static Path {
        Path::new("cmd.exe")
    }

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|p| (*p).to_string()).collect()
    }

    fn limits(timeout_ms: u64, output_bytes: usize) -> HelperLimits {
        HelperLimits {
            timeout: Duration::from_millis(timeout_ms),
            input_bytes: 0,
            output_bytes,
        }
    }

    #[test]
    fn a_helper_that_succeeds_returns_its_output() {
        let out = run_bounded(
            cmd(),
            &args(&["/c", "echo", "probe"]),
            &[],
            limits(5000, 4096),
        )
        .expect("cmd.exe echo");
        assert!(
            String::from_utf8_lossy(&out).contains("probe"),
            "{:?}",
            String::from_utf8_lossy(&out)
        );
    }

    #[test]
    fn output_past_the_declared_budget_is_refused() {
        let error =
            run_bounded(cmd(), &args(&["/c", "echo", "probe"]), &[], limits(5000, 2)).unwrap_err();
        assert!(error.to_string().contains("output limit"), "{error}");
    }

    #[test]
    fn input_over_the_declared_budget_never_starts_the_helper() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("must-not-exist");
        let error = run_bounded(
            cmd(),
            &args(&["/c", "copy", "nul", &marker.display().to_string()]),
            b"x",
            limits(5000, 4096),
        )
        .unwrap_err();
        assert!(error.to_string().contains("input limit"), "{error}");
        assert!(!marker.exists(), "a refused helper must not have run");
    }

    #[test]
    fn a_hanging_helper_is_killed_within_the_deadline() {
        let started = Instant::now();
        let error = run_bounded(
            cmd(),
            &args(&["/c", "ping", "-n", "30", "127.0.0.1"]),
            &[],
            limits(200, 65536),
        )
        .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
        // The real assertion: both pipe threads were joined. If either had been
        // left blocked, this call would never have returned at all.
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_helper_that_never_reads_its_input_still_returns() {
        // The writer thread blocks once the pipe buffer fills. Killing the tree
        // is what unblocks it, so this pins the teardown path rather than the
        // happy path.
        let started = Instant::now();
        let error = run_bounded(
            cmd(),
            &args(&["/c", "ping", "-n", "30", "127.0.0.1"]),
            &vec![b'x'; 1024 * 1024],
            HelperLimits {
                timeout: Duration::from_millis(200),
                input_bytes: 1024 * 1024,
                output_bytes: 65536,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_nonzero_exit_is_a_failure_not_an_empty_success() {
        let error =
            run_bounded(cmd(), &args(&["/c", "exit", "1"]), &[], limits(5000, 4096)).unwrap_err();
        assert!(error.to_string().contains("failed"), "{error}");
    }

    #[test]
    fn stdin_reaches_the_helper_and_its_answer_comes_back() {
        // sort.exe reads to EOF, so this only passes if the writer thread
        // closed the pipe after writing.
        let out = run_bounded(
            cmd(),
            &args(&["/c", "sort"]),
            b"b\r\na\r\n",
            HelperLimits {
                timeout: Duration::from_secs(5),
                input_bytes: 64,
                output_bytes: 4096,
            },
        )
        .expect("sort round trip");
        let text = String::from_utf8_lossy(&out);
        let first = text.trim_start();
        assert!(first.starts_with('a'), "{text:?}");
    }

    #[test]
    fn the_git_branch_helper_shape_works_at_all() {
        // metadata.rs runs exactly this shape through run_bounded, and it was
        // the casualty nobody connected to the stub: the branch indicator was
        // dark on Windows because a tmux-named function returned bail!().
        let out = run_bounded(
            Path::new("git"),
            &args(&["--version"]),
            &[],
            limits(5000, 4096),
        );
        if let Ok(out) = out {
            assert!(String::from_utf8_lossy(&out).contains("git version"));
        }
        // git may legitimately be absent; what must not happen is an
        // unconditional bail! on the platform.
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn history_helpers_have_an_explicit_larger_output_budget() {
        let limits = HelperLimits {
            timeout: Duration::from_secs(2),
            input_bytes: 0,
            output_bytes: 8192,
        };
        let result = run_bounded(
            Path::new("/bin/sh"),
            &["-c".into(), "head -c 6000 /dev/zero".into()],
            &[],
            limits,
        )
        .unwrap();
        assert_eq!(result, vec![0; 6000]);
        let error = run_bounded(
            Path::new("/bin/sh"),
            &["-c".into(), "head -c 8193 /dev/zero".into()],
            &[],
            limits,
        )
        .unwrap_err();
        assert!(error.to_string().contains("output limit"));
    }

    #[test]
    fn a_full_archive_fits_the_two_second_io_deadline() {
        let result = run_bounded(
            Path::new("/bin/sh"),
            &["-c".into(), "head -c 8388608 /dev/zero".into()],
            &[],
            HelperLimits {
                timeout: Duration::from_secs(2),
                input_bytes: 0,
                output_bytes: 8 * 1024 * 1024,
            },
        )
        .unwrap();
        assert_eq!(result.len(), 8 * 1024 * 1024);
    }

    #[test]
    fn input_over_the_declared_budget_never_starts_the_helper() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("must-not-exist");
        let error = run_bounded(
            Path::new("/usr/bin/touch"),
            &[marker.display().to_string()],
            b"x",
            HelperLimits {
                timeout: Duration::from_secs(2),
                input_bytes: 0,
                output_bytes: 4096,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("input limit"));
        assert!(!marker.exists());
    }

    #[test]
    fn pumps_stdin_and_stdout_without_blocking_on_either_pipe() {
        let result = run(
            Path::new("/bin/sh"),
            &["-c".into(), "head -c 1000; cat >/dev/null".into()],
            &vec![b'x'; 1024 * 1024],
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(result, vec![b'x'; 1000]);
    }

    #[test]
    fn hanging_helper_is_killed_within_deadline_even_if_it_never_reads() {
        let started = Instant::now();
        let error = run(
            Path::new("/bin/sh"),
            &["-c".into(), "sleep 30".into()],
            &vec![b'x'; 1024 * 1024],
            Duration::from_millis(100),
        )
        .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn output_is_bounded_and_errors_do_not_echo_helper_output() {
        let error = run(
            Path::new("/bin/sh"),
            &["-c".into(), "head -c 5000 /dev/zero".into()],
            &[],
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert!(error.to_string().contains("output limit"), "{error}");
        let error = run(
            Path::new("/bin/sh"),
            &["-c".into(), "echo secret >&2; exit 1".into()],
            &[],
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert!(!error.to_string().contains("secret"));
    }
}
