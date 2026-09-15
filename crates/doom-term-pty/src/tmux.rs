//! tmux as the session substrate.
//!
//! The PTY we open hosts a tmux *client*, not the user's shell. The shell lives
//! under the tmux server, which is nobody's child of ours, so restarting or
//! crashing the daemon detaches the client and leaves the work running. That is
//! the whole point: an agent mid-task used to die with the daemon.
//!
//! Everything that builds a string or an argv here is pure, because the
//! interesting failures are in the arguments, not in the spawning.

use std::path::{Path, PathBuf};

mod durable;
pub use durable::{discover_owned, AttachError, CapturedArchive, DiscoveredPane};

/// Child-checked paste needs `bracket_paste_flag`, introduced in tmux 3.7.
/// Older servers silently expand the unknown format to an empty string, so
/// accepting them would advertise an adapter that cannot authorize multiline
/// paste even when the child has enabled it. Passthrough also requires >=3.3.
pub const MIN_MAJOR: u32 = 3;
pub const MIN_MINOR: u32 = 7;

/// How often to ask tmux whether the pane went full-screen. A render decision
/// that used to be per-frame becomes per-tick, so the switch can be this late.
/// Recognised agents do not depend on it — they are identified by process — so
/// this only paces vim, htop and their kind.
pub const ALT_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// Major and minor from `tmux -V`, which reports as `tmux 3.7b`, `tmux 3.2a`
/// or `tmux next-3.4`. The suffix letter is a point release and is ignored.
///
/// Returns None when no `<major>.<minor>` is present at all — `tmux master`
/// being the real case. We refuse those rather than assume they are new: the
/// cost of guessing high is invisible breakage, and the cost of guessing low is
/// the direct spawn we already ship.
pub fn parse_version(version_output: &str) -> Option<(u32, u32)> {
    let bytes = version_output.as_bytes();
    let dot = version_output.find('.')?;

    let start = bytes[..dot]
        .iter()
        .rposition(|b| !b.is_ascii_digit())
        .map(|i| i + 1)
        .unwrap_or(0);
    if start == dot {
        return None;
    }
    let major: u32 = version_output[start..dot].parse().ok()?;

    let after = &version_output[dot + 1..];
    let end = after
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(after.len());
    if end == 0 {
        return None;
    }
    let minor: u32 = after[..end].parse().ok()?;

    Some((major, minor))
}

pub fn version_supported(version_output: &str) -> bool {
    match parse_version(version_output) {
        Some((major, minor)) => (major, minor) >= (MIN_MAJOR, MIN_MINOR),
        None => false,
    }
}

/// The tmux session backing a Doom Term pane.
///
/// Namespaced deliberately so Doom-owned sessions cannot collide with a
/// session the user made by hand on another socket.
pub fn session_name(session_id: &str) -> String {
    format!("doom-{}", session_id)
}

/// Directories to search after PATH.
///
/// A GUI application does not inherit the shell's environment: on macOS an app
/// launched from Finder gets a minimal PATH with no Homebrew prefix in it, so a
/// `brew install tmux` is invisible and sessions would silently fall back to
/// non-durable. Checking the two brew prefixes directly costs one stat each.
pub const EXTRA_SEARCH_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// Where to find tmux: the bundled sidecar first, then PATH, then the places a
/// GUI app cannot see but a user's tmux usually lives.
///
/// Sidecar-first so a bundled build is self-contained and reproducible; PATH
/// second so a development checkout works before any packaging exists. Both
/// orders were considered — this one means adding the bundle later changes no
/// code, only what is on disk.
pub fn resolve_tmux(sidecar_dir: Option<&Path>) -> Option<PathBuf> {
    if std::env::var("DOOM_TERM_NO_TMUX").is_ok() {
        return None;
    }
    let exe = if cfg!(windows) { "tmux.exe" } else { "tmux" };

    if let Some(dir) = sidecar_dir {
        let bundled = dir.join(exe);
        if bundled.is_file() {
            return Some(bundled);
        }
    }

    let from_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(exe))
            .find(|candidate| candidate.is_file())
    });
    if from_path.is_some() {
        return from_path;
    }

    EXTRA_SEARCH_DIRS
        .iter()
        .map(|dir| Path::new(dir).join(exe))
        .find(|candidate| candidate.is_file())
}

