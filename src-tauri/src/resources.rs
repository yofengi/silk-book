use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::error::{AppError, Result};

// Kept for source compatibility with older integrations; window::WindowState is authoritative.
#[deprecated(note = "use window::WindowState and window_init")]
pub struct InitialOpenFiles(pub Vec<String>);

const FONT_FILES: [(&str, u16, &str); 4] = [
    ("MapleMono-NF-CN-Regular.woff2", 400, "normal"),
    ("MapleMono-NF-CN-Bold.woff2", 700, "normal"),
    ("MapleMono-NF-CN-Italic.woff2", 400, "italic"),
    ("MapleMono-NF-CN-BoldItalic.woff2", 700, "italic"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledFont {
    family: &'static str,
    weight: u16,
    style: &'static str,
    format: &'static str,
    path: String,
}

pub fn fonts_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|err| AppError::InvalidArgument(err.to_string()))?
        .join("fonts");
    Ok(dunce::simplified(&path).to_path_buf())
}

pub fn bundled_fonts(app: &tauri::AppHandle) -> Result<Vec<BundledFont>> {
    let dir = fonts_dir(app)?;
    FONT_FILES
        .iter()
        .map(|(name, weight, style)| {
            let path = dir.join(name);
            if !path.is_file() {
                return Err(AppError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("bundled font missing: {}", path.display()),
                )));
            }
            Ok(BundledFont {
                family: "Maple Mono NF CN",
                weight: *weight,
                style,
                format: "woff2",
                path: dunce::simplified(&path).to_string_lossy().into_owned(),
            })
        })
        .collect()
}

pub fn open_files(args: &[String], cwd: &Path) -> Vec<String> {
    let mut files = Vec::new();
    for arg in args.iter().skip(1) {
        let path = Path::new(arg);
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        if let Ok(canonical) = dunce::canonicalize(absolute) {
            if canonical.is_file() {
                let name = canonical.to_string_lossy().into_owned();
                if !files.contains(&name) {
                    files.push(name);
                }
            }
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_missing_and_directories_and_deduplicates() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"a").unwrap();
        let args = vec![
            "boshu.exe".into(),
            "a.txt".into(),
            "missing".into(),
            "a.txt".into(),
            ".".into(),
        ];
        assert_eq!(open_files(&args, dir.path()).len(), 1);
    }
}
