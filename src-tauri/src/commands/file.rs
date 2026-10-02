use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;
use tauri::{
    ipc::{Channel, InvokeBody, InvokeResponseBody, Request},
    Manager, State,
};

use crate::{
    error::{AppError, Result},
    fs::{
        encoding::Eol,
        read::{self, FileStat, ReadEvent, ReadMetadata},
        write,
    },
};

#[derive(Default, Clone)]
pub struct ReadRegistry(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

impl ReadRegistry {
    fn start(&self, request_id: &str) -> Result<Arc<AtomicBool>> {
        if request_id.is_empty() {
            return Err(AppError::InvalidArgument(
                "request_id must not be empty".into(),
            ));
        }
        let mut reads = self
            .0
            .lock()
            .map_err(|err| AppError::Channel(err.to_string()))?;
        if reads.contains_key(request_id) {
            return Err(AppError::InvalidArgument("duplicate request_id".into()));
        }
        let flag = Arc::new(AtomicBool::new(false));
        reads.insert(request_id.to_owned(), flag.clone());
        Ok(flag)
    }

    fn cancel(&self, request_id: &str) -> Result<bool> {
        let reads = self
            .0
            .lock()
            .map_err(|err| AppError::Channel(err.to_string()))?;
        if let Some(flag) = reads.get(request_id) {
            flag.store(true, Ordering::Release);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn finish(&self, request_id: &str) {
        if let Ok(mut reads) = self.0.lock() {
            reads.remove(request_id);
        }
    }
}

#[tauri::command]
pub async fn file_stat(path: String) -> Result<FileStat> {
    tauri::async_runtime::spawn_blocking(move || read::file_stat(std::path::Path::new(&path)))
        .await
        .map_err(|err| AppError::Channel(err.to_string()))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    kind: &'static str,
    request_id: &'a str,
    bytes_read: u64,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Done<'a> {
    kind: &'static str,
    request_id: &'a str,
}

#[tauri::command]
pub async fn read_file(
    path: String,
    request_id: String,
    channel: Channel<InvokeResponseBody>,
    encoding: Option<String>,
    registry: State<'_, ReadRegistry>,
) -> Result<ReadMetadata> {
    let flag = registry.start(&request_id)?;
    let state = (*registry).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = read::read_stream(
            std::path::Path::new(&path),
            &flag,
            encoding.as_deref(),
            |event| {
                let body = match event {
                    ReadEvent::Data(bytes) => InvokeResponseBody::Raw(bytes),
                    ReadEvent::Progress {
                        bytes_read,
                        total_bytes,
                    } => InvokeResponseBody::Json(serde_json::to_string(&Progress {
                        kind: "progress",
                        request_id: &request_id,
                        bytes_read,
                        total_bytes,
                    })?),
                };
                channel
                    .send(body)
                    .map_err(|err| AppError::Channel(err.to_string()))
            },
        );
        let outcome = match outcome {
            Ok(metadata) => {
                let done = serde_json::to_string(&Done {
                    kind: "done",
                    request_id: &request_id,
                })?;
                channel
                    .send(InvokeResponseBody::Json(done))
                    .map_err(|err| AppError::Channel(err.to_string()))
                    .map(|()| metadata)
            }
            Err(err) => Err(err),
        };
        state.finish(&request_id);
        outcome
    })
    .await
    .map_err(|err| AppError::Channel(err.to_string()))?
}

#[tauri::command]
pub fn cancel_read(request_id: String, registry: State<'_, ReadRegistry>) -> Result<bool> {
    registry.cancel(&request_id)
}

#[tauri::command]
pub fn allow_asset_dir(path: String, app: tauri::AppHandle) -> Result<()> {
    let file = Path::new(&path);
    if !file.is_absolute() || !file.is_file() {
        return Err(AppError::InvalidArgument(
            "path must be an existing absolute file path".into(),
        ));
    }
    let file = dunce::canonicalize(file)?;
    let dir = file
        .parent()
        .ok_or_else(|| AppError::InvalidArgument("file has no parent directory".into()))?;
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|err| AppError::InvalidArgument(err.to_string()))
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| AppError::InvalidArgument(format!("missing header: {name}")))?
        .to_str()
        .map_err(|err| AppError::InvalidArgument(format!("invalid {name}: {err}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    bytes_written: u64,
}

#[tauri::command]
pub async fn write_file(request: Request<'_>) -> Result<WriteResult> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => {
            return Err(AppError::InvalidArgument(
                "write_file requires a raw Uint8Array body".into(),
            ))
        }
    };
    let encoded_path = header(&request, "x-boshu-path")?;
    let path = percent_encoding::percent_decode_str(encoded_path)
        .decode_utf8()
        .map_err(|err| AppError::InvalidArgument(format!("invalid path encoding: {err}")))?
        .into_owned();
    let encoding = header(&request, "x-boshu-encoding")?.to_owned();
    let eol = match header(&request, "x-boshu-eol")? {
        "LF" => Eol::Lf,
        "CRLF" => Eol::Crlf,
        "CR" => Eol::Cr,
        "MIXED" => Eol::Mixed,
        other => return Err(AppError::InvalidArgument(format!("invalid EOL: {other}"))),
    };
    let has_bom = match header(&request, "x-boshu-bom")? {
        "true" => true,
        "false" => false,
        other => return Err(AppError::InvalidArgument(format!("invalid BOM: {other}"))),
    };
    let allow_lossy = request
        .headers()
        .get("x-boshu-allow-lossy")
        .map(|value| value.to_str().unwrap_or_default() == "true")
        .unwrap_or(false);
    let map_len = request
        .headers()
        .get("x-boshu-eol-map-length")
        .map(|value| {
            value
                .to_str()
                .map_err(|err| AppError::InvalidArgument(err.to_string()))
                .and_then(|value| {
                    value.parse::<usize>().map_err(|err| {
                        AppError::InvalidArgument(format!("invalid EOL map length: {err}"))
                    })
                })
        })
        .transpose()?
        .unwrap_or(0);
    if map_len > body.len() || (eol != Eol::Mixed && map_len != 0) {
        return Err(AppError::InvalidArgument(
            "invalid EOL map prefix length".into(),
        ));
    }
    let eol_map = if eol == Eol::Mixed {
        Some(
            std::str::from_utf8(&body[..map_len])
                .map_err(|err| AppError::InvalidArgument(format!("invalid EOL map: {err}")))?
                .to_owned(),
        )
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        write::write_file(
            std::path::Path::new(&path),
            &body[map_len..],
            &encoding,
            eol,
            has_bom,
            eol_map.as_deref(),
            allow_lossy,
        )
        .map(|bytes_written| WriteResult { bytes_written })
    })
    .await
    .map_err(|err| AppError::Channel(err.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_cancel_and_release() {
        let registry = ReadRegistry::default();
        let flag = registry.start("id").unwrap();
        assert!(registry.start("id").is_err());
        assert!(registry.cancel("id").unwrap());
        assert!(flag.load(Ordering::Acquire));
        registry.finish("id");
        assert!(!registry.cancel("id").unwrap());
    }
}
