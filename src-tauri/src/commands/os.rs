#[tauri::command]
pub fn os_build() -> u32 {
    crate::os::build_number()
}
