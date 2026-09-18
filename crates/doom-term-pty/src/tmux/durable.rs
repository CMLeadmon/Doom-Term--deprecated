//! Exact pane identity and attach-only operations. No process fallback here.
use super::*;
use crate::process_io::{run_bounded, HelperLimits};
use crate::stream::Identity;
use anyhow::{Context, Result};
use serde::Serialize;
use std::time::{Duration, Instant};

const INCARNATION: &str = "@doom-incarnation";
const ROOT_PID: &str = "@doom-root-pid";

fn helper_timeout(deadline: Instant) -> Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    anyhow::ensure!(!remaining.is_zero(), "Durable bootstrap timed out");
    Ok(remaining.min(Duration::from_secs(2)))
}

#[derive(Debug, Clone)]
pub(super) struct DurableTarget {
    pub pane: String,
    pub incarnation: Identity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachError {
    Missing,
    Replaced,
    Unidentified,
    Failed,
}
impl std::fmt::Display for AttachError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Durable attachment {:?}", self)
    }
}
impl std::error::Error for AttachError {}

#[derive(Debug, Serialize)]
pub struct CapturedArchive {
    pub capture_id: Identity,
    pub incarnation: Identity,
    pub cols: u16,
    pub rows: u16,
    pub lines: usize,
    pub history_at_limit: bool,
    pub potentially_overlapping: bool,
    pub potentially_incomplete: bool,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredPane {
    pub id: String,
    pub pane: String,
    pub root_pid: u32,
    pub incarnation: Option<Identity>,
    pub identity_status: &'static str,
    pub cols: u16,
    pub rows: u16,
}

/// Identity-only enumeration uses fields with bounded, unambiguous syntax.
/// Paths/command strings are obtained separately for a verified attachment;
/// tabs/newlines in a working directory cannot inject a discovery record.
pub fn discover_owned(exe: &Path) -> Result<Vec<DiscoveredPane>> {
    let handle = TmuxHandle::named(exe.to_path_buf(), String::new());
    let output = run_bounded(exe, &handle.on_socket(&[
        "list-panes", "-a", "-F",
        "#{session_name}\t#{pane_id}\t#{pane_pid}\t#{@doom-incarnation}\t#{@doom-root-pid}\t#{pane_dead}\t#{pane_width}\t#{pane_height}",
    ]), &[], HelperLimits { timeout: Duration::from_secs(2), input_bytes: 0, output_bytes: 8 * 1024 * 1024 })?;
    parse_discovery(std::str::from_utf8(&output)?)
}

fn parse_discovery(text: &str) -> Result<Vec<DiscoveredPane>> {
    let mut panes = Vec::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        let Some(id) = fields[0].strip_prefix("doom-").filter(|id| valid_id(id)) else {
            continue;
        };
        anyhow::ensure!(
            fields.len() == 8 && valid_pane(fields[1]),
            "Invalid durable discovery record"
        );
        let root_pid: u32 = fields[2].parse()?;
        anyhow::ensure!(root_pid > 0, "Invalid durable root pid");
        if fields[5] == "1" {
            continue;
        }
        anyhow::ensure!(fields[5] == "0", "Unknown durable lifecycle state");
        let (cols, rows): (u16, u16) = (fields[6].parse()?, fields[7].parse()?);
        anyhow::ensure!(cols > 0 && rows > 0, "Invalid durable dimensions");
        let observed = Identity::try_from(fields[3].to_string()).ok();
        let (incarnation, identity_status) = if observed.is_some() && fields[2] == fields[4] {
            (observed, "owned")
        } else if fields[3].is_empty() && fields[4].is_empty() {
            (None, "unidentified")
        } else {
            (None, "replaced")
        };
        panes.push(DiscoveredPane {
            id: id.into(),
            pane: fields[1].into(),
            root_pid,
            incarnation,
            identity_status,
            cols,
            rows,
        });
    }
    Ok(panes)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn valid_pane(pane: &str) -> bool {
    pane.starts_with('%') && pane.len() > 1 && pane[1..].bytes().all(|b| b.is_ascii_digit())
}

impl TmuxHandle {
    /// Explicit user recovery of an unlabelled pane from a discovery result.
    /// Never called by automatic attach; the observed numeric pane and root
    /// pid must still match, and an existing identity is never overwritten.
    pub fn recover_legacy(exe: PathBuf, id: &str, pane: &str, root_pid: u32) -> Result<Self> {
        anyhow::ensure!(
            valid_id(id) && valid_pane(pane) && root_pid > 0,
            "Invalid legacy recovery target"
        );
        let handle = Self::named(exe, session_name(id));
        let incarnation = Identity::random()?;
        let condition = format!("#{{&&:#{{==:#{{session_name}},{}}},#{{&&:#{{==:#{{pane_pid}},{root_pid}}},#{{&&:#{{==:#{{pane_dead}},0}},#{{&&:#{{==:#{{{INCARNATION}}},}},#{{==:#{{{ROOT_PID}}},}}}}}}}}}}", handle.name);
        let yes = format!("set-option -p -t {pane} {INCARNATION} {} ; set-option -p -t {pane} {ROOT_PID} {root_pid} ; display-message -p DOOM_IDENTIFIED", incarnation.as_str());
        let result = handle.run_query(&handle.on_socket(&[
            "if-shell",
            "-F",
            "-t",
            pane,
            &condition,
            &yes,
            "display-message -p DOOM_NOT_ADOPTED",
        ]))?;
        anyhow::ensure!(
            result == b"DOOM_IDENTIFIED\n",
            "Legacy pane changed or is already identified; recovery refused"
        );
        Self::resolve_owned(handle.exe, id, &incarnation).map_err(Into::into)
    }

