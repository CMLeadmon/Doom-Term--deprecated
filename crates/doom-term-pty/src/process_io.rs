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

#[cfg(not(unix))]
pub fn run_bounded(
    _exe: &Path,
    _args: &[String],
    _input: &[u8],
    _limits: HelperLimits,
) -> Result<Vec<u8>> {
    anyhow::bail!("Bounded tmux helpers are unsupported on this platform")
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
