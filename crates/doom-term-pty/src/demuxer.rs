use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DemuxEvent {
    Output { data: String },
    PromptStart,
    CommandStart,
    ExecutionStart,
    ExecutionEnd { exit_code: Option<i32> },
    TuiMode { active: bool },
    BracketedPasteMode { enabled: bool },
    AgentState { state: String },
    Cwd { path: String },
    StreamFault { reason: crate::stream::StreamFault },
}

/// A malformed unterminated control record must not grow forever or turn its
/// tail into invented screen text. The fault ends this rendering epoch.
const MAX_CONTROL_LEN: usize = crate::stream::MAX_RECORD_BYTES;

/// What we tell a program that asks what we look like. These are the real
/// design tokens — `--ground` and `--ink` in styles/material.css — because a
/// CLI picks its light or dark palette from the answer, and lying here makes
/// agent output unreadable against the plate.
const GROUND_RGB: &str = "rgb:1414/1212/0f0f"; // #14120f
const INK_RGB: &str = "rgb:d8d8/cbcb/b0b0"; // #d8cbb0

pub struct StreamDemuxer {
    faulted: bool,
    in_esc: bool,
    in_osc: bool,
    osc_buf: Vec<u8>,
    in_csi: bool,
    csi_buf: Vec<u8>,
    /// An open DCS, SOS, PM or APC string.
    ///
    /// The demuxer modelled OSC and CSI and nothing else, so `ESC P` fell into
    /// the ESC catch-all below: the introducer was emitted as text and the
    /// state machine returned to ground, which printed every byte of the body.
    /// A remote whose rc file carries Warp's bootstrap therefore rendered its
    /// JSON hook on screen at every connect.
    ///
    /// None of these sequences carries screen content by definition. The
    /// terminator is the only part that matters and swallowing the rest is the
    /// whole job, so the body is counted rather than buffered.
    in_string: bool,
    /// An ESC seen inside a string, which may be the first half of `ESC \`.
    string_esc: bool,
    string_len: usize,
    tui_active: bool,
    /// Bytes owed back to the PTY. A terminal that stays silent when asked a
    /// question leaves the asker blocked on its own timeout.
    pending_responses: Vec<u8>,
    /// Trailing bytes of a UTF-8 sequence that the last read cut in half.
    /// At most three, since no sequence is longer than four bytes.
    utf8_tail: Vec<u8>,
}

/// Accumulated output bytes to a renderable String, holding back any trailing
/// INCOMPLETE UTF-8 sequence for the next read to finish.
///
/// A PTY read ends on an arbitrary byte boundary (8192 bytes, `session.rs`), so
/// a multi-byte character routinely straddles two reads. `from_utf8_lossy`
/// turns each half into U+FFFD and the character is lost — the same end-of-read
/// hazard this demuxer already tracks for ESC, left unhandled for UTF-8 until
/// 2026-08-29. Nerd Font icons and box drawing made it visible constantly.
///
/// Only genuinely incomplete trailing bytes are held. Bytes that can never
/// begin or continue a sequence are still replaced, because malformed input
/// must not accumulate forever waiting for a continuation that cannot come.
fn take_output(chunk: &mut Vec<u8>, tail: &mut Vec<u8>) -> String {
    let split = match std::str::from_utf8(chunk) {
        Ok(_) => chunk.len(),
        // `error_len() == None` means the input ENDED mid-sequence: hold it.
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        // A real encoding error: mark it and move on.
        Err(_) => chunk.len(),
    };
    *tail = chunk.split_off(split);
    let text = String::from_utf8_lossy(chunk).to_string();
    chunk.clear();
    text
}

impl StreamDemuxer {
    pub fn new() -> Self {
        Self {
            faulted: false,
            in_esc: false,
            in_osc: false,
            osc_buf: Vec::with_capacity(256),
            in_csi: false,
            csi_buf: Vec::with_capacity(64),
            in_string: false,
            string_esc: false,
            string_len: 0,
            tui_active: false,
            pending_responses: Vec::new(),
            utf8_tail: Vec::new(),
        }
    }

