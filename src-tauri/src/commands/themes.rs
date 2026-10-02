use crate::{
    error::{AppError, Result},
    themes,
};
use serde_json::Value;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeResult {
    pub id: String,
    pub json: Value,
}

#[tauri::command]
pub async fn themes_list() -> Result<Vec<themes::Theme>> {
    let dir = themes::themes_dir()?;
    tauri::async_runtime::spawn_blocking(move || themes::list(&dir))
        .await
        .map_err(|err| AppError::Channel(err.to_string()))?
}

#[tauri::command]
pub async fn theme_import(source_path: String) -> Result<ThemeResult> {
    let dir = themes::themes_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let theme = themes::import(&dir, std::path::Path::new(&source_path))?;
        Ok(ThemeResult {
            id: theme.id,
            json: theme.json,
        })
    })
    .await
    .map_err(|err| AppError::Channel(err.to_string()))?
}

#[tauri::command]
pub async fn theme_delete(id: String) -> Result<()> {
    let dir = themes::themes_dir()?;
    tauri::async_runtime::spawn_blocking(move || themes::delete(&dir, &id))
        .await
        .map_err(|err| AppError::Channel(err.to_string()))?
}