/// The tmux configuration that makes tmux invisible.
///
/// Every line here is load-bearing and several are counter-intuitive, so each
/// says why. The user's own ~/.tmux.conf is deliberately NOT loaded: this is a
/// UI substrate, not the user's tmux, and inheriting their status bar, prefix
/// and key table would break the pane in ways they could not diagnose.
pub fn config_body() -> String {
    String::from(
        r#"# Doom Term tmux substrate. Generated per run; safe to delete.

# Doom Term draws the interface. A tmux status bar would take a row and render
# its own vocabulary inside ours.
set -g status off
set -g set-titles off

# No prefix key at all. C-b belongs to whatever is running in the pane; an
# agent that uses it would otherwise never see it.
set -g prefix None
set -g prefix2 None

# tmux defaults to holding Esc for 500ms to disambiguate escape sequences,
# which every full-screen program in the pane experiences as a stuck key.
set -g escape-time 0

# The shell's OSC 133 and OSC 7 do not reach a client on their own — tmux
# consumes them. The integration script wraps them in a DCS passthrough, and
# this is what permits it. Without this line, command blocks stop existing.
set -g allow-passthrough on

# Attaching normally sends ESC[?1049h and holds the client in the alternate
# screen for the entire session, which would leave our screen model with no
# scrollback and no blocks for as long as the pane is open. Removing smcup and
# rmcup from the client's terminfo stops tmux using it, so output flows into
# the primary buffer exactly as it does without tmux.
set -ga terminal-overrides ',*:smcup@:rmcup@'

set -g default-terminal "xterm-256color"
set -as terminal-features ',*:RGB'

# Scrollback recovered by capture-pane on reattach; see session.rs.
set -g history-limit 5000

# One client per session, so the newest attach decides the size. Anything else
# letterboxes the pane to a client that is no longer on screen.
set -g window-size latest

# Surviving detach is the entire feature.
set -g destroy-unattached off
set -g remain-on-exit off

# Mouse handling belongs to the pane's program and to our own UI, not to tmux.
set -g mouse off
set -g bell-action none
set -g visual-activity off
"#,
    )
}

/// Write the config where only this user can read it, next to the shell
/// integration scripts. A tmux config can run shell commands, so a
/// world-writable location would be an execution hole.
pub fn write_config() -> Option<PathBuf> {
    crate::runtime_files::write("tmux.conf", &config_body())
        .map_err(|err| {
            log::warn!("Cannot write private tmux configuration: {err}");
        })
        .ok()
}

/// Our own tmux server socket.
///
/// Not the default one, and this is not tidiness — it is correctness. `-f` is
/// honoured only when the server STARTS; against a server that is already
/// running it is silently ignored. On the default socket that is the normal
/// case, because the user or another tool may already have tmux open, and then
/// every assumption below evaporates without a word: passthrough off, so the
/// shell's OSC 133 is swallowed and blocks die; smcup left in place, so the
/// client sits in the alternate screen with no scrollback; the status bar and
/// prefix key back. Observed exactly that way against a pre-existing server.
///
/// A private socket also means we never adopt, resize or kill a session the
/// user made themselves, and `tmux ls` stays theirs.
pub const SOCKET: &str = "doom-term";

/// argv for create-only detached pane startup. Attachment is a separate,
/// identity-checked operation; this command must fail when the name exists.
pub fn create_session_args(
    conf: &Path,
    name: &str,
    cols: u16,
    rows: u16,
    cwd: &Path,
    env: &[(String, String)],
    shell: &str,
    shell_args: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-L".into(),
        SOCKET.into(),
        "-f".into(),
        conf.to_string_lossy().to_string(),
        "new-session".into(),
        "-d".into(),
        "-c".into(),
        cwd.to_string_lossy().to_string(),
        "-s".into(),
        name.into(),
        "-x".into(),
        cols.to_string(),
        "-y".into(),
        rows.to_string(),
    ];
    for (key, value) in env {
        args.push("-e".into());
        args.push(format!("{}={}", key, value));
    }
    // Without the terminator tmux folds the rest into a single command string
    // and parses our shell's own flags as its own.
    args.push("--".into());
    args.push(shell.into());
    args.extend(shell_args.iter().cloned());
    args
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedSession {
    pub id: String,
    pub cwd: String,
    pub command: String,
}

