use serde::Deserialize;
use serde_json::{Map, Value};
use tauri::{Emitter, Manager, State, WebviewWindow};

use crate::{
    error::{AppError, Result},
    settings,
};

#[derive(Deserialize)]
pub struct SettingsPatch {
    pub set: Option<Map<String, Value>>,
    pub remove: Option<Vec<String>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsChanged {
    #[serde(flatten)]
    snapshot: settings::SettingsSnapshot,
    source: String,
}

#[tauri::command]
pub async fn read_settings() -> Result<Value> {
    let path = settings::settings_path()?;
    tauri::async_runtime::spawn_blocking(move || settings::load(&path))
        .await
        .map_err(|err| AppError::Channel(err.to_string()))?
}

#[tauri::command]
pub async fn write_settings(
    settings_value: Value,
    window: WebviewWindow,
    lock: State<'_, settings::SettingsState>,
) -> Result<()> {
    let path = settings::settings_path()?;
    let state = (*lock).clone();
    let app = window.app_handle().clone();
    let source = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .replace_and_publish(&path, settings_value, |snapshot| {
                publish(&app, &source, snapshot);
            })
            .map(|_| ())
    })
    .await
    .map_err(|err| AppError::Channel(err.to_string()))?
}

#[tauri::command]
pub async fn settings_patch(
    patch: SettingsPatch,
    window: WebviewWindow,
    lock: State<'_, settings::SettingsState>,
) -> Result<settings::SettingsSnapshot> {
    let path = settings::settings_path()?;
    let state = (*lock).clone();
    let app = window.app_handle().clone();
    let source = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        state.patch_and_publish(&path, patch.set, patch.remove, |snapshot| {
            publish(&app, &source, snapshot);
        })
    })
    .await
    .map_err(|err| AppError::Channel(err.to_string()))?
}

pub(crate) fn publish(app: &tauri::AppHandle, source: &str, snapshot: &settings::SettingsSnapshot) {
    crate::window_state::apply_settings(app, &snapshot.value);
    // Persistence already committed; a transport failure must not report a failed disk write.
    if let Err(err) = app.emit(
        "settings-changed",
        SettingsChanged {
            snapshot: snapshot.clone(),
            source: source.to_owned(),
        },
    ) {
        eprintln!("settings broadcast failed: {err}");
    }
}
