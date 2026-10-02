use std::{io::Write, path::Path};

use crate::{
    error::{AppError, Result},
    fs::encoding::{self, Eol},
};

pub fn write_file(
    path: &Path,
    utf8: &[u8],
    encoding: &str,
    eol: Eol,
    has_bom: bool,
    eol_map: Option<&str>,
    allow_lossy: bool,
) -> Result<u64> {
    let text = std::str::from_utf8(utf8).map_err(|err| AppError::Encoding(err.to_string()))?;
    let data = encoding::encode(text, encoding, eol, has_bom, eol_map, allow_lossy)?;
    atomic_write(path, &data)?;
    Ok(data.len() as u64)
}

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| AppError::InvalidArgument("path must have a parent directory".into()))?;
    let mut temp = tempfile::Builder::new()
        .prefix(".boshu-")
        .tempfile_in(parent)?;
    temp.write_all(data)?;
    temp.as_file().sync_all()?;
    let temp = temp.into_temp_path(); // Close the file handle before Windows replaces it.
    #[cfg(windows)]
    if path.exists() && replace_file(path, &temp).is_ok() {
        return Ok(());
    }
    temp.persist(path).map_err(|err| AppError::Io(err.error))?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(target: &Path, replacement: &Path) -> windows::core::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::ReplaceFileW};
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let replacement: Vec<u16> = replacement
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // With no backup, Windows preserves the replaced file's ACL and attributes.
    unsafe {
        ReplaceFileW(
            PCWSTR(target.as_ptr()),
            PCWSTR(replacement.as_ptr()),
            PCWSTR::null(),
            Default::default(),
            None,
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_replaces_without_leftover_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document.txt");
        assert_eq!(
            write_file(&path, b"one\ntwo\n", "utf-8", Eol::Crlf, false, None, false).unwrap(),
            10
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"one\r\ntwo\r\n");
        write_file(
            &path,
            "中文".as_bytes(),
            "utf-16le",
            Eol::Lf,
            true,
            None,
            false,
        )
        .unwrap();
        let (text, _, _, _, _) = encoding::decode_bytes(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(text, "中文");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rejected_encoding_does_not_change_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document.txt");
        std::fs::write(&path, b"original").unwrap();
        assert!(write_file(&path, "😀".as_bytes(), "gbk", Eol::Lf, false, None, false).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"original");
    }
}
