//! Keep native windows hidden until their own frontend is ready, with a visible error fallback.

use std::{collections::HashMap, sync::Mutex, time::Duration};

use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::error::{AppError, Result};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Waiting,
    Ready,
    Failed,
}

#[derive(Default)]
pub struct StartupState(Mutex<HashMap<String, Entry>>);

struct Entry {
    phase: Phase,
    focus_requested: bool,
}

impl StartupState {
    pub fn register(&self, label: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|error| AppError::Channel(error.to_string()))?
            .insert(
                label.into(),
                Entry {
                    phase: Phase::Waiting,
                    focus_requested: false,
                },
            );
        Ok(())
    }

    pub fn is_ready(&self, label: &str) -> bool {
        self.0
            .lock()
            .map(|states| {
                states
                    .get(label)
                    .is_some_and(|entry| entry.phase == Phase::Ready)
            })
            .unwrap_or(false)
    }

    pub fn is_failed(&self, label: &str) -> bool {
        self.phase(label).ok() == Some(Phase::Failed)
    }

    fn phase(&self, label: &str) -> Result<Phase> {
        self.0
            .lock()
            .map_err(|error| AppError::Channel(error.to_string()))?
            .get(label)
            .map(|entry| entry.phase)
            .ok_or_else(|| {
                AppError::InvalidArgument("startup window is no longer available".into())
            })
    }

    fn complete(&self, label: &str, phase: Phase) -> Result<()> {
        let mut states = self
            .0
            .lock()
            .map_err(|error| AppError::Channel(error.to_string()))?;
        let current = states.get_mut(label).ok_or_else(|| {
            AppError::InvalidArgument("startup window is no longer available".into())
        })?;
        if current.phase == Phase::Waiting {
            current.phase = phase;
        }
        Ok(())
    }

    pub fn closed(&self, label: &str) {
        if let Ok(mut states) = self.0.lock() {
            states.remove(label);
        }
    }
}

/// Explicit second-instance focus is deferred while hidden; ordinary duplicate ready is inert.
pub fn focus_when_ready(window: &WebviewWindow) {
    let state = window.app_handle().state::<StartupState>();
    let ready = if let Ok(mut states) = state.0.lock() {
        match states.get_mut(window.label()) {
            Some(entry) if entry.phase == Phase::Waiting => {
                entry.focus_requested = true;
                false
            }
            Some(_) => true,
            None => false,
        }
    } else {
        false
    };
    if ready {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Run only on the native main thread, which serializes duplicate ready/error/watchdog calls.
fn reveal(window: &WebviewWindow) -> Result<()> {
    let state = window.app_handle().state::<StartupState>();
    match state.phase(window.label())? {
        Phase::Ready => return Ok(()), // Do not restore, unminimize, or steal focus a second time.
        Phase::Failed => return Err(AppError::Channel("window startup failed".into())),
        Phase::Waiting => {}
    }
    window
        .show()
        .map_err(|error| AppError::Channel(error.to_string()))?;
    if !window
        .is_visible()
        .map_err(|error| AppError::Channel(error.to_string()))?
    {
        return Err(AppError::Channel(
            "startup window could not be shown".into(),
        ));
    }
    crate::window_state::finish_restore(window)?;
    state.complete(window.label(), Phase::Ready)?;
    let focus = state
        .0
        .lock()
        .map(|mut states| {
            states
                .get_mut(window.label())
                .map(|entry| std::mem::take(&mut entry.focus_requested))
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if focus {
        let _ = window.set_focus();
    }
    if std::env::var_os("BOSHU_STARTUP_TRACE").is_some_and(|value| value == "1") {
        eprintln!("Boshu startup ready: {}", window.label());
    }
    Ok(())
}

pub fn watch(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    // This is a failure deadline, never a delay on the successful startup path. It also
    // catches a missing/broken JS module or a stuck IPC before the frontend can report it.
    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_TIMEOUT);
        let task_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = task_app.get_webview_window(&label) {
                fail(&window, "Startup did not complete. Please close this window and try again.\n启动未完成，请关闭此窗口后重试。");
            }
        });
    });
}

pub fn fail(window: &WebviewWindow, message: &str) {
    let state = window.app_handle().state::<StartupState>();
    if state.phase(window.label()).ok() != Some(Phase::Waiting) {
        return;
    }
    let _ = state.complete(window.label(), Phase::Failed);
    // Failed frontends cannot acquire transferred drafts, even if a late JS task continues.
    crate::window::cancel_failed_startup(window.app_handle(), window.label());
    let message: String = message.chars().take(2048).collect();
    eprintln!("Boshu startup failed: {}: {message}", window.label());
    let literal = serde_json::to_string(&message).unwrap_or_else(|_| "\"Startup failed\"".into());
    let script = format!(
        "(() => {{ if (document.documentElement.dataset.startup === 'failed') return; \
         document.documentElement.dataset.startup = 'failed'; \
         document.documentElement.style.setProperty('background', '#202020', 'important'); \
         document.body.style.cssText = 'margin:0;padding:40px;box-sizing:border-box;min-height:100vh;background:#202020;color:#fff;font:16px system-ui;white-space:pre-wrap'; \
         document.body.textContent = {literal}; }})()"
    );
    let _ = window.eval(&script);
    let _ = window.show();
    let _ = window.is_visible();
    window
        .app_handle()
        .dialog()
        .message(message)
        .title("silk book — Startup failed / 启动失败")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

#[tauri::command]
pub async fn window_frontend_ready(window: WebviewWindow) -> Result<()> {
    let (sent, received) = std::sync::mpsc::sync_channel(1);
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        let _ = sent.send(reveal(&window));
    })
    .map_err(|error| AppError::Channel(error.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        received
            .recv()
            .map_err(|error| AppError::Channel(error.to_string()))?
    })
    .await
    .map_err(|error| AppError::Channel(error.to_string()))?
}

#[tauri::command]
pub fn window_startup_failed(window: WebviewWindow, message: String) {
    let app = window.app_handle().clone();
    let _ = app.run_on_main_thread(move || fail(&window, &message));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_waiting_windows_can_become_ready_or_fail_and_closed_windows_stay_closed() {
        let state = StartupState::default();
        state.register("main").unwrap();
        assert!(!state.is_ready("main"));
        state.complete("main", Phase::Ready).unwrap();
        state.complete("main", Phase::Failed).unwrap();
        assert!(state.is_ready("main"));

        state.register("win-1").unwrap();
        state.complete("win-1", Phase::Failed).unwrap();
        state.complete("win-1", Phase::Ready).unwrap();
        assert_eq!(state.phase("win-1").unwrap(), Phase::Failed);
        assert!(!state.is_ready("win-1"));
        state.closed("win-1");
        assert!(state.complete("win-1", Phase::Ready).is_err());
        assert!(state.phase("win-1").is_err());
        assert!(!state.is_ready("win-1"));
    }
}
