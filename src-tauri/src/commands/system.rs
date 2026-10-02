use crate::{
    error::{AppError, Result},
    system,
};

#[tauri::command]
pub fn list_encodings() -> Vec<crate::fs::encoding::EncodingInfo> {
    crate::fs::encoding::list_encodings()
}

#[tauri::command]
pub fn ansi_encoding() -> Result<crate::fs::encoding::AnsiEncodingInfo> {
    let (code_page, encoding) = crate::fs::encoding::ansi_encoding()?;
    Ok(crate::fs::encoding::AnsiEncodingInfo {
        code_page,
        id: crate::fs::encoding::encoding_id(encoding),
    })
}

#[tauri::command]
pub async fn spell_check(words: Vec<String>) -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || system::spell_check(&words))
        .await
        .map_err(|err| AppError::Channel(err.to_string()))?
}

#[tauri::command]
pub fn system_locale() -> Result<String> {
    system::system_locale()
}
