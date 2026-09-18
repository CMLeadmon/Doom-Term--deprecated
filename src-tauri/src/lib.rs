pub mod commands;
pub mod daemon;
mod daemon_env;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));

    // Where the daemon will be, decided before the app is built because the
    // webview has to be told in a script that runs before its own. The daemon
    // itself is started in setup(), which is where the app handle exists.
    let plan = daemon::plan();
    let port = plan.port();

    let app = tauri::Builder::default()
        // Must be registered first: it decides whether this process is the app
        // or a second launch that should hand off and exit.
        //
        // Two windows were never two independent apps. The second one attaches
        // to the first's daemon, and then the first is closed — taking the
        // daemon with it, because it owns the child — and the survivor is a
        // window whose terminals are all dead with nothing to say why. Focus
        // the window that already exists instead.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // The frontend can no longer hardcode the daemon port: a stranger on
        // the default moves the daemon elsewhere. An initialization script is
        // the only channel guaranteed to land before the page's own scripts,
        // and a plugin is how a config-declared window gets one — building the
        // window in code to attach a script instead makes decorum position the
        // macOS traffic lights against a window that has none yet, which is a
        // null dereference and an abort, not a degraded titlebar.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("doom-term-daemon-port")
                .js_init_script(format!("globalThis.__DOOM_TERM_DAEMON_PORT__ = {port};"))
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_decorum::init())
        .setup(move |app| {
            // The daemon is bundled, not something the user starts. A failure
            // here is not fatal: the UI reconnects on a timer, so the window
            // still opens and reports the problem rather than refusing to run.
            if let Err(e) = daemon::start(app.handle(), plan) {
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
