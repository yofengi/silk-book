use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use crate::error::{AppError, Result};

const MAX_THEME_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub id: String,
    file_name: String,
    pub json: Value,
}

pub fn themes_dir() -> Result<PathBuf> {
    Ok(crate::settings::app_config_dir()?.join("themes"))
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AppError::InvalidArgument("invalid theme id".into()));
    }
    Ok(())
}

fn sanitized_id(stem: &str) -> String {
    let id: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(96)
        .collect();
    let id = id.trim_matches('-');
    if id.is_empty() {
        "theme".into()
    } else {
        id.into()
    }
}

fn parse(bytes: &[u8]) -> Result<Value> {
    let value: Value = serde_json::from_slice(bytes)?;
    if !value.is_object() {
        return Err(AppError::InvalidArgument(
            "theme must be a JSON object".into(),
        ));
    }
    Ok(value)
}

fn read_theme(path: &Path) -> Result<(Value, Vec<u8>)> {
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > MAX_THEME_BYTES {
        return Err(AppError::InvalidArgument("theme exceeds 256 KiB".into()));
    }
    let mut bytes = Vec::new();
    file.take(MAX_THEME_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_THEME_BYTES {
        return Err(AppError::InvalidArgument("theme exceeds 256 KiB".into()));
    }
    Ok((parse(&bytes)?, bytes))
}

pub fn list(dir: &Path) -> Result<Vec<Theme>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut themes = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_id(id).is_err() {
            continue;
        }
        themes.push(Theme {
            id: id.into(),
            file_name: entry.file_name().to_string_lossy().into_owned(),
            json: read_theme(&path)?.0,
        });
    }
    themes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(themes)
}

pub fn import(dir: &Path, source: &Path) -> Result<Theme> {
    if !source.is_file()
        || !source
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("json"))
    {
        return Err(AppError::InvalidArgument(
            "sourcePath must be an existing JSON file".into(),
        ));
    }
    let (value, bytes) = read_theme(source)?;
    let base = sanitized_id(
        source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("theme"),
    );
    fs::create_dir_all(dir)?;
    for number in 0..u32::MAX {
        let id = if number == 0 {
            base.clone()
        } else {
            format!("{base}-{number}")
        };
        let file_name = format!("{id}.json");
        let path = dir.join(&file_name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut dest) => {
                use std::io::Write;
                if let Err(err) = dest.write_all(&bytes) {
                    drop(dest);
                    let _ = fs::remove_file(&path);
                    return Err(err.into());
                }
                return Ok(Theme {
                    id,
                    file_name,
                    json: value,
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Err(AppError::InvalidArgument("theme id space exhausted".into()))
}

pub fn delete(dir: &Path, id: &str) -> Result<()> {
    validate_id(id)?;
    let path = dir.join(format!("{id}.json"));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_dedup_list_and_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("my theme.json");
        fs::write(&source, r##"{"colors":{"foreground":"#fff"}}"##).unwrap();
        let dest = tmp.path().join("themes");
        assert_eq!(import(&dest, &source).unwrap().id, "my-theme");
        assert_eq!(import(&dest, &source).unwrap().id, "my-theme-1");
        assert_eq!(list(&dest).unwrap().len(), 2);
        delete(&dest, "my-theme").unwrap();
        assert_eq!(list(&dest).unwrap().len(), 1);
        assert!(delete(&dest, "../bad").is_err());
        fs::write(&source, "[]").unwrap();
        assert!(import(&dest, &source).is_err());
        fs::write(&source, vec![b'x'; MAX_THEME_BYTES as usize + 1]).unwrap();
        assert!(import(&dest, &source).is_err());
    }
}