    /// Create one detached root pane and stamp its identity in the same queue.
    /// A duplicate new-session fails the queue before any metadata can change.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create_owned(
        exe: PathBuf,
        id: &str,
        cols: u16,
        rows: u16,
        cwd: &Path,
        env: &[(String, String)],
        shell: &str,
        shell_args: &[String],
        deadline: Instant,
    ) -> Result<Self> {
        anyhow::ensure!(valid_id(id), "Invalid durable session id");
        anyhow::ensure!(cols > 0 && rows > 0, "Terminal dimensions must be positive");
        let incarnation = Identity::random()?;
        let conf = write_config().context("Cannot write private tmux configuration")?;
        let name = session_name(id);
        let mut env = env.to_vec();
        env.push((
            crate::session::SESSION_INCARNATION_ENV.into(),
            incarnation.as_str().into(),
        ));
        let mut args = create_session_args(&conf, &name, cols, rows, cwd, &env, shell, shell_args);
        args.extend([
            ";".into(),
            "set-option".into(),
            "-p".into(),
            "-t".into(),
            format!("={name}:"),
            INCARNATION.into(),
            incarnation.as_str().into(),
        ]);
        args.extend([
            ";".into(),
            "set-option".into(),
            "-pF".into(),
            "-t".into(),
            format!("={name}:"),
            ROOT_PID.into(),
            "#{pane_pid}".into(),
        ]);
        let handle = Self::named(exe, name);
        run_bounded(
            &handle.exe,
            &args,
            &[],
            HelperLimits {
                timeout: helper_timeout(deadline)?,
                input_bytes: 0,
                output_bytes: 4096,
            },
        )
        .context("Create failed; process creation may have completed, discover before retrying")?;
        Self::resolve_owned_before(handle.exe, id, &incarnation, deadline).map_err(Into::into)
    }

    pub fn resolve_owned(
        exe: PathBuf,
        id: &str,
        expected: &Identity,
    ) -> std::result::Result<Self, AttachError> {
        Self::resolve_owned_before(exe, id, expected, Instant::now() + Duration::from_secs(2))
    }

    pub(crate) fn resolve_owned_before(
        exe: PathBuf,
        id: &str,
        expected: &Identity,
        deadline: Instant,
    ) -> std::result::Result<Self, AttachError> {
        if !valid_id(id) {
            return Err(AttachError::Failed);
        }
        let mut handle = Self::named(exe, session_name(id));
        // Enumerate successfully before declaring a name absent. Helper failure
        // (including an unreachable server) is not evidence of process absence.
        // Inspect every pane: a changed active pane must not change root identity.
        let output = run_bounded(
            &handle.exe,
            &handle.on_socket(&[
                "list-panes",
                "-a",
                "-F",
                "#{session_name}\t#{pane_id}\t#{@doom-incarnation}\t#{pane_pid}\t#{@doom-root-pid}",
            ]),
            &[],
            HelperLimits {
                timeout: helper_timeout(deadline).map_err(|_| AttachError::Failed)?,
                input_bytes: 0,
                output_bytes: 8 * 1024 * 1024,
            },
        )
        .map_err(|_| AttachError::Failed)?;
        let output = std::str::from_utf8(&output).map_err(|_| AttachError::Failed)?;
        let mut failure = AttachError::Missing;
        for line in output.lines() {
            let fields: Vec<_> = line.split('\t').collect();
            if fields.first() != Some(&handle.name.as_str()) {
                continue;
            }
            if fields.len() != 5 || !valid_pane(fields[1]) {
                return Err(AttachError::Failed);
            }
            let Ok(incarnation) = Identity::try_from(fields[2].to_string()) else {
                if failure == AttachError::Missing {
                    failure = AttachError::Unidentified;
                }
                continue;
            };
            failure = AttachError::Replaced;
            if &incarnation != expected
                || fields[3] != fields[4]
                || fields[3]
                    .parse::<u32>()
                    .ok()
                    .filter(|pid| *pid > 0)
                    .is_none()
            {
                continue;
            }
            if handle.target.is_some() {
                return Err(AttachError::Failed);
            }
            handle.target = Some(DurableTarget {
                pane: fields[1].into(),
                incarnation,
            });
        }
        if handle.target.is_none() {
            return Err(failure);
        }
        Ok(handle)
    }

