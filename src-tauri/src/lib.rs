pub mod associations;
pub mod commands;
pub mod error;
pub mod fonts;
pub mod fs;
#[cfg(target_os = "macos")]
mod macos;
pub mod os;
pub mod resources;
pub mod settings;
pub mod startup;
pub mod system;
pub mod themes;
pub mod updates;
pub mod window;
pub mod window_state;

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(command) = associations::parse_cli_args(&args) {
        let result = match command {
            Ok(associations::CliAssociationCommand::Register(exts)) => associations::register(exts),
            Ok(associations::CliAssociationCommand::Unregister(exts)) => {
                associations::unregister(exts)
            }
            Ok(associations::CliAssociationCommand::UnregisterAll) => {
                associations::unregister_all()
            }
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            eprintln!("Boshu association command failed: {error}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }

    use tauri::{Emitter, Manager, WindowEvent};

    let cwd = std::env::current_dir().unwrap_or_default();
    let initial_files = window::initial_files(&args, &cwd);
    let state = window::WindowState::new(initial_files);
    tauri::Builder::default()
        .manage(commands::file::ReadRegistry::default())
        .manage(settings::SettingsState::default())
        .manage(updates::UpdateState::default())
        .manage(window_state::WindowGeometryState::default())
        .manage(startup::StartupState::default())
        .manage(state)
        .on_window_event(|window, event| {
            window_state::on_window_event(window, event);
            let state = window.app_handle().state::<window::WindowState>();
            match event {
                WindowEvent::Focused(true) => {
                    if let Ok(mut focused) = state.focused.lock() {
                        *focused = window.label().to_owned();
                    }
                }
                WindowEvent::Destroyed => {
                    window::closed(window.app_handle(), window.label());
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let files = window::initial_files(&args, std::path::Path::new(&cwd));
            let state = app.state::<window::WindowState>();
            let focused = state
                .focused
                .lock()
                .map(|focused| focused.clone())
                .unwrap_or_else(|_| "main".into());
            let labels: Vec<_> = app.webview_windows().into_keys().collect();
            if let Some(target) = window::focused_label(&focused, &labels) {
                let Some(window) = app.get_webview_window(&target) else {
                    return;
                };
                // A second instance must not reveal a frontend that is still booting.
                startup::focus_when_ready(&window);
                if !files.is_empty() {
                    // UI 订阅 open-files 前启动的第二实例文件留给 window_init，避免事件丢失。
                    if let Ok(mut pending) = state.pending.lock() {
                        if let Some(init) = pending.get_mut(&target) {
                            init.files.extend(files);
                            return;
                        }
                    }
                    let _ = app.emit_to(
                        tauri::EventTarget::webview_window(target),
                        "open-files",
                        files,
                    );
                }
            } else {
                // 即使处于最后窗口关闭的边界，建窗也不能从 Windows UI 回调中同步调用。
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = window::create_window(
                        &app,
                        window::WindowOpenOptions {
                            files: Some(files),
                            transfer_token: None,
                            x: None,
                            y: None,
                        },
                        "",
                    );
                });
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            let result = (|| -> std::result::Result<(), Box<dyn std::error::Error>> {
                for window in app.webview_windows().values() {
                    app.state::<startup::StartupState>()
                        .register(window.label())?;
                    startup::watch(window);
                }
                #[cfg(target_os = "macos")]
                macos::setup(app.handle())?;
                let dir = resources::fonts_dir(app.handle())?;
                app.asset_protocol_scope().allow_directory(&dir, false)?;
                window_state::restore_main(app.handle())?;
                Ok(())
            })();
            if let Err(error) = result {
                for window in app.webview_windows().values() {
                    startup::fail(
                        window,
                        &format!("silk book could not start / 帛书启动失败\n{error}"),
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::file::file_stat,
            commands::file::read_file,
            commands::file::cancel_read,
            commands::file::write_file,
            commands::file::allow_asset_dir,
            commands::settings::read_settings,
            commands::settings::write_settings,
            commands::settings::settings_patch,
            updates::updates_info,
            updates::updates_check,
            updates::updates_open,
            commands::os::os_build,
            commands::resources::bundled_fonts,
            commands::fonts::list_system_fonts,
            commands::associations::file_assoc_status,
            commands::associations::file_assoc_register,
            commands::associations::file_assoc_unregister,
            commands::associations::open_default_apps_settings,
            commands::themes::themes_list,
            commands::themes::theme_import,
            commands::themes::theme_delete,
            commands::system::list_encodings,
            commands::system::ansi_encoding,
            commands::system::spell_check,
            commands::system::system_locale,
            window::window_open,
            window::window_init,
            startup::window_frontend_ready,
            startup::window_startup_failed,
            window::window_drop_target,
            window::tab_transfer_put,
            window::tab_transfer_take,
            window::tab_transfer_send,
            window::tab_transfer_reject,
            window::tab_transfer_accept,
            window::tab_transfer_status,
            window::tab_transfer_cancel,
            window::app_request_quit,
            window::app_quit_reply,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Boshu");
}
