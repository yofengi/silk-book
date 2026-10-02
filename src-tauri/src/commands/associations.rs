use crate::{
    associations,
    error::{AppError, Result},
};

#[tauri::command]
pub async fn file_assoc_status(exts: Vec<String>) -> Result<Vec<associations::AssociationStatus>> {
    tauri::async_runtime::spawn_blocking(move || associations::status(exts))
        .await
        .map_err(|err| AppError::Channel(err.to_string()))?
}

#[tauri::command]
pub async fn file_assoc_register(exts: Vec<String>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || associations::register(exts))
        .await
        .map_err(|err| AppError::Channel(err.to_string()))?
}

#[tauri::command]
pub async fn file_assoc_unregister(exts: Vec<String>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || associations::unregister(exts))
        .await
        .map_err(|err| AppError::Channel(err.to_string()))?
}

#[tauri::command]
pub fn open_default_apps_settings() -> Result<()> {
    associations::open_settings()
}
