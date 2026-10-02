use crate::{error::Result, resources};

#[tauri::command]
pub fn bundled_fonts(app: tauri::AppHandle) -> Result<Vec<resources::BundledFont>> {
    resources::bundled_fonts(&app)
}
