//! Commands the webview can invoke.
//!
//! Only directory browsing lives here. Everything to do with PTYs is the
//! bundled daemon's job, reached over the loopback WebSocket in `ptyClient`,
//! so this shell deliberately has no PTY surface of its own to drift from it.

use serde::{Deserialize, Serialize};

use doom_term_pty::expand_path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_git_repo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryListing {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<DirectoryEntry>,
}

#[tauri::command]
pub async fn browse_directory(path: Option<String>) -> Result<DirectoryListing, String> {
    let target_str = path.unwrap_or_else(|| "~".to_string());
    let target_path = expand_path(&target_str);
    let dir = if target_path.exists() && target_path.is_dir() {
        target_path
    } else if let Ok(home) = std::env::var("HOME") {
        std::path::PathBuf::from(home)
    } else {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"))
    };

    let current_path = dir.to_string_lossy().to_string();
    let parent_path = dir.parent().map(|p| p.to_string_lossy().to_string());

    let mut entries = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&dir) {
        for entry in read_dir.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.starts_with('.') && file_name != ".git" {
                continue;
            }
            let path_buf = entry.path();
            let is_dir = path_buf.is_dir();
            let is_git_repo = is_dir && path_buf.join(".git").exists();
            entries.push(DirectoryEntry {
                name: file_name,
                path: path_buf.to_string_lossy().to_string(),
                is_dir,
                is_git_repo,
            });
        }
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(DirectoryListing {
        current_path,
        parent_path,
        entries,
    })
}

#[tauri::command]
pub async fn send_desktop_notification(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("notify-send")
            .args(["-a", "Doom Term", "-u", "normal", &title, &body])
            .spawn();
    }
    Ok(())
}
