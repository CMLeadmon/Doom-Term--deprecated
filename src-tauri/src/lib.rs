pub mod commands;
pub mod daemon;
mod daemon_env;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // The daemon is bundled, not something the user starts. A failure
            // here is not fatal: the UI reconnects on a timer, so the window
            // still opens and reports the problem rather than refusing to run.
            if let Err(e) = daemon::start(app.handle()) {
                log::error!("could not start the bundled PTY daemon: {}", e);
            }

            // The webview is the entire product surface, and a packaged app has
            // no console: a frontend that throws on startup is indistinguishable
            // from a backend that sent nothing. Opening the inspector needs a
            // hand on the keyboard, which is no use when the machine that has
            // the bug is not the machine with the debugger — so let an env var
            // do it. Off by default; this is a diagnostic, not a feature.
            if std::env::var("DOOM_TERM_DEVTOOLS").is_ok() {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                    log::info!("web inspector opened (DOOM_TERM_DEVTOOLS)");
                } else {
                    log::warn!("DOOM_TERM_DEVTOOLS set but no 'main' webview window");
                }
            }

            log::info!("Doom Term Tauri backend initialized successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::browse_directory,
            commands::send_desktop_notification
        ])
        .build(tauri::generate_context!())
        .expect("error while building Doom Term application");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            // On Linux and macOS, take the daemon down with the app. The work
            // is not in the daemon — tmux holds it — so an orphan would only
            // hold the port and silently become the daemon of the next launch.
            //
            // On Windows the work IS in the daemon: no tmux, and the ConPTY
            // dies with it. Becoming the daemon of the next launch is exactly
            // what we want there, and daemon::start already attaches to a live
            // one rather than spawning a second. It is not left forever:
            // DOOM_TERM_IDLE_EXIT_SECS gives it a grace period with no client,
            // after which it exits and its job objects end the process trees.
            #[cfg(not(windows))]
            daemon::stop(handle);
            #[cfg(windows)]
            let _ = handle;
        }
    });
}