    pub fn incarnation(&self) -> Option<&Identity> {
        self.target.as_ref().map(|target| &target.incarnation)
    }

    /// Ordinary input is bytes, not clipboard text: no sanitation, newline
    /// conversion or bracketed-paste framing. Hex literals cannot become tmux
    /// commands, and the exact root is checked in the same execution queue.
    pub(crate) fn write_checked(
        &self,
        bytes: &[u8],
        mut authorize: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        use std::fmt::Write;
        let target = self.target.as_ref().context("Unidentified input target")?;
        for chunk in bytes.chunks(8192) {
            // Per chunk, not per write.
            //
            // One two-second budget was shared by every chunk, so a large
            // write against a slow tmux spent it on the first chunk and then
            // `helper_timeout` failed the rest instantly — the deadline had
            // already passed. What the user saw was a terminal that stopped
            // accepting input. Each chunk now gets its own budget; a write is
            // still bounded, just not by how much came before it.
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut command = format!("send-keys -H -t {}", target.pane);
            for byte in chunk {
                write!(&mut command, " {byte:02x}").unwrap();
            }
            command.push_str(" ; display-message -p DOOM_INPUT_OK");
            authorize()?;
            let reply = run_bounded(
                &self.exe,
                &self.on_socket(&[
                    "if-shell",
                    "-F",
                    "-t",
                    &target.pane,
                    &self.identity_condition().unwrap(),
                    &command,
                    "display-message -p DOOM_REPLACED",
                ]),
                &[],
                HelperLimits {
                    timeout: helper_timeout(deadline)?,
                    input_bytes: 0,
                    output_bytes: 128,
                },
            )?;
            // Never retried: a resent chunk is a duplicated keystroke, and
            // unknown delivery must be reported as unknown rather than fixed
            // by guessing. What changes here is only that the two outcomes are
            // told apart instead of both being reported as a replacement.
            anyhow::ensure!(
                reply != b"DOOM_REPLACED\n",
                "Input target was replaced; the keystrokes were not delivered"
            );
            anyhow::ensure!(
                reply == b"DOOM_INPUT_OK\n",
                "tmux did not confirm the write; delivery is unknown"
            );
        }
        Ok(())
    }

    pub(super) fn identity_condition(&self) -> Option<String> {
        let target = self.target.as_ref()?;
        Some(format!("#{{&&:#{{==:#{{{ROOT_PID}}},#{{pane_pid}}}},#{{&&:#{{==:#{{{INCARNATION}}},{}}},#{{==:#{{session_name}},{}}}}}}}",
            target.incarnation.as_str(), self.name))
    }

    pub fn attach_args(&self) -> Result<Vec<String>> {
        let target = self
            .target
            .as_ref()
            .context("Unidentified pane cannot be attached")?;
        // No -d (which would steal another client), no cwd/shell, no startup.
        // Numeric target and identity are checked by tmux at execution time.
        Ok(self.on_socket(&[
            "if-shell",
            "-F",
            "-t",
            &target.pane,
            &self.identity_condition().unwrap(),
            &format!(
                "set-option -w -t {} window-size manual ; attach-session -E -t {}",
                target.pane, target.pane
            ),
            "display-message -p DOOM_REPLACED",
        ]))
    }

    pub(crate) fn resize_owned(&self, cols: u16, rows: u16) -> Result<()> {
        let target = self.target.as_ref().context("Unidentified resize target")?;
        // resize-window pins this window to manual sizing. A later SIGWINCH
        // from our display PTY must not independently resize a respawned root.
        let reply = self.run_query(&self.on_socket(&[
            "if-shell",
            "-F",
            "-t",
            &target.pane,
            &self.identity_condition().unwrap(),
            &format!(
                "resize-window -t {} -x {cols} -y {rows} ; display-message -p DOOM_RESIZED",
                target.pane
            ),
            "display-message -p DOOM_REPLACED",
        ]))?;
        anyhow::ensure!(
            reply == b"DOOM_RESIZED\n",
            "Resize target was replaced; resize refused"
        );
        Ok(())
    }

