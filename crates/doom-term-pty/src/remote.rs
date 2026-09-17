//! Enrichment reported by a shell on the other end of a transport.
//!
//! Everything in `backend/src/metadata.rs` is computed from the machine the
//! daemon runs on. Over SSH that is not where the work is: the hostname is the
//! laptop's, `git -C` runs against a path that exists only on the remote, and
//! the foreground process is `ssh`. This module carries the remote's own
//! answers back in-band, on the PTY the session already has.
//!
//! Every field is optional and an absent one stays absent. A local value is
//! never substituted for a missing remote one: it is not a degraded version of
//! the remote answer, it is an answer about a different computer, and Axiom 3
//! has no category for "true of something else".

use serde::{Deserialize, Serialize};

/// The only schema this build understands. A frame from a newer remote is
/// discarded whole rather than read field by field.
const SCHEMA_VERSION: u32 = 1;

/// Frames are drawn on a 480px plate. Anything near this is not enrichment.
const MAX_FRAME_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteEnrichment {
    pub host: Option<String>,
    pub user: Option<String>,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    /// The remote's own foreground classification, in the same vocabulary
    /// `classify_agent` uses. Never widened to admit `ssh`, which is a
    /// transport and not an agent.
    pub agent: Option<String>,
    pub busy: Option<bool>,
}

#[derive(Deserialize)]
struct Frame {
    v: u32,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    busy: Option<bool>,
}

/// A field is admissible only if it cannot write to our own chrome.
///
/// These strings are drawn on the plate. A control character in one is a
/// remote machine emitting escape sequences into our status bar, so the whole
/// frame is refused rather than the field sanitised — a half-trusted frame is
/// not a thing worth having.
fn clean(value: Option<String>) -> Result<Option<String>, ()> {
    match value {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) if s.chars().any(char::is_control) => Err(()),
        Some(s) => Ok(Some(s)),
    }
}

/// One frame, or nothing.
///
/// There is no partial apply: a frame we only half understand would put half a
/// remote's identity beside half of the local machine's, which reads as a
/// coherent answer and is not one.
pub fn parse_frame(b64: &str) -> Option<RemoteEnrichment> {
    use base64::Engine;
    if b64.is_empty() || b64.len() > MAX_FRAME_BYTES {
        return None;
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if raw.len() > MAX_FRAME_BYTES {
        return None;
    }
    let frame: Frame = serde_json::from_slice(&raw).ok()?;
    if frame.v != SCHEMA_VERSION {
        return None;
    }
    Some(RemoteEnrichment {
        host: clean(frame.host).ok()?,
        user: clean(frame.user).ok()?,
        shell: clean(frame.shell).ok()?,
        cwd: clean(frame.cwd).ok()?,
        branch: clean(frame.branch).ok()?,
        agent: clean(frame.agent).ok()?,
        busy: frame.busy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn encode(json: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(json)
    }

    #[test]
    fn parses_a_frame_captured_from_the_real_snippet() {
        // Not hand-written: these are the exact bytes `remote_enrichment_snippet`
        // produced when sourced into a real bash on 2026-09-17. The snippet and
        // this parser are two halves of one wire format and drift silently
        // otherwise — the cwd here even carries a space, which is why it is a
        // better fixture than anything I would have invented.
        let captured = "eyJ2IjoxLCJob3N0IjoiU0VSNi1NQVgiLCJ1c2VyIjoiY2xlYWRtb24iLCJzaGVsbCI6ImJhc2giLCJjd2QiOiIvdmFyL2hvbWUvY2xlYWRtb24vUHJvamVjdHMvRG9vbSBUZXJtIiwiYnJhbmNoIjoiZmVhdC9yZW1vdGUtZW5oYW5jZW1lbnQifQ==";
        let got =
            parse_frame(captured).expect("the shipped snippet must produce a parseable frame");
        assert!(got.host.is_some(), "the snippet reported no host");
        assert!(got.user.is_some(), "the snippet reported no user");
        assert_eq!(got.shell.as_deref(), Some("bash"));
        assert!(got.cwd.unwrap().contains('/'));
        assert_eq!(got.branch.as_deref(), Some("feat/remote-enhancement"));
    }

    #[test]
    fn parses_a_well_formed_frame() {
        let frame = encode(
            r#"{"v":1,"host":"devbox","user":"cml","shell":"bash","branch":"main","agent":"claude","busy":true}"#,
        );
        let got = parse_frame(&frame).expect("a v1 frame must parse");
        assert_eq!(got.host.as_deref(), Some("devbox"));
        assert_eq!(got.user.as_deref(), Some("cml"));
        assert_eq!(got.agent.as_deref(), Some("claude"));
        assert_eq!(got.busy, Some(true));
    }

    #[test]
    fn a_field_the_remote_omitted_is_none_not_a_default() {
        // None renders '--'. An empty string would render as a host named "".
        let got = parse_frame(&encode(r#"{"v":1,"host":"devbox"}"#)).unwrap();
        assert_eq!(got.branch, None);
        assert_eq!(got.busy, None);
        assert_eq!(got.agent, None);
    }

    #[test]
    fn an_empty_field_is_absent_rather_than_a_blank_answer() {
        let got = parse_frame(&encode(r#"{"v":1,"host":"devbox","branch":""}"#)).unwrap();
        assert_eq!(got.branch, None);
    }

    #[test]
    fn rejects_an_unknown_schema_version_whole() {
        assert!(parse_frame(&encode(r#"{"v":2,"host":"devbox"}"#)).is_none());
        assert!(parse_frame(&encode(r#"{"host":"devbox"}"#)).is_none());
    }

    #[test]
    fn rejects_malformed_input_without_partially_applying_it() {
        assert!(parse_frame("not base64 at all !!!").is_none());
        assert!(parse_frame(&encode("{ not json")).is_none());
        assert!(parse_frame("").is_none());
    }

    #[test]
    fn refuses_an_oversized_frame() {
        let big = encode(&format!(r#"{{"v":1,"host":"{}"}}"#, "x".repeat(16 * 1024)));
        assert!(parse_frame(&big).is_none());
    }

    #[test]
    fn refuses_control_characters_in_a_reported_field() {
        // These values are drawn on the plate. An escape introducer in one is a
        // remote machine writing to our status bar.
        assert!(parse_frame(&encode("{\"v\":1,\"host\":\"dev\\u001b[31mbox\"}")).is_none());
        assert!(parse_frame(&encode("{\"v\":1,\"branch\":\"ma\\nin\"}")).is_none());
    }

    #[test]
    fn a_refused_field_refuses_the_whole_frame() {
        // Not "keep the good fields": half a remote identity beside half of the
        // local machine's reads as a coherent answer and is not one.
        let got = parse_frame(&encode(
            "{\"v\":1,\"host\":\"devbox\",\"user\":\"c\\u0007ml\"}",
        ));
        assert!(got.is_none());
    }
}
