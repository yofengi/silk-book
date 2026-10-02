use crate::{
    error::{AppError, Result},
    fonts,
};

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(fonts::list_system_fonts)
        .await
        .map_err(|err| AppError::Channel(err.to_string()))?
}