    /// Take the bytes owed back to the PTY. The caller must write these to the
    /// shell; until it does, whatever asked is still sitting on a timeout.
    pub fn take_responses(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending_responses)
    }

    /// Answer the "what are you?" probes a real terminal replies to instantly.
    /// Returns true when the record was a query, so the caller knows to keep it
    /// off the screen.
    fn answer_query(&mut self, osc_content: &str) -> bool {
        let trimmed = osc_content.trim_start_matches("\x1b]").trim();
        let reply = match trimmed {
            "11;?" => format!("\x1b]11;{}\x1b\\", GROUND_RGB),
            "10;?" => format!("\x1b]10;{}\x1b\\", INK_RGB),
            _ => return false,
        };
        self.pending_responses.extend_from_slice(reply.as_bytes());
        true
    }

    /// What we owe a CSI probe, or None when the sequence is not one.
    ///
    /// `csi_str` is the record WITHOUT its leading `ESC [`, final byte included.
    ///
    /// The device attributes are @xterm/headless's own, because that is the
    /// emulator actually behind this terminal — its `onData` is not wired back
    /// to the PTY (see `core/commandDelivery.ts`), so a reply it generates goes
    /// nowhere and this is the only place an answer can come from. Claiming
    /// more than xterm implements would invite sequences it cannot draw.
    ///
    /// `CSI ? u`, the kitty keyboard protocol probe, is deliberately absent.
    /// Answering it would claim a key encoding this terminal does not send, and
    /// an agent that believed us would encode Escape and every modified key in
    /// a form nothing here produces. Ignoring it while answering Primary DA is
    /// how a terminal declines: the asker takes the DA reply as its NO.
    fn csi_reply(csi_str: &str) -> Option<&'static str> {
        match csi_str {
            // Device Status Report. The demuxer does not model a cursor, so it
            // reports the origin: an approximate answer costs a repaint,
            // silence costs five seconds.
            "6n" => Some("\x1b[1;1R"),
            // ...and DSR 5 asks after the terminal's health, not the cursor.
            "5n" => Some("\x1b[0n"),
            // Primary DA: VT100 with Advanced Video Option.
            "c" | "0c" => Some("\x1b[?1;2c"),
            // Secondary DA: terminal id 0, firmware 276, cartridge 0.
            ">c" | ">0c" => Some("\x1b[>0;276;0c"),
            _ => None,
        }
    }

    pub fn process_bytes(&mut self, bytes: &[u8]) -> Vec<DemuxEvent> {
        if self.faulted {
            return Vec::new();
        }
        let mut events = Vec::new();
        // Whatever the last read cut in half rejoins the front of this one.
        let mut output_chunk = std::mem::take(&mut self.utf8_tail);

        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];

            // A control string runs to its terminator and reaches nobody.
            if self.in_string {
                if self.string_len == MAX_CONTROL_LEN {
                    events.push(self.control_fault());
                    return events;
                }
                self.string_len += 1;
                let escaped = self.string_esc;
                self.string_esc = false;
                if escaped {
                    // ESC \ is the 7-bit ST. ESC anything-else is payload, and
                    // a second ESC may itself begin the terminator.
                    if b == b'\\' {
                        self.in_string = false;
                    } else if b == 0x1b {
                        self.string_esc = true;
                    }
                } else if b == 0x9c || b == 0x07 {
                    // 8-bit ST, and BEL accepted leniently as it is for OSC.
                    self.in_string = false;
                } else if b == 0x1b {
                    self.string_esc = true;
                }
                i += 1;
                continue;
            }

            if self.in_osc {
                if self.osc_buf.len() == MAX_CONTROL_LEN {
                    events.push(self.control_fault());
                    return events;
                }
                self.osc_buf.push(b);
                let is_bel = b == 0x07;
                let is_st = self.osc_buf.len() >= 2
                    && self.osc_buf[self.osc_buf.len() - 2] == 0x1b
                    && self.osc_buf[self.osc_buf.len() - 1] == b'\\';

                if is_bel || is_st {
                    self.in_osc = false;
                    let osc_slice = if is_st {
                        &self.osc_buf[..self.osc_buf.len().saturating_sub(2)]
                    } else if is_bel {
                        &self.osc_buf[..self.osc_buf.len().saturating_sub(1)]
                    } else {
                        &self.osc_buf[..]
                    };

                    // An OSC record is never printable. If we do not understand
                    // it we drop it: forwarding the bytes is what put
                    // `]0;user@host` and `]3008;machineid=…` on the screen.
                    let osc_record = std::str::from_utf8(osc_slice).ok().map(str::to_owned);
                    self.osc_buf.clear();

                    // A probe is answered, not parsed — it carries no event and
                    // must not reach the screen.
                    if let Some(osc_str) = osc_record.filter(|s| !self.answer_query(s)) {
                        if let Some(event) = self.parse_osc_command(&osc_str) {
                            // The OSC 133 markers are still parsed into events —
                            // the boundaries are worth knowing — but the text
                            // BETWEEN them is no longer withheld from the
                            // screen. It used to be: everything from OSC 133;A
                            // to OSC 133;C was dropped, so the shell's prompt
                            // and the command you had just typed never reached
                            // the renderer at all.
                            //
                            // That was right for exactly one consumer, the
                            // block editor, which drew its own prompt and its
                            // own command line from the block model. The block
                            // editor was deleted in 2ae3bab; this outlived it by
                            // three commits and turned the one remaining view
                            // into a terminal that shows command OUTPUT and
                            // nothing else — no prompt, and no echo of what you
                            // type. `tui_active` was the only escape hatch, and
                            // inline agents (Claude Code, Codex, Antigravity)
                            // never set the alternate screen, so it did not
                            // cover the case that mattered most.
                            if !output_chunk.is_empty() {
                                events.push(DemuxEvent::Output {
                                    data: String::from_utf8_lossy(&output_chunk).to_string(),
                                });
                                output_chunk.clear();
                            }
                            events.push(event);
                        }
                    }
                }
                i += 1;
                continue;
            }

            if self.in_csi {
                if self.csi_buf.len() == MAX_CONTROL_LEN - 2 {
                    events.push(self.control_fault());
                    return events;
                }
                self.csi_buf.push(b);
                if (0x40..=0x7e).contains(&b) {
                    self.in_csi = false;
                    let mut is_query = false;
                    if let Ok(csi_str) = std::str::from_utf8(&self.csi_buf) {
                        if matches!(b, b'h' | b'l')
                            && csi_str.starts_with('?')
                            && csi_str[1..csi_str.len() - 1]
                                .split(';')
                                .any(|param| param == "2004")
                        {
                            events.push(DemuxEvent::BracketedPasteMode { enabled: b == b'h' });
                        }
                        if let Some(reply) = Self::csi_reply(csi_str) {
                            // A probe is for the terminal, never for the screen.
                            // Silence here is not free: the asker sits on its
                            // own timeout, and some of them wait five seconds.
                            self.pending_responses.extend_from_slice(reply.as_bytes());
                            is_query = true;
                        } else if csi_str == "?1049h" || csi_str == "?47h" || csi_str == "?1047h" {
                            if !self.tui_active {
                                self.tui_active = true;
                                if !output_chunk.is_empty() {
                                    events.push(DemuxEvent::Output {
                                        data: String::from_utf8_lossy(&output_chunk).to_string(),
                                    });
                                    output_chunk.clear();
                                }
                                events.push(DemuxEvent::TuiMode { active: true });
                            }
                        } else if csi_str == "?1049l" || csi_str == "?47l" || csi_str == "?1047l" {
                            if self.tui_active {
                                self.tui_active = false;
                                if !output_chunk.is_empty() {
                                    events.push(DemuxEvent::Output {
                                        data: String::from_utf8_lossy(&output_chunk).to_string(),
                                    });
                                    output_chunk.clear();
                                }
                                events.push(DemuxEvent::TuiMode { active: false });
                            }
                        }
                    }
                    if !is_query {
                        output_chunk.push(0x1b);
                        output_chunk.push(b'[');
                        output_chunk.extend_from_slice(&self.csi_buf);
                    }
                    self.csi_buf.clear();
                }
                i += 1;
                continue;
            }

            // ESC is tracked as state rather than by peeking at the next byte:
            // a read can end exactly on the ESC, and the old lookahead emitted
            // it as text and then failed to recognise the sequence that followed.
            if self.in_esc {
                self.in_esc = false;
                if b == b']' {
                    self.in_osc = true;
                    self.osc_buf.clear();
                    self.osc_buf.push(0x1b);
                    self.osc_buf.push(b']');
                    i += 1;
                    continue;
                }
                if b == b'[' {
                    self.in_csi = true;
                    self.csi_buf.clear();
                    i += 1;
                    continue;
                }
                // DCS, SOS, PM, APC. Nothing inside one is screen content.
                if matches!(b, b'P' | b'X' | b'^' | b'_') {
                    self.in_string = true;
                    self.string_esc = false;
                    self.string_len = 0;
                    i += 1;
                    continue;
                }
                // Some other ESC sequence — hand it to the renderer intact.
                if b == b'c' {
                    events.push(DemuxEvent::BracketedPasteMode { enabled: false });
                }
                output_chunk.push(0x1b);
                output_chunk.push(b);
                i += 1;
                continue;
            }

            if b == 0x1b {
                self.in_esc = true;
                i += 1;
                continue;
            }

            // The 8-bit C1 introducers (DCS 0x90, SOS 0x98, PM 0x9e, APC 0x9f)
            // are deliberately NOT recognised here.
            //
            // In a UTF-8 stream they are indistinguishable from continuation
            // bytes, because that is exactly what they are: 0x80..=0xbf is the
            // continuation range. Treating 0x9f as an APC introducer ate the
            // second byte of every four-byte emoji — U+1F389 is f0 9f 8e 89 —
            // which the split-emoji test caught immediately. xterm declines
            // them in UTF-8 mode for the same reason.
            //
            // The 8-bit ST is a different question and IS honoured, inside a
            // string, where the body is opaque bytes rather than decoded text.
            // That is the terminator Warp's bootstrap actually uses.
            output_chunk.push(b);
            i += 1;
        }

        if !output_chunk.is_empty() {
            let data = take_output(&mut output_chunk, &mut self.utf8_tail);
            // A read that was nothing but the head of a split character emits
            // no event at all — the bytes are held, not dropped.
            if !data.is_empty() {
                events.push(DemuxEvent::Output { data });
            }
        }

        events
    }

    fn control_fault(&mut self) -> DemuxEvent {
        self.faulted = true;
        self.osc_buf = Vec::new();
        self.csi_buf = Vec::new();
        self.in_string = false;
        self.string_esc = false;
        self.string_len = 0;
        self.utf8_tail.clear();
        self.pending_responses.clear();
        DemuxEvent::StreamFault {
            reason: crate::stream::StreamFault::ControlTooLong,
        }
    }

    fn parse_osc_command(&self, osc_content: &str) -> Option<DemuxEvent> {
        let trimmed = osc_content.trim_start_matches("\x1b]").trim();

        // OSC 133 Shell Integration
        if trimmed.starts_with("133;") {
            let parts: Vec<&str> = trimmed.split(';').collect();
            if parts.len() < 2 {
                return None;
            }

            return match parts[1] {
                "A" => Some(DemuxEvent::PromptStart),
                "B" => Some(DemuxEvent::CommandStart),
                "C" => Some(DemuxEvent::ExecutionStart),
                "D" => {
                    let exit_code = if parts.len() >= 3 {
                        parts[2].parse::<i32>().ok()
                    } else {
                        None
                    };
                    Some(DemuxEvent::ExecutionEnd { exit_code })
                }
                _ => None,
            };
        }

        // OSC 7 — the shell's own report of where it is: file://host/path
        if let Some(rest) = trimmed.strip_prefix("7;") {
            if let Some(after_scheme) = rest.trim().strip_prefix("file://") {
                if let Some(slash) = after_scheme.find('/') {
                    let path = percent_decode(&after_scheme[slash..]);
                    #[cfg(windows)]
                    let path = {
                        let bytes = path.as_bytes();
                        if bytes.len() >= 4
                            && bytes[1].is_ascii_alphabetic()
                            && bytes[2] == b':'
                            && bytes[3] == b'/'
                        {
                            path[1..].replace('/', "\\")
                        } else if !after_scheme[..slash].is_empty()
                            && !after_scheme[..slash].eq_ignore_ascii_case("localhost")
                        {
                            format!("\\\\{}{}", &after_scheme[..slash], path.replace('/', "\\"))
                        } else {
                            path
                        }
                    };
                    return Some(DemuxEvent::Cwd { path });
                }
            }
            return None;
        }

        // OSC 3008 — ptyxis/Bazzite shell integration. It carries cwd= on every
        // prompt, which is a better source of truth than the daemon's own
        // process directory, and it used to be printed verbatim to the screen.
        if trimmed.starts_with("3008;") {
            for field in trimmed.split(';') {
                if let Some(dir) = field.strip_prefix("cwd=") {
                    if !dir.is_empty() {
                        return Some(DemuxEvent::Cwd {
                            path: dir.to_string(),
                        });
                    }
                }
            }
            return None;
        }

        // OSC 1337 Agent State Hooks (e.g. \x1b]1337;AgentState=running\x07)
        if trimmed.starts_with("1337;") {
            let body = &trimmed[5..];
            if body.starts_with("AgentState=") {
                let state = body["AgentState=".len()..].trim().to_lowercase();
                return Some(DemuxEvent::AgentState { state });
            }
        }

        None
    }
}

