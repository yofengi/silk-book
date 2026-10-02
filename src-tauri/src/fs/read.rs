use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::UNIX_EPOCH,
};

use serde::Serialize;

use crate::{
    error::{AppError, Result},
    fs::encoding::{self, Eol, EolNormalizer, StreamDecoder},
};

pub const CHUNK_SIZE: usize = 4 * 1024 * 1024;
const INPUT_SIZE: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64, // Milliseconds since Unix epoch.
    pub readonly: bool,
}

pub fn file_stat(path: &Path) -> Result<FileStat> {
    let metadata = std::fs::metadata(path)?;
    let mtime = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(|err| AppError::InvalidArgument(err.to_string()))?
        .as_millis() as u64;
    Ok(FileStat {
        size: metadata.len(),
        mtime,
        readonly: metadata.permissions().readonly(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMetadata {
    pub encoding: String,
    pub eol: Eol,
    pub has_bom: bool,
    pub size: u64,
    pub malformed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eol_map: Option<String>,
}

pub enum ReadEvent {
    Data(Vec<u8>),
    Progress { bytes_read: u64, total_bytes: u64 },
}

fn emit_text(
    text: &str,
    pending: &mut String,
    sink: &mut impl FnMut(ReadEvent) -> Result<()>,
) -> Result<()> {
    pending.push_str(text);
    while pending.len() >= CHUNK_SIZE {
        let mut end = CHUNK_SIZE;
        while !pending.is_char_boundary(end) {
            end -= 1;
        }
        let chunk = pending.drain(..end).as_str().as_bytes().to_vec();
        sink(ReadEvent::Data(chunk))?;
    }
    Ok(())
}

pub fn read_stream(
    path: &Path,
    cancelled: &AtomicBool,
    encoding_override: Option<&str>,
    mut sink: impl FnMut(ReadEvent) -> Result<()>,
) -> Result<ReadMetadata> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let sample = encoding::sample(&mut file)?;
    let detected = encoding::detect_with_override(&sample, encoding_override)?;
    file.seek(SeekFrom::Start(0))?;
    let mut decoder = StreamDecoder::new(detected.encoding);
    let mut normalizer = EolNormalizer::default();
    let mut pending = String::new();
    let mut bytes_read = 0u64;
    let mut input = vec![0; INPUT_SIZE];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(AppError::Cancelled);
        }
        let count = file.read(&mut input)?;
        if count == 0 {
            break;
        }
        let skip = (detected.bom_len as u64)
            .saturating_sub(bytes_read)
            .min(count as u64) as usize;
        let decoded = decoder.decode(&input[skip..count], false)?;
        emit_text(
            &normalizer.push(&decoded.text, false),
            &mut pending,
            &mut sink,
        )?;
        bytes_read += count as u64;
        sink(ReadEvent::Progress {
            bytes_read,
            total_bytes: size,
        })?;
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(AppError::Cancelled);
    }
    let tail = decoder.decode(&[], true)?;
    emit_text(&normalizer.push(&tail.text, true), &mut pending, &mut sink)?;
    if !pending.is_empty() {
        sink(ReadEvent::Data(pending.into_bytes()))?;
    }
    Ok(ReadMetadata {
        encoding: detected.encoding.name().to_string(),
        eol: normalizer.eol(),
        has_bom: detected.has_bom,
        size,
        malformed: decoder.malformed(),
        eol_map: normalizer.mixed_map().map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn streams_utf8_on_character_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.txt");
        let text = "字".repeat(CHUNK_SIZE / 3 + 100);
        std::fs::write(&path, &text).unwrap();
        let mut parts = Vec::new();
        let mut progress = Vec::new();
        let result = read_stream(&path, &AtomicBool::new(false), None, |event| {
            match event {
                ReadEvent::Data(bytes) => {
                    std::str::from_utf8(&bytes).unwrap();
                    parts.extend(bytes);
                }
                ReadEvent::Progress { bytes_read, .. } => progress.push(bytes_read),
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(String::from_utf8(parts).unwrap(), text);
        assert_eq!(progress.last().copied(), Some(result.size));
    }

    #[test]
    fn cancelled_before_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.txt");
        std::fs::write(&path, "content").unwrap();
        let cancel = AtomicBool::new(true);
        assert!(matches!(
            read_stream(&path, &cancel, None, |_| Ok(())),
            Err(AppError::Cancelled)
        ));
    }

    #[test]
    fn split_utf16_surrogate_and_crlf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("utf16.txt");
        let source = "x".repeat(INPUT_SIZE / 2 - 3) + "😀\nlast\n";
        let bytes = encoding::encode(&source, "utf-16le", Eol::Crlf, true, None, false).unwrap();
        std::fs::write(&path, bytes).unwrap();
        let mut content = Vec::new();
        let info = read_stream(&path, &AtomicBool::new(false), None, |event| {
            if let ReadEvent::Data(bytes) = event {
                content.extend(bytes);
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(String::from_utf8(content).unwrap(), source);
        assert_eq!(info.eol, Eol::Crlf);
    }
}