    pub(crate) fn has_display_client(&self, pid: u32, deadline: Instant) -> Result<bool> {
        let Some(target) = &self.target else {
            return Ok(false);
        };
        let format = format!(
            "#{{client_pid}}\t#{{pane_id}}\t#{{?{},1,0}}",
            self.identity_condition().unwrap()
        );
        let output = run_bounded(
            &self.exe,
            &self.on_socket(&["list-clients", "-F", &format]),
            &[],
            HelperLimits {
                timeout: helper_timeout(deadline)?,
                input_bytes: 0,
                output_bytes: 4096,
            },
        )?;
        let expected = format!("{pid}\t{}\t1", target.pane);
        Ok(String::from_utf8_lossy(&output)
            .lines()
            .any(|line| line == expected))
    }

    /// Capture is an archive, never an Event or live parser input. Missing
    /// history is an error, not an empty successful archive. At-limit history
    /// may have older omissions; capture/repaint may overlap and are not atomic.
    pub fn capture_archive(&self) -> Result<CapturedArchive> {
        self.capture_archive_before(Instant::now() + Duration::from_secs(2))
    }
    pub(crate) fn geometry_before(&self, deadline: Instant) -> Result<(u16, u16)> {
        anyhow::ensure!(self.target.is_some(), "Unidentified geometry target");
        let output = run_bounded(
            &self.exe,
            &self.query_args("#{pane_width} #{pane_height}"),
            &[],
            HelperLimits {
                timeout: helper_timeout(deadline)?,
                input_bytes: 0,
                output_bytes: 128,
            },
        )?;
        let text = std::str::from_utf8(&output)?.trim();
        let (cols, rows) = text
            .split_once(' ')
            .context("Durable geometry unavailable")?;
        let (cols, rows): (u16, u16) = (cols.parse()?, rows.parse()?);
        anyhow::ensure!(
            cols > 0 && rows > 0 && u32::from(cols) * u32::from(rows) <= 1_048_576,
            "Durable geometry exceeds the live-screen allocation limit"
        );
        Ok((cols, rows))
    }
    pub(crate) fn capture_archive_before(&self, deadline: Instant) -> Result<CapturedArchive> {
        let target = self
            .target
            .as_ref()
            .context("Unidentified history target")?;
        // Query and capture in one synchronous queue; no output is interpreted
        // as an archive unless the identity/dimension header is present.
        let yes = format!("display-message -p -t {} '#{{pane_width}} #{{pane_height}} #{{history_size}}' ; capture-pane -p -e -t {} -S -5000 -E -1", target.pane, target.pane);
        let output = run_bounded(
            &self.exe,
            &self.on_socket(&[
                "if-shell",
                "-F",
                "-t",
                &target.pane,
                &self.identity_condition().unwrap(),
                &yes,
                "display-message -p DOOM_REPLACED",
            ]),
            &[],
            HelperLimits {
                timeout: helper_timeout(deadline)?,
                input_bytes: 0,
                output_bytes: 8 * 1024 * 1024,
            },
        )?;
        let text = String::from_utf8(output).context("Archive is not UTF-8")?;
        let (header, data) = text.split_once('\n').context("Missing archive header")?;
        let sizes: Vec<usize> = header
            .split(' ')
            .map(str::parse)
            .collect::<std::result::Result<_, _>>()
            .context("Archive target changed or dimensions unavailable")?;
        anyhow::ensure!(
            sizes.len() == 3
                && sizes[0] > 0
                && sizes[1] > 0
                && sizes[0] <= u16::MAX as usize
                && sizes[1] <= u16::MAX as usize,
            "Invalid archive dimensions"
        );
        // tmux interprets negative capture bounds as the visible screen when
        // history is empty. Do not turn its repaint into fake historical rows.
        let data = if sizes[2] == 0 {
            String::new()
        } else {
            data.to_string()
        };
        let lines = data.lines().count();
        anyhow::ensure!(lines <= 5000, "Archive line limit exceeded");
        Ok(CapturedArchive {
            capture_id: Identity::random()?,
            incarnation: target.incarnation.clone(),
            cols: sizes[0] as u16,
            rows: sizes[1] as u16,
            lines,
            history_at_limit: sizes[2] >= 5000,
            potentially_overlapping: true,
            potentially_incomplete: true,
            data,
        })
    }
}