/// Minimal percent-decoding for OSC 7 paths (spaces arrive as %20).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collect just the renderable text out of a demux result.
    fn screen_text(events: &[DemuxEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_warp_bootstrap_frame_never_reaches_the_renderer() {
        // Observed on a remote whose ~/.bashrc carries Warp's auto-warpify
        // snippet. ESC P fell through the ESC catch-all, so the payload printed
        // from `$f` onward, character for character.
        let mut demuxer = StreamDemuxer::new();
        let input = b"before\x1bP$f{\"hook\": \"SourcedRcFileForWarp\", \"value\": { \"shell\": \"bash\" }}\x1b\\after";
        let text = screen_text(&demuxer.process_bytes(input));
        assert!(
            !text.contains("SourcedRcFileForWarp"),
            "DCS payload reached the screen: {text:?}"
        );
        assert!(!text.contains("$f"), "DCS payload reached the screen: {text:?}");
        assert_eq!(text, "beforeafter");
    }

    #[test]
    fn an_eight_bit_string_terminator_ends_a_control_string() {
        // Warp terminates with the single byte 0x9c, which is invalid UTF-8.
        // take_output's from_utf8_lossy would replace it with U+FFFD before any
        // consumer could resynchronise on it, so it must be recognised in the
        // byte loop, ahead of the splice.
        let mut demuxer = StreamDemuxer::new();
        let text = screen_text(&demuxer.process_bytes(b"a\x1bP$fpayload\x9cb"));
        assert_eq!(text, "ab");
    }

    #[test]
    fn apc_pm_and_sos_are_swallowed_like_dcs() {
        for intro in [&b"\x1b_"[..], &b"\x1b^"[..], &b"\x1bX"[..]] {
            let mut demuxer = StreamDemuxer::new();
            let mut input = b"x".to_vec();
            input.extend_from_slice(intro);
            input.extend_from_slice(b"secret");
            input.extend_from_slice(b"\x1b\\y");
            let text = screen_text(&demuxer.process_bytes(&input));
            assert_eq!(text, "xy", "introducer {intro:?} leaked");
        }
    }

    #[test]
    fn an_eight_bit_introducer_is_not_recognised_because_utf8_owns_those_bytes() {
        // 0x80..=0xbf is the UTF-8 continuation range, and the C1 introducers
        // live inside it. U+1F389 is f0 9f 8e 89 — its second byte IS the APC
        // introducer. Claiming these in a UTF-8 stream eats text.
        let mut demuxer = StreamDemuxer::new();
        let text = screen_text(&demuxer.process_bytes("a\u{1F389}b".as_bytes()));
        assert_eq!(text, "a\u{1F389}b");
    }

    #[test]
    fn the_eight_bit_terminator_is_honoured_inside_a_string() {
        // Safe where the introducer is not: inside a control string the body is
        // opaque bytes, not decoded text, and 0x9c is the ST Warp actually
        // emits. Covered from the other direction by
        // an_eight_bit_string_terminator_ends_a_control_string.
        let mut demuxer = StreamDemuxer::new();
        let text = screen_text(&demuxer.process_bytes(b"a\x1b_apc body\x9cb"));
        assert_eq!(text, "ab");
    }

    #[test]
    fn a_control_string_split_across_two_reads_still_terminates() {
        // A PTY read ends on an arbitrary byte boundary (8192 bytes,
        // session.rs), so a frame routinely straddles two of them.
        let mut demuxer = StreamDemuxer::new();
        let first = demuxer.process_bytes(b"a\x1bP$fpay");
        let second = demuxer.process_bytes(b"load\x1b\\b");
        let mut all = first;
        all.extend(second);
        assert_eq!(screen_text(&all), "ab");
    }

    #[test]
    fn an_escape_inside_a_control_string_does_not_end_it() {
        // Only ESC \ terminates. ESC anything-else is payload.
        let mut demuxer = StreamDemuxer::new();
        let text = screen_text(&demuxer.process_bytes(b"a\x1bP\x1bXstill inside\x1b\\b"));
        assert_eq!(text, "ab");
    }

    #[test]
    fn an_unterminated_control_string_faults_rather_than_growing_forever() {
        let mut demuxer = StreamDemuxer::new();
        let mut input = b"\x1bP".to_vec();
        input.extend(std::iter::repeat(b'x').take(crate::stream::MAX_RECORD_BYTES + 16));
        let events = demuxer.process_bytes(&input);
        assert!(events.iter().any(|e| matches!(
            e,
            DemuxEvent::StreamFault {
                reason: crate::stream::StreamFault::ControlTooLong
            }
        )));
    }

    #[test]
    fn paste_mode_tracks_enable_disable_reset_and_split_sequences() {
        let mut demux = StreamDemuxer::new();
        let mut modes = Vec::new();
        for chunk in [
            b"\x1b[?200".as_slice(),
            b"4h",
            b"\x1b[?1;2004l",
            b"\x1b[?2004h\x1b",
            b"c",
        ] {
            for event in demux.process_bytes(chunk) {
                if let DemuxEvent::BracketedPasteMode { enabled } = event {
                    modes.push(enabled);
                }
            }
        }
        assert_eq!(modes, [true, false, true, false]);
    }

    /// The older tests repeat this filter inline; the UTF-8 cases below need it
    /// several times over.
    fn text_of(events: &[DemuxEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_multibyte_character_split_across_reads_survives() {
        let mut demuxer = StreamDemuxer::new();
        // "é" is C3 A9. An 8192-byte read lands between them often enough to see
        // it during any agent session that prints accented text or box drawing.
        let first = demuxer.process_bytes(b"caf\xc3");
        assert_eq!(
            text_of(&first),
            "caf",
            "a dangling lead byte must be held, not replaced"
        );

        let second = demuxer.process_bytes(b"\xa9 au lait");
        assert_eq!(
            text_of(&second),
            "\u{e9} au lait",
            "the held byte must rejoin its tail"
        );
    }

    #[test]
    fn a_four_byte_emoji_survives_a_split_at_every_interior_offset() {
        // "🎉" is F0 9F 8E 89, so a read can end after one, two or three of them.
        let emoji = "\u{1f389}".as_bytes();
        for split in 1..emoji.len() {
            let mut demuxer = StreamDemuxer::new();
            let first = demuxer.process_bytes(&emoji[..split]);
            let second = demuxer.process_bytes(&emoji[split..]);
            let text = format!("{}{}", text_of(&first), text_of(&second));
            assert_eq!(
                text, "\u{1f389}",
                "a split after {split} byte(s) must still yield the character"
            );
        }
    }

    #[test]
    fn genuinely_invalid_bytes_are_still_replaced() {
        let mut demuxer = StreamDemuxer::new();
        // FF can never begin a UTF-8 sequence. Holding it would stall the stream
        // forever waiting for a continuation that cannot come.
        let events = demuxer.process_bytes(b"ok\xff");
        assert_eq!(
            text_of(&events),
            "ok\u{fffd}",
            "malformed input must not accumulate"
        );
    }

    #[test]
    fn a_character_split_before_an_escape_is_not_held_past_it() {
        let mut demuxer = StreamDemuxer::new();
        // A truncated character followed by an ESC is malformed input, not a read
        // boundary. Holding it here would reorder text against the event.
        let events = demuxer.process_bytes(b"text\xc3\x1b]133;C\x07");
        assert!(events
            .iter()
            .any(|e| matches!(e, DemuxEvent::ExecutionStart)));
        assert!(
            text_of(&events).starts_with("text"),
            "text must still precede the event"
        );
    }

    #[test]
    fn test_osc_133_demuxing() {
        let mut demuxer = StreamDemuxer::new();

        // Feed OSC 133 sequences
        let input = b"\x1b]133;A\x07Hello World\r\n\x1b]133;B\x1b\\\x1b]133;C\x07Running command\r\n\x1b]133;D;0\x07";
        let events = demuxer.process_bytes(input);

        assert!(events.iter().any(|e| matches!(e, DemuxEvent::PromptStart)));
        assert!(events.iter().any(|e| matches!(e, DemuxEvent::CommandStart)));
        assert!(events
            .iter()
            .any(|e| matches!(e, DemuxEvent::ExecutionStart)));
        assert!(events
            .iter()
            .any(|e| matches!(e, DemuxEvent::ExecutionEnd { exit_code: Some(0) })));
    }

    #[test]
    fn test_osc_1337_agent_state() {
        let mut demuxer = StreamDemuxer::new();
        let input = b"\x1b]1337;AgentState=waiting_input\x07";
        let events = demuxer.process_bytes(input);
        assert!(events.iter().any(
            |e| matches!(e, DemuxEvent::AgentState { ref state } if state == "waiting_input")
        ));
    }

    #[test]
    fn unrecognised_osc_is_never_forwarded_to_the_renderer() {
        let mut demuxer = StreamDemuxer::new();
        let input = b"\x1b]0;cleadmon@SER6-MAX:~/Projects\x07\x1b]11;?\x1b\\backend  index.html";
        let events = demuxer.process_bytes(input);
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            text, "backend  index.html",
            "OSC payloads must not reach the screen"
        );
    }

    #[test]
    fn osc_3008_reports_the_working_directory() {
        let mut demuxer = StreamDemuxer::new();
        let input =
            b"\x1b]3008;start=abc;machineid=def;user=x;cwd=/home/me/Projects/Doom Term\x1b\\";
        let events = demuxer.process_bytes(input);
        assert!(events.iter().any(
            |e| matches!(e, DemuxEvent::Cwd { path } if path == "/home/me/Projects/Doom Term")
        ));
    }

    #[test]
    fn osc_7_reports_the_working_directory() {
        let mut demuxer = StreamDemuxer::new();
        let events = demuxer.process_bytes(b"\x1b]7;file://localhost/home/me/src\x07");
        assert!(events
            .iter()
            .any(|e| matches!(e, DemuxEvent::Cwd { path } if path == "/home/me/src")));
    }

    #[cfg(windows)]
    #[test]
    fn osc_7_decodes_native_windows_paths() {
        for (uri, expected) in [
            ("file:///C:/Users/me/Doom%20Term", r"C:\Users\me\Doom Term"),
            (
                "file://server/share/Doom%20Term",
                r"\\server\share\Doom Term",
            ),
            ("file:///C:/literal%2520", r"C:\literal%20"),
        ] {
            let mut demuxer = StreamDemuxer::new();
            let events = demuxer.process_bytes(format!("\x1b]7;{uri}\x07").as_bytes());
            assert!(
                events
                    .iter()
                    .any(|e| matches!(e, DemuxEvent::Cwd { path } if path == expected)),
                "{events:?}"
            );
        }
    }

    #[test]
    fn an_escape_split_across_chunks_is_still_demuxed() {
        let mut demuxer = StreamDemuxer::new();
        let first = demuxer.process_bytes(b"done\x1b");
        let text: String = first
            .iter()
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "done", "a trailing ESC must be held, not emitted");

        let second = demuxer.process_bytes(b"]133;D;0\x07");
        assert!(second
            .iter()
            .any(|e| matches!(e, DemuxEvent::ExecutionEnd { exit_code: Some(0) })));
    }

    /// A terminal that never answers a query leaves the asking program blocked
    /// on its own timeout — 5s per probe in the renderer Bazzite runs at login,
    /// which is what put 15s of dead air in front of every new terminal.
    #[test]
    fn background_colour_query_is_answered() {
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"\x1b]11;?\x1b\\");
        let reply = String::from_utf8(demuxer.take_responses()).unwrap();
        assert_eq!(
            reply, "\x1b]11;rgb:1414/1212/0f0f\x1b\\",
            "must report --ground"
        );
    }

    #[test]
    fn foreground_colour_query_is_answered() {
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"\x1b]10;?\x1b\\");
        let reply = String::from_utf8(demuxer.take_responses()).unwrap();
        assert_eq!(
            reply, "\x1b]10;rgb:d8d8/cbcb/b0b0\x1b\\",
            "must report --ink"
        );
    }

    #[test]
    fn cursor_position_query_is_answered() {
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"\x1b[6n");
        let reply = String::from_utf8(demuxer.take_responses()).unwrap();
        assert_eq!(reply, "\x1b[1;1R", "DSR must get a cursor position report");
    }

    #[test]
    fn device_attributes_are_answered() {
        // The last unanswered probe, and the expensive one: crossterm asks
        // "do you speak the kitty keyboard protocol?" and uses the Primary DA
        // reply as the NO. Silence here is what makes a `codex` start sit for
        // two seconds before it draws anything. Answering as the emulator
        // actually behind this really is — @xterm/headless — is the honest
        // answer and the fast one.
        for query in [&b"\x1b[c"[..], &b"\x1b[0c"[..]] {
            let mut demuxer = StreamDemuxer::new();
            demuxer.process_bytes(query);
            assert_eq!(
                String::from_utf8(demuxer.take_responses()).unwrap(),
                "\x1b[?1;2c",
                "Primary DA must be answered"
            );
        }
        for query in [&b"\x1b[>c"[..], &b"\x1b[>0c"[..]] {
            let mut demuxer = StreamDemuxer::new();
            demuxer.process_bytes(query);
            assert_eq!(
                String::from_utf8(demuxer.take_responses()).unwrap(),
                "\x1b[>0;276;0c",
                "Secondary DA must be answered"
            );
        }
    }

    #[test]
    fn a_device_status_report_says_the_terminal_is_well() {
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"\x1b[5n");
        assert_eq!(
            String::from_utf8(demuxer.take_responses()).unwrap(),
            "\x1b[0n",
            "DSR 5 asks after our health, not our cursor"
        );
    }

    #[test]
    fn the_keyboard_protocol_probe_is_left_unanswered_rather_than_claimed() {
        // We do not speak the kitty keyboard protocol, and saying otherwise
        // would make an agent encode every ambiguous key — Escape included —
        // in a form this terminal never sends. Ignoring `CSI ? u` while
        // answering Primary DA is exactly how a terminal declines: the asker
        // takes the DA reply as its NO and falls back, immediately.
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"\x1b[?u");
        assert!(demuxer.take_responses().is_empty());
        demuxer.process_bytes(b"\x1b[c");
        assert_eq!(
            String::from_utf8(demuxer.take_responses()).unwrap(),
            "\x1b[?1;2c"
        );
    }

    #[test]
    fn a_query_is_not_echoed_to_the_renderer() {
        let mut demuxer = StreamDemuxer::new();
        let events = demuxer.process_bytes(b"\x1b[6nready");
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            text, "ready",
            "a query is for the terminal, never for the screen"
        );
    }

    #[test]
    fn responses_are_drained_once() {
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"\x1b[6n");
        assert!(!demuxer.take_responses().is_empty());
        assert!(
            demuxer.take_responses().is_empty(),
            "draining must clear the queue"
        );
    }

    #[test]
    fn a_query_split_across_reads_is_still_answered() {
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"\x1b]11");
        demuxer.process_bytes(b";?\x1b\\");
        assert!(
            !demuxer.take_responses().is_empty(),
            "a probe that straddles a read boundary must still get an answer"
        );
    }

    #[test]
    fn ordinary_traffic_produces_no_responses() {
        let mut demuxer = StreamDemuxer::new();
        demuxer.process_bytes(b"\x1b]133;A\x07$ ls\r\n\x1b[0mfile.txt\r\n");
        assert!(
            demuxer.take_responses().is_empty(),
            "we must only answer real queries, never chatter at the shell"
        );
    }

    #[test]
    fn the_prompt_and_the_echoed_command_reach_the_screen() {
        // The regression this is here to stop from coming back: everything
        // between OSC 133;A and OSC 133;C used to be dropped on the floor, so a
        // terminal rendered command output and nothing else. No prompt, and no
        // sight of what you had just typed — "you cannot even read input text".
        let mut demuxer = StreamDemuxer::new();
        let events = demuxer.process_bytes(
            b"\x1b]133;A\x07me@host:/tmp$ \x1b]133;B\x07echo hi\r\n\x1b]133;C\x07hi\r\n\x1b]133;D;0\x07",
        );

        let rendered: String = events
            .iter()
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.as_str()),
                _ => None,
            })
            .collect();

        assert!(
            rendered.contains("me@host:/tmp$"),
            "the prompt: {rendered:?}"
        );
        assert!(
            rendered.contains("echo hi"),
            "the echoed command: {rendered:?}"
        );
        assert!(rendered.contains("hi"), "the output: {rendered:?}");

        // The boundaries are still reported. They are what turn marks and exit
        // codes are built from; only the withholding of text is gone.
        assert!(events.iter().any(|e| matches!(e, DemuxEvent::PromptStart)));
        assert!(events.iter().any(|e| matches!(e, DemuxEvent::CommandStart)));
    }

    #[test]
    fn an_inline_agent_prompt_is_not_suppressed_for_want_of_alt_screen() {
        // The old gate let text through only when `tui_active` was set. Claude
        // Code, Codex and Antigravity all draw inline and never set DECSET
        // 1049, so for precisely the sessions this app exists to host, nothing
        // typed at the agent's prompt was ever drawn.
        let mut demuxer = StreamDemuxer::new();
        let events = demuxer.process_bytes(b"\x1b]133;A\x07> \x1b]133;B\x07what is 2+2\r\n");
        let rendered: String = events
            .iter()
            .filter_map(|e| match e {
                DemuxEvent::Output { data } => Some(data.as_str()),
                _ => None,
            })
            .collect();
        assert!(rendered.contains("what is 2+2"), "{rendered:?}");
    }

    #[test]
    fn test_decset_1049_tui_mode() {
        let mut demuxer = StreamDemuxer::new();

        // Enter alternate buffer
        let enter = b"\x1b[?1049h";
        let events = demuxer.process_bytes(enter);
        assert!(events
            .iter()
            .any(|e| matches!(e, DemuxEvent::TuiMode { active: true })));

        // Exit alternate buffer
        let exit = b"\x1b[?1049l";
        let events2 = demuxer.process_bytes(exit);
        assert!(events2
            .iter()
            .any(|e| matches!(e, DemuxEvent::TuiMode { active: false })));
    }
    #[test]
    fn overlong_control_records_fault_once_without_fabricating_a_tail() {
        for prefix in [b"\x1b[".as_slice(), b"\x1b]".as_slice()] {
            let mut demuxer = StreamDemuxer::new();
            let mut events = demuxer.process_bytes(prefix);
            // All bytes are intermediate/parameter bytes, so neither record
            // terminates. Split reads exercise retained accumulator state.
            for _ in 0..9 {
                events.extend(demuxer.process_bytes(&vec![b'1'; 8192]));
            }
            let faults: Vec<_> = events
                .iter()
                .filter(|event| serde_json::to_value(event).unwrap()["type"] == "StreamFault")
                .collect();
            assert_eq!(faults.len(), 1, "overlong control must explicitly fault");
            assert!(!events
                .iter()
                .any(|event| matches!(event, DemuxEvent::Output { .. })));
            assert!(demuxer
                .process_bytes(b"mnot a continuous screen\x07\x1b[?2004h")
                .is_empty());
            assert!(demuxer.take_responses().is_empty());
        }
    }
}