/** argv for enumerating panes on Doom Term's socket, never the user's socket. */
pub fn list_session_args() -> Vec<String> {
    vec![
        "-N".into(),
        "-L".into(),
        SOCKET.into(),
        "list-panes".into(),
        "-a".into(),
        "-F".into(),
        "#{session_name}\t#{pane_current_path}\t#{pane_current_command}".into(),
    ]
}

/** Parse one-pane sessions and reject anything outside our namespace. */
pub fn parse_session_list(output: &str) -> Vec<ListedSession> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let name = fields.next()?;
            let id = name.strip_prefix("doom-")?;
            if id.is_empty() {
                return None;
            }
            Some(ListedSession {
                id: id.to_string(),
                cwd: fields.next().unwrap_or_default().to_string(),
                command: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/** Discover durable panes left behind by an earlier daemon process. */
pub fn list_sessions(exe: &Path) -> Vec<ListedSession> {
    let output = match crate::process_io::run_bounded(
        exe,
        &list_session_args(),
        &[],
        crate::process_io::HelperLimits {
            timeout: std::time::Duration::from_secs(2),
            input_bytes: 0,
            output_bytes: 8 * 1024 * 1024,
        },
    ) {
        Ok(output) => output,
        _ => return Vec::new(),
    };
    parse_session_list(&String::from_utf8_lossy(&output))
}

/// A live tmux session, addressed by name.
///
/// Every query names `-t <session>` explicitly. Without it tmux answers about
/// whatever it considers current, which for a daemon holding several sessions
/// is a coin flip.
#[derive(Debug, Clone)]
pub struct TmuxHandle {
    pub exe: PathBuf,
    pub name: String,
    target: Option<durable::DurableTarget>,
}

impl TmuxHandle {
    /// Legacy discovery handle. New adapters must use create_owned/resolve_owned.
    pub fn named(exe: PathBuf, name: String) -> Self {
        Self {
            exe,
            name,
            target: None,
        }
    }
    /// Resolve one exact pane, then evaluate admission and deliver in tmux's
    /// synchronous command queue. Never trust the outer client's mode 2004.
    pub fn paste(&self, text: &str) -> anyhow::Result<()> {
        self.paste_checked(text, || Ok(()))
    }
    pub(crate) fn paste_checked(
        &self,
        text: &str,
        mut authorize: impl FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        let clean = crate::paste::prepare_paste(text)?;
        authorize()?;
        if clean.is_empty() {
            return Ok(());
        }
        let run = |args: &[&str], input: &[u8]| {
            let argv = self.on_socket(args);
            crate::process_io::run(&self.exe, &argv, input, std::time::Duration::from_secs(2))
        };
        // '=' disables tmux's session-prefix/pattern matching. A numeric pane
        // id then survives focus changes and is safe inside command strings.
        let target = self
            .target
            .as_ref()
            .map(|target| target.pane.clone())
            .unwrap_or_else(|| format!("={}:", self.name));
        let pane = run(&["display-message", "-p", "-t", &target, "#{pane_id}"], &[])?;
        let pane = std::str::from_utf8(&pane).unwrap_or("").trim();
        anyhow::ensure!(
            pane.starts_with('%')
                && pane.len() > 1
                && pane[1..].bytes().all(|b| b.is_ascii_digit()),
            "Paste target is unavailable"
        );
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|_| anyhow::anyhow!("Paste buffer identity unavailable"))?;
        let buffer = format!(
            "doom-paste-{}",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let result = (|| -> anyhow::Result<()> {
            run(&["load-buffer", "-b", &buffer, "-"], clean.as_bytes())?;
            // Loading a private buffer is not delivery. A socket can lose its
            // lease while that bounded helper runs; never paste on that lease.
            authorize()?;
            let condition = if clean.contains('\n') {
                "#{==:#{bracket_paste_flag},1}".to_string()
            } else {
                "1".to_string()
            };
            let condition = if let Some(identity) = self.identity_condition() {
                format!("#{{&&:{identity},{condition}}}")
            } else {
                condition
            };
            let yes = format!(
                "paste-buffer -r -p -d -b {buffer} -t {pane} ; display-message -p DOOM_PASTE_OK"
            );
            let no = format!("delete-buffer -b {buffer} ; display-message -p DOOM_PASTE_BLOCKED");
            let no = if let Some(identity) = self.identity_condition() {
                // A changed root is not evidence that the child's paste mode
                // is off. Recheck the identity in the same command queue and
                // report the appropriate refusal without delivering either.
                format!("if-shell -F -t {pane} '{identity}' '{no}' 'delete-buffer -b {buffer} ; display-message -p DOOM_REPLACED'")
            } else {
                no
            };
            let reply = run(&["if-shell", "-F", "-t", pane, &condition, &yes, &no], &[])?;
            match reply.as_slice() {
                b"DOOM_PASTE_OK\n" => Ok(()),
                b"DOOM_PASTE_BLOCKED\n" => {
                    anyhow::bail!("Multiline paste blocked: child has not enabled bracketed paste")
                }
                b"DOOM_REPLACED\n" => {
                    anyhow::bail!("Paste target was replaced; paste was not sent")
                }
                _ => anyhow::bail!("Paste helper returned an unknown result; delivery is unknown"),
            }
        })();
        if result.is_err() {
            // The buffer is ours alone. Even an uncertain load result may have
            // installed it; cleanup is bounded and never retries delivery.
            let _ = run(&["delete-buffer", "-b", &buffer], &[]);
        }
        result
    }

    /// Every invocation names our socket. A query without `-L` asks the default
    /// server, which is somebody else's — it would report another tmux's panes,
    /// or nothing at all, and `kill-session` would aim at a stranger.
    fn on_socket(&self, rest: &[&str]) -> Vec<String> {
        let mut args: Vec<String> = vec!["-N".into(), "-L".into(), SOCKET.into()];
        args.extend(rest.iter().map(|s| s.to_string()));
        args
    }

    fn run_query(&self, args: &[String]) -> anyhow::Result<Vec<u8>> {
        crate::process_io::run_bounded(
            &self.exe,
            args,
            &[],
            crate::process_io::HelperLimits {
                timeout: std::time::Duration::from_secs(2),
                input_bytes: 0,
                output_bytes: 4096,
            },
        )
    }

    pub fn query_args(&self, format: &str) -> Vec<String> {
        if let Some(target) = &self.target {
            return self.on_socket(&[
                "display-message",
                "-p",
                "-t",
                &target.pane,
                &format!("#{{?{},{format},}}", self.identity_condition().unwrap()),
            ]);
        }
        self.on_socket(&[
            "display-message",
            "-p",
            "-t",
            &format!("={}:", self.name),
            format,
        ])
    }

    pub fn kill_args(&self) -> Vec<String> {
        if let Some(target) = &self.target {
            return self.on_socket(&[
                "if-shell",
                "-F",
                "-t",
                &target.pane,
                &self.identity_condition().unwrap(),
                &format!(
                    "kill-pane -t {} ; display-message -p DOOM_KILLED",
                    target.pane
                ),
                "display-message -p DOOM_REPLACED",
            ]);
        }
        self.on_socket(&["kill-session", "-t", &format!("={}", self.name)])
    }

    /// Read one tmux format string. None when tmux is gone or the session is.
    pub fn query(&self, format: &str) -> Option<String> {
        let out = self.run_query(&self.query_args(format)).ok()?;
        let value = String::from_utf8_lossy(&out).trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    /// The pid of the shell inside the pane.
    ///
    /// This — not the client's pid — is what foreground detection must start
    /// from. The client's controlling terminal is the PTY we opened, and the
    /// foreground process group on it is the client itself, so asking about the
    /// client reports tmux forever and the agent well stays empty.
    pub fn pane_pid(&self) -> Option<u32> {
        self.query("#{pane_pid}")?.parse().ok()
    }

    /// What tmux believes is running in the pane right now.
    ///
    /// The portable half of foreground detection. `/proc/<pid>/stat` gives the
    /// kernel's own answer and stays the primary source where it exists, but it
    /// is Linux-only — on macOS it simply is not there, and without this the
    /// agent well, CONTEXT %, USAGE % and keyboard pass-through would all sit
    /// dark on a machine where everything else works.
    ///
    /// Verified to track the same thing: `bash` at the prompt, `sleep` while a
    /// program runs.
    pub fn pane_current_command(&self) -> Option<String> {
        self.query("#{pane_current_command}")
    }

    /// The pane's working directory, as tmux tracks it.
    ///
    /// The fallback for `foreground_cwd` on a machine with no readable /proc,
    /// for the same reason `pane_current_command` is the fallback for the
    /// foreground process: tmux is the other witness that is always present.
    pub fn pane_current_path(&self) -> Option<String> {
        self.query("#{pane_current_path}")
    }

    /// Whether the pane's program is on the alternate screen.
    ///
    /// Our own screen model cannot answer this: `smcup@` deliberately keeps the
    /// client out of the alternate buffer so scrollback and command blocks
    /// survive, and the side effect is that a full-screen program in the pane
    /// is invisible to us. tmux is the only remaining witness.
    pub fn alternate_on(&self) -> Option<bool> {
        Some(self.query("#{alternate_on}")? == "1")
    }

    pub fn has_session(&self) -> bool {
        if self.target.is_some() {
            return self.query("#{pane_id}").is_some();
        }
        self.run_query(&self.on_socket(&["has-session", "-t", &format!("={}", self.name)]))
            .is_ok()
    }

    pub fn kill_session(&self) -> bool {
        match self.run_query(&self.kill_args()) {
            Ok(reply) => self.target.is_none() || reply == b"DOOM_KILLED\n",
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_out_of_every_shape_tmux_reports() {
        assert_eq!(parse_version("tmux 3.7b"), Some((3, 7)));
        assert_eq!(parse_version("tmux 3.2a\n"), Some((3, 2)));
        assert_eq!(parse_version("tmux next-3.4"), Some((3, 4)));
        assert_eq!(parse_version("tmux 2.8"), Some((2, 8)));
    }

    #[test]
    fn an_unreadable_version_is_refused_rather_than_assumed_new() {
        // `allow-passthrough` arrived in 3.3, and without it the shell's OSC
        // 133 never reaches us — blocks stop working and nothing says so. A
        // build we cannot date is therefore not durable-capable: falling back
        // to a direct spawn is the behaviour we already have, and correct.
        assert_eq!(parse_version("tmux master"), None);
        assert_eq!(parse_version(""), None);
        assert!(!version_supported("tmux master"));
    }

    #[test]
    fn the_floor_requires_observable_child_paste_mode() {
        assert!(!version_supported("tmux 3.2a"));
        for unsupported in ["tmux 3.3", "tmux 3.4", "tmux 3.5a", "tmux 3.6b"] {
            assert!(
                !version_supported(unsupported),
                "{unsupported} cannot report child paste mode"
            );
        }
        assert!(version_supported("tmux 3.7b"));
        assert!(!version_supported("tmux 2.9"));
    }

    #[test]
    fn a_session_name_is_namespaced_so_it_never_adopts_a_stranger() {
        // Attaching to a name we did not create would hand a user someone
        // else's shell. The prefix is what keeps `doom-1` distinct from a
        // hand-made session called `1`.
        assert_eq!(session_name("node-7"), "doom-node-7");
        assert!(session_name("x").starts_with("doom-"));
    }

    #[test]
    fn the_config_keeps_tmux_out_of_the_alternate_screen() {
        // Measured, not assumed: attaching sends ESC[?1049h as its first bytes,
        // which would put the screen model in the alternate buffer for the whole
        // life of the session — no scrollback, and no command blocks, ever.
        // Removing smcup/rmcup from the client's terminfo is what stops it.
        let conf = config_body();
        assert!(conf.contains("smcup@"), "must disable the alternate screen");
        assert!(conf.contains("rmcup@"));
    }

    #[test]
    fn the_config_lets_the_shells_own_escape_sequences_through() {
        // Bare OSC 133 and OSC 7 from inside a pane are consumed by tmux and
        // never reach us. The DCS wrapper in shell_integration is the way out,
        // and it only works if passthrough is enabled here.
        assert!(config_body().contains("allow-passthrough on"));
    }

    #[test]
    fn the_config_gives_tmux_no_keys_and_no_chrome_of_its_own() {
        // Doom Term draws the UI. A tmux status bar would eat a row and render
        // vocabulary we do not control, and a live prefix key would swallow
        // C-b before the agent in the pane ever saw it.
        let conf = config_body();
        assert!(conf.contains("status off"));
        assert!(conf.contains("set -g prefix None"));
        assert!(conf.contains("set -g prefix2 None"));
    }

    #[test]
    fn the_config_does_not_delay_escape() {
        // tmux defaults to a 500ms escape-time, which every full-screen program
        // in the pane experiences as a stuck Esc key.
        assert!(config_body().contains("escape-time 0"));
    }

    #[test]
    fn a_new_session_is_create_only_at_an_explicit_size() {
        // -x/-y matter because a session
        // created at tmux's 80x24 default and resized afterwards makes every
        // program in it redraw at the wrong width first.
        let args = create_session_args(
            Path::new("/run/doom.conf"),
            "doom-n1",
            100,
            30,
            Path::new("/work"),
            &[],
            "/bin/bash",
            &[],
        );
        let joined = args.join(" ");
        // The socket comes first and is not optional: `-f` is honoured only
        // when the server starts, so against the default socket — where the
        // user may already have tmux running — the whole config is ignored
        // without a word and every guarantee below it quietly disappears.
        assert!(joined.starts_with("-L doom-term "), "{joined}");
        assert!(joined.contains("-f /run/doom.conf"), "{joined}");
        assert!(joined.contains("new-session -d -c /work"), "{joined}");
        assert!(!joined.contains(" -A"), "{joined}");
        assert!(joined.contains("-s doom-n1"), "{joined}");
        assert!(joined.contains("-x 100"), "{joined}");
        assert!(joined.contains("-y 30"), "{joined}");
    }

    #[test]
    fn the_shell_and_its_integration_args_go_after_the_terminator() {
        // Without `--`, tmux joins the remaining words into one shell command
        // string, and `--rcfile` would be parsed by tmux rather than bash.
        let args = create_session_args(
            Path::new("/c"),
            "doom-n1",
            80,
            24,
            Path::new("/work"),
            &[],
            "/bin/bash",
            &["--rcfile".into(), "/run/i.sh".into(), "-i".into()],
        );
        let dashdash = args.iter().position(|a| a == "--").expect("needs --");
        assert_eq!(
            &args[dashdash + 1..],
            ["/bin/bash", "--rcfile", "/run/i.sh", "-i"]
        );
    }

    #[test]
    fn environment_reaches_the_pane_and_not_merely_the_client() {
        // The client process's environment is not the pane's: the pane is a
        // child of the tmux server, which may long predate this client. -e is
        // the only thing that puts ZDOTDIR where the shell will read it.
        let args = create_session_args(
            Path::new("/c"),
            "doom-n1",
            80,
            24,
            Path::new("/work"),
            &[("ZDOTDIR".into(), "/run/doom-term".into())],
            "/bin/zsh",
            &[],
        );
        let joined = args.join(" ");
        assert!(joined.contains("-e ZDOTDIR=/run/doom-term"), "{joined}");
    }

    #[test]
    fn a_handle_asks_tmux_about_its_own_session_only() {
        // A query without -t answers about whichever session tmux considers
        // current, which is not necessarily ours — the same class of mislabel
        // the per-session telemetry lookup already exists to prevent.
        let h = TmuxHandle {
            exe: PathBuf::from("/usr/bin/tmux"),
            name: "doom-n1".into(),
            target: None,
        };
        assert_eq!(
            h.query_args("#{pane_pid}"),
            vec![
                "-N",
                "-L",
                "doom-term",
                "display-message",
                "-p",
                "-t",
                "=doom-n1:",
                "#{pane_pid}"
            ]
        );
    }

    #[test]
    fn killing_means_kill_the_session_not_detach_from_it() {
        // Detaching is the default and is exactly wrong here: the user asked to
        // close the tab, and a surviving shell they can no longer see is a leak
        // they cannot find.
        let h = TmuxHandle {
            exe: PathBuf::from("/usr/bin/tmux"),
            name: "doom-n1".into(),
            target: None,
        };
        assert_eq!(
            h.kill_args(),
            vec!["-N", "-L", "doom-term", "kill-session", "-t", "=doom-n1"]
        );
    }

    #[test]
    fn a_bundled_tmux_wins_over_whatever_is_on_the_path() {
        // The whole point of sidecar-first is that shipping a binary changes
        // what is on disk and no code. If PATH won, a bundled build would
        // silently run the user's tmux instead of the one it was tested with.
        let dir = std::env::temp_dir().join("doom-term-resolve-test");
        std::fs::create_dir_all(&dir).unwrap();
        let bundled = dir.join(if cfg!(windows) { "tmux.exe" } else { "tmux" });
        std::fs::write(&bundled, b"#!/bin/sh\n").unwrap();

        assert_eq!(resolve_tmux(Some(&dir)), Some(bundled));

        // An empty sidecar directory falls through to PATH rather than giving
        // up: a development checkout has no bundle and must still work.
        let empty = std::env::temp_dir().join("doom-term-resolve-empty");
        std::fs::create_dir_all(&empty).unwrap();
        let from_path = resolve_tmux(Some(&empty));
        assert_eq!(from_path, resolve_tmux(None));

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&empty).ok();
    }

    #[test]
    fn the_foreground_command_can_be_asked_of_tmux_instead_of_proc() {
        // /proc is Linux-only, so on macOS the kernel route returns nothing and
        // the agent well would stay empty forever. tmux tracks the same thing
        // and answers portably, which is the whole reason this exists.
        let h = TmuxHandle {
            exe: PathBuf::from("/usr/bin/tmux"),
            name: "doom-n1".into(),
            target: None,
        };
        assert_eq!(
            h.query_args("#{pane_current_command}"),
            vec![
                "-N",
                "-L",
                "doom-term",
                "display-message",
                "-p",
                "-t",
                "=doom-n1:",
                "#{pane_current_command}"
            ]
        );
    }

    #[test]
    fn tmux_is_searched_for_where_a_gui_app_will_actually_find_it() {
        // A macOS app launched from Finder does not inherit the shell's PATH,
        // so a Homebrew tmux is invisible to it. Both brew prefixes are checked
        // explicitly — Apple Silicon first, then Intel.
        assert!(EXTRA_SEARCH_DIRS.contains(&"/opt/homebrew/bin"));
        assert!(EXTRA_SEARCH_DIRS.contains(&"/usr/local/bin"));
    }

    #[test]
    fn the_alternate_screen_flag_is_asked_of_the_pane() {
        // Removing smcup from the client's terminfo is what keeps our screen
        // model in the primary buffer, and the price is that a full-screen
        // program in the pane no longer announces itself to us. tmux still
        // knows, so we ask it rather than lose the signal.
        let h = TmuxHandle {
            exe: PathBuf::from("/usr/bin/tmux"),
            name: "doom-n1".into(),
            target: None,
        };
        assert_eq!(
            h.query_args("#{alternate_on}"),
            vec![
                "-N",
                "-L",
                "doom-term",
                "display-message",
                "-p",
                "-t",
                "=doom-n1:",
                "#{alternate_on}"
            ]
        );
    }

    #[test]
    fn recovery_lists_only_our_private_socket_and_asks_for_one_record_per_pane() {
        assert_eq!(
            list_session_args(),
            vec![
                "-N",
                "-L",
                "doom-term",
                "list-panes",
                "-a",
                "-F",
                "#{session_name}\t#{pane_current_path}\t#{pane_current_command}",
            ],
        );
    }

    #[test]
    fn recovery_parses_only_namespaced_sessions_and_strips_the_internal_prefix() {
        let listed = parse_session_list(
            "doom-node-1\t/home/u/repo\tcodex\nstranger\t/tmp\tbash\ndoom-node-2\t/tmp\tbash\n",
        );
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "node-1");
        assert_eq!(listed[0].cwd, "/home/u/repo");
        assert_eq!(listed[0].command, "codex");
        assert_eq!(listed[1].id, "node-2");
    }
}
