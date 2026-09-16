//! The Doom Term PTY layer: one implementation, two shells.
//!
//! The standalone WebSocket daemon (`backend/`) and the Tauri desktop app
//! (`src-tauri/`) both consume this crate. They differ only in transport, so
//! Both consume the same bounded journal and exact attachment primitives;
//! transport callbacks do not live in this crate.

pub mod demuxer;
pub mod foreground;
/// Windows only: the process-tree equivalent of a Unix process group.
#[cfg(windows)]
pub mod job;
pub mod paste;
pub mod process_io;
mod runtime_files;
pub mod session;
pub mod shell_integration;
pub mod stream;
pub mod tmux;

pub use demuxer::{DemuxEvent, StreamDemuxer};
pub use foreground::{
    classify_agent, detect_isolation, detect_worktree, foreground_command, AgentIdentity,
};
pub use session::{anchor_working_directory, expand_path, home_dir, PtySession, SessionInfo};
