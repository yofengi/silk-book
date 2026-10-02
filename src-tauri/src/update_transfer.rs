//! Process-owned signed updater downloads; installation always requires a separate user action.
use crate::updates::{ReleaseInfo, UpdateError, UpdateState};
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

type Result<T> = std::result::Result<T, UpdateError>;
const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const MANIFEST_NAME: &str = "manifest.json";
const PACKAGE_NAME: &str = "update.pkg";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum DownloadMode {
    #[default]
    #[serde(rename = "download-only")]
    DownloadOnly,
    #[serde(rename = "download-and-install")]
    DownloadAndInstall,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadSource {
    #[default]
    Manual,
    Automatic,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferPhase {
    #[default]
    Idle,
    Downloading,
    Verifying,
    Ready,
    PreparingInstall,
    Installing,
    Error,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTransferState {
    pub revision: u64,
    pub task_id: Option<String>,
    pub phase: TransferPhase,
    pub release: Option<ReleaseInfo>,
    pub source: DownloadSource,
    pub mode: DownloadMode,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<UpdateError>,
}

#[derive(Default)]
struct TransferInner {
    view: UpdateTransferState,
    update: Option<Update>,
    manifest: Option<CacheManifest>,
    initialized: bool,
}

#[derive(Default)]
pub struct TransferState {
    inner: Mutex<TransferInner>,
    initialization: tauri::async_runtime::Mutex<()>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheManifest {
    release: ReleaseInfo,
    signature: String,
    download_url: String,
    bytes: u64,
    target: String,
    #[serde(default)]
    source: DownloadSource,
    #[serde(default)]
    mode: DownloadMode,
}

fn error(kind: &'static str, message: impl Into<String>) -> UpdateError {
    UpdateError::new(kind, message)
}

fn validate_signed_version(comment: &str, version: &str) -> Result<()> {
    let signed = comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .ok_or_else(|| error("updateSignature", "update signature has no signed version"))?;
    let signed = Version::parse(signed.trim_start_matches('v'))
        .map_err(|_| error("updateSignature", "update signature version is invalid"))?;
    let announced = Version::parse(version)
        .map_err(|_| error("updateSignature", "update version is invalid"))?;
    if signed != announced {
        return Err(error(
            "updateSignature",
            "update signature belongs to a different version",
        ));
    }
    Ok(())
}

fn decode_text(encoded: &str) -> Result<String> {
    let bytes = STANDARD
        .decode(encoded.trim())
        .map_err(|_| error("updateSignature", "update signature encoding is invalid"))?;
    String::from_utf8(bytes)
        .map_err(|_| error("updateSignature", "update signature text is invalid"))
}

fn verify_artifact(bytes: &[u8], signature: &str, pubkey: &str) -> Result<Signature> {
    let key = PublicKey::decode(&decode_text(pubkey)?)
        .map_err(|_| error("updateSignature", "updater public key is invalid"))?;
    let signature = Signature::decode(&decode_text(signature)?)
        .map_err(|_| error("updateSignature", "update signature is invalid"))?;
    key.verify(bytes, &signature, true).map_err(|_| {
        error(
            "updateSignature",
            "update package signature verification failed",
        )
    })?;
    Ok(signature)
}

fn public_key(app: &tauri::AppHandle) -> Result<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error("updateSignature", "updater public key is not configured"))
}

fn verify_package(bytes: &[u8], manifest: &CacheManifest, pubkey: &str) -> Result<()> {
    if bytes.is_empty()
        || bytes.len() as u64 != manifest.bytes
        || manifest.bytes > MAX_PACKAGE_BYTES
    {
        return Err(error(
            "updateCache",
            "cached update package is incomplete or too large",
        ));
    }
    let signature = verify_artifact(bytes, &manifest.signature, pubkey)?;
    validate_signed_version(signature.trusted_comment(), &manifest.release.version)
}

fn target() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn newer_version(version: &str, current: &str) -> Result<()> {
    let version = Version::parse(version)
        .map_err(|_| error("updateInvalidRelease", "invalid update version"))?;
    let current = Version::parse(current)
        .map_err(|_| error("updateInvalidRelease", "invalid current version"))?;
    if !version.pre.is_empty() || version.cmp_precedence(&current) != std::cmp::Ordering::Greater {
        return Err(error(
            "updateInvalidRelease",
            "update version is not newer and stable",
        ));
    }
    Ok(())
}

fn pinned_endpoint(release: &ReleaseInfo) -> Result<reqwest::Url> {
    // ReleaseInfo comes from the validated GitHub checker; revalidate persisted metadata too.
    let url = reqwest::Url::parse(&release.url)
        .map_err(|_| error("updateInvalidRelease", "invalid release URL"))?;
    let tag = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|tag| *tag == release.version || *tag == format!("v{}", release.version))
        .ok_or_else(|| error("updateInvalidRelease", "release URL does not match version"))?;
    let expected = format!("https://github.com/yofengi/silk-book/releases/tag/{tag}");
    if release.url != expected {
        return Err(error("updateInvalidRelease", "untrusted release URL"));
    }
    reqwest::Url::parse(&format!(
        "https://github.com/yofengi/silk-book/releases/download/{tag}/latest.json"
    ))
    .map_err(|_| error("updateInvalidRelease", "invalid updater feed URL"))
}

fn validate_download_url(release: &ReleaseInfo, raw: &str) -> Result<()> {
    let endpoint = pinned_endpoint(release)?;
    let parts: Vec<_> = endpoint.path_segments().unwrap().collect();
    let url = reqwest::Url::parse(raw)
        .map_err(|_| error("updateInvalidRelease", "invalid update package URL"))?;
    let name = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or("");
    if crate::updates::trusted_asset_url(raw, parts[4], name).is_none() {
        return Err(error(
            "updateInvalidRelease",
            "update package is not from this repository release",
        ));
    }
    let matching = if std::env::consts::OS == "macos" {
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            _ => "unsupported",
        };
        name == format!("silk-book-{}-macos-{arch}.app.tar.gz", release.version)
    } else {
        release
            .asset
            .as_ref()
            .is_some_and(|asset| asset.url == raw && asset.name == name)
            && crate::updates::asset_score(name, std::env::consts::OS, std::env::consts::ARCH)
                .is_some()
    };
    if !matching {
        return Err(error(
            "updateInvalidRelease",
            "update feed selected an unexpected platform package",
        ));
    }
    Ok(())
}

async fn resolve_update(app: &tauri::AppHandle, release: &ReleaseInfo) -> Result<Update> {
    newer_version(&release.version, &app.package_info().version.to_string())?;
    let builder = app
        .updater_builder()
        .endpoints(vec![pinned_endpoint(release)?])
        .map_err(map_updater_error)?
        .timeout(Duration::from_secs(20))
        .configure_client(|client| client.connect_timeout(Duration::from_secs(5)))
        // ShellExecute can fail. The app must still work until an installer was actually started.
        .on_before_exit(|| {});
    let mut update = builder
        .build()
        .map_err(map_updater_error)?
        .check()
        .await
        .map_err(map_updater_error)?
        .ok_or_else(|| {
            error(
                "updateInvalidRelease",
                "signed update metadata is unavailable",
            )
        })?;
    if update.version != release.version {
        return Err(error(
            "updateInvalidRelease",
            "signed updater feed does not match the selected release",
        ));
    }
    validate_download_url(release, update.download_url.as_str())?;
    update.timeout = Some(Duration::from_secs(600));
    Ok(update)
}

fn map_updater_error(failure: tauri_plugin_updater::Error) -> UpdateError {
    use tauri_plugin_updater::Error as E;
    let kind = match &failure {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => "updateSignature",
        E::Reqwest(err) if err.is_timeout() => "updateTimeout",
        E::Reqwest(_) | E::Network(_) | E::ReleaseNotFound => "updateNetwork",
        E::Io(_) => "updateCache",
        _ => "updateInvalidRelease",
    };
    // Avoid passing attacker-controlled URL/signature strings from dependency errors into UI/logs.
    error(
        kind,
        match kind {
            "updateSignature" => "signed update verification failed",
            "updateTimeout" => "update request timed out",
            "updateNetwork" => "could not download signed update metadata or package",
            "updateCache" => "could not read or write the update package",
            _ => "signed update metadata is unavailable or invalid",
        },
    )
}

fn unsafe_metadata(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn safe_entry(path: &Path, directory: bool) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata)
            if unsafe_metadata(&metadata)
                || (directory && !metadata.is_dir())
                || (!directory && !metadata.is_file()) =>
        {
            Err(error(
                "updateCache",
                "updater cache contains an unsafe filesystem entry",
            ))
        }
        Ok(_) => Ok(()),
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(error("updateCache", "could not inspect updater cache")),
    }
}

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| error("updateCache", "could not locate updater cache"))?;
    safe_entry(&root, true)?;
    let dir = root.join("updates");
    safe_entry(&dir, true)?;
    std::fs::create_dir_all(&dir)
        .map_err(|_| error("updateCache", "could not create updater cache"))?;
    Ok(dir)
}

fn read_owned(dir: &Path, name: &str, limit: u64) -> Result<Vec<u8>> {
    let path = dir.join(name);
    safe_entry(&path, false)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open a reparse point itself so a swapped link cannot silently redirect package reads.
        options.custom_flags(0x0020_0000);
    }
    let file = options
        .open(&path)
        .map_err(|_| error("updateCache", "cached update file is missing"))?;
    let metadata = file
        .metadata()
        .map_err(|_| error("updateCache", "could not inspect cached update file"))?;
    if unsafe_metadata(&metadata) || !metadata.is_file() {
        return Err(error(
            "updateCache",
            "cached update file is an unsafe filesystem entry",
        ));
    }
    if metadata.len() > limit {
        return Err(error("updateCache", "cached update file is too large"));
    }
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| error("updateCache", "could not read cached update file"))?;
    if bytes.len() as u64 > limit {
        return Err(error(
            "updateCache",
            "cached update file grew beyond the size limit",
        ));
    }
    Ok(bytes)
}

fn clean_owned(dir: &Path) -> Result<()> {
    safe_entry(dir, true)?;
    for entry in
        std::fs::read_dir(dir).map_err(|_| error("updateCache", "could not list updater cache"))?
    {
        let entry = entry.map_err(|_| error("updateCache", "could not inspect updater cache"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name != MANIFEST_NAME && name != PACKAGE_NAME && !name.starts_with(".boshu-") {
            continue;
        }
        safe_entry(&entry.path(), false)?;
        std::fs::remove_file(entry.path())
            .map_err(|_| error("updateCache", "could not remove cached updater file"))?;
    }
    Ok(())
}

fn write_cache(dir: &Path, manifest: &CacheManifest, bytes: &[u8]) -> Result<()> {
    safe_entry(dir, true)?;
    for name in [PACKAGE_NAME, MANIFEST_NAME] {
        safe_entry(&dir.join(name), false)?;
    }
    crate::fs::write::atomic_write(&dir.join(PACKAGE_NAME), bytes)
        .map_err(|_| error("updateCache", "could not persist verified updater package"))?;
    let json = serde_json::to_vec(manifest)
        .map_err(|_| error("updateCache", "could not encode updater cache metadata"))?;
    crate::fs::write::atomic_write(&dir.join(MANIFEST_NAME), &json)
        .map_err(|_| error("updateCache", "could not persist updater cache metadata"))
}

fn restored_cache(dir: &Path, current: &str, pubkey: &str) -> Result<Option<CacheManifest>> {
    if !dir.join(MANIFEST_NAME).exists() {
        clean_owned(dir)?;
        return Ok(None);
    }
    let json = read_owned(dir, MANIFEST_NAME, 1024 * 1024)?;
    let manifest: CacheManifest = serde_json::from_slice(&json)
        .map_err(|_| error("updateCache", "updater cache metadata is invalid"))?;
    if newer_version(&manifest.release.version, current).is_err() {
        clean_owned(dir)?;
        return Ok(None);
    }
    if manifest.target != target() {
        return Err(error(
            "updateCache",
            "updater cache belongs to a different platform",
        ));
    }
    validate_download_url(&manifest.release, &manifest.download_url)?;
    let bytes = read_owned(dir, PACKAGE_NAME, MAX_PACKAGE_BYTES)?;
    verify_package(&bytes, &manifest, pubkey)?;
    Ok(Some(manifest))
}

impl TransferInner {
    fn publish(&mut self, app: &tauri::AppHandle) -> UpdateTransferState {
        self.view.revision = self.view.revision.saturating_add(1);
        let _ = app.emit("updates-state-changed", &self.view);
        self.view.clone()
    }

    fn start(
        &mut self,
        release: ReleaseInfo,
        mode: DownloadMode,
        source: DownloadSource,
    ) -> Result<bool> {
        if self
            .view
            .release
            .as_ref()
            .is_some_and(|old| old.version == release.version)
            && matches!(
                self.view.phase,
                TransferPhase::Downloading | TransferPhase::Verifying | TransferPhase::Ready
            )
        {
            return Ok(false);
        }
        if matches!(
            self.view.phase,
            TransferPhase::Downloading
                | TransferPhase::Verifying
                | TransferPhase::PreparingInstall
                | TransferPhase::Installing
        ) {
            return Err(error("updateBusy", "an update task is already active"));
        }
        let revision = self.view.revision;
        self.view = UpdateTransferState {
            revision,
            task_id: Some(uuid::Uuid::new_v4().to_string()),
            phase: TransferPhase::Downloading,
            release: Some(release),
            source,
            mode,
            ..Default::default()
        };
        self.update = None;
        self.manifest = None;
        Ok(true)
    }

    fn install_failed(&mut self, failure: UpdateError) {
        let cache_unusable = matches!(
            failure.kind,
            "updateCache" | "updateSignature" | "updateInvalidRelease"
        );
        self.view.phase = if cache_unusable {
            TransferPhase::Error
        } else {
            TransferPhase::Ready
        };
        self.view.error = Some(failure);
        if cache_unusable {
            self.update = None;
            self.manifest = None;
        }
    }
}

pub fn snapshot(app: &tauri::AppHandle) -> UpdateTransferState {
    app.state::<TransferState>()
        .inner
        .lock()
        .map(|inner| inner.view.clone())
        .unwrap_or_default()
}

pub async fn restore_once(app: &tauri::AppHandle) {
    let state = app.state::<TransferState>();
    let _guard = state.initialization.lock().await;
    if state
        .inner
        .lock()
        .map(|inner| inner.initialized)
        .unwrap_or(true)
    {
        return;
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let dir = cache_dir(&handle)?;
        let result = restored_cache(
            &dir,
            &handle.package_info().version.to_string(),
            &public_key(&handle)?,
        );
        if result.is_err() {
            let _ = clean_owned(&dir);
        }
        result
    })
    .await
    .unwrap_or_else(|_| Err(error("updateCache", "could not inspect updater cache")));
    if let Ok(mut inner) = state.inner.lock() {
        inner.initialized = true;
        match result {
            Ok(Some(manifest)) => {
                inner.view = UpdateTransferState {
                    revision: inner.view.revision,
                    task_id: Some(uuid::Uuid::new_v4().to_string()),
                    phase: TransferPhase::Ready,
                    release: Some(manifest.release.clone()),
                    source: manifest.source,
                    mode: manifest.mode,
                    downloaded_bytes: manifest.bytes,
                    total_bytes: Some(manifest.bytes),
                    ..Default::default()
                };
                inner.manifest = Some(manifest);
                inner.publish(app);
            }
            Err(failure) => {
                inner.view.phase = TransferPhase::Error;
                inner.view.error = Some(failure);
                inner.publish(app);
            }
            Ok(None) => {}
        }
    };
}

pub async fn start_download(
    app: tauri::AppHandle,
    release: ReleaseInfo,
    mode: DownloadMode,
    source: DownloadSource,
    initiating_window: Option<String>,
) -> Result<UpdateTransferState> {
    newer_version(&release.version, &app.package_info().version.to_string())?;
    if release.asset.is_none() {
        return Err(error(
            "updateInvalidRelease",
            "release has no package for this platform",
        ));
    }
    restore_once(&app).await;
    let snapshot = {
        let state = app.state::<TransferState>();
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| error("updateBusy", "updater state is unavailable"))?;
        if !inner.start(release.clone(), mode, source)? {
            return Ok(inner.view.clone());
        }
        inner.publish(&app)
    };
    let task_id = snapshot.task_id.clone().unwrap();
    tauri::async_runtime::spawn(async move {
        let result = download_package(&app, &task_id, release).await;
        let notice = {
            let state = app.state::<TransferState>();
            let mut inner = match state.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return,
            };
            if inner.view.task_id.as_deref() != Some(&task_id) {
                return;
            }
            match result {
                Ok((update, manifest)) => {
                    inner.view.phase = TransferPhase::Ready;
                    inner.view.downloaded_bytes = manifest.bytes;
                    inner.view.total_bytes = Some(manifest.bytes);
                    inner.update = Some(update);
                    inner.manifest = Some(manifest);
                    let view = inner.publish(&app);
                    if view.source == DownloadSource::Automatic
                        || view.mode == DownloadMode::DownloadAndInstall
                    {
                        Some(view)
                    } else {
                        None
                    }
                }
                Err(failure) => {
                    inner.view.phase = TransferPhase::Error;
                    inner.view.error = Some(failure);
                    inner.publish(&app);
                    None
                }
            }
        };
        // Never hold the transfer lock while asking native windows for state or resolving a target.
        if let Some(view) = notice {
            let focused = app
                .state::<crate::window::WindowState>()
                .focused
                .lock()
                .ok()
                .map(|label| label.clone());
            let target = initiating_window
                .filter(|label| app.get_webview_window(label).is_some())
                .or_else(|| focused.filter(|label| app.get_webview_window(label).is_some()))
                .or_else(|| app.webview_windows().into_keys().min());
            if let Some(target) = target {
                let _ = app.emit_to(
                    tauri::EventTarget::webview_window(target),
                    "updates-ready",
                    serde_json::json!({"taskId": task_id, "revision": view.revision}),
                );
            }
        }
    });
    Ok(snapshot)
}

async fn download_package(
    app: &tauri::AppHandle,
    task_id: &str,
    release: ReleaseInfo,
) -> Result<(Update, CacheManifest)> {
    let update = resolve_update(app, &release).await?;
    let mut last_emit = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    let exceeded = AtomicBool::new(false);
    let download = update.download(
        |chunk, total| {
            let state = app.state::<TransferState>();
            if let Ok(mut inner) = state.inner.lock() {
                if inner.view.task_id.as_deref() != Some(task_id) {
                    return;
                }
                inner.view.downloaded_bytes =
                    inner.view.downloaded_bytes.saturating_add(chunk as u64);
                inner.view.total_bytes = total;
                if inner.view.downloaded_bytes > MAX_PACKAGE_BYTES
                    || total.is_some_and(|bytes| bytes > MAX_PACKAGE_BYTES)
                {
                    exceeded.store(true, Ordering::Relaxed);
                }
                if last_emit.elapsed() >= Duration::from_millis(150) {
                    inner.publish(app);
                    last_emit = Instant::now();
                }
            };
        },
        || {
            let state = app.state::<TransferState>();
            if let Ok(mut inner) = state.inner.lock() {
                inner.view.phase = TransferPhase::Verifying;
                inner.publish(app);
            };
        },
    );
    let bytes = bounded_download(download, &exceeded).await?;
    let view = snapshot(app);
    let manifest = CacheManifest {
        release,
        signature: update.signature.clone(),
        download_url: update.download_url.to_string(),
        bytes: bytes.len() as u64,
        target: target(),
        source: view.source,
        mode: view.mode,
    };
    let key = public_key(app)?;
    let dir = cache_dir(app)?;
    let saved = manifest.clone();
    tauri::async_runtime::spawn_blocking(move || {
        verify_package(&bytes, &saved, &key)?;
        write_cache(&dir, &saved, &bytes)
    })
    .await
    .map_err(|_| error("updateCache", "could not persist update package"))??;
    Ok((update, manifest))
}

async fn bounded_download<F: Future<Output = tauri_plugin_updater::Result<Vec<u8>>>>(
    download: F,
    exceeded: &AtomicBool,
) -> Result<Vec<u8>> {
    let mut download = Box::pin(download);
    std::future::poll_fn(|context| {
        let outcome = download.as_mut().poll(context);
        if exceeded.load(Ordering::Relaxed) {
            std::task::Poll::Ready(Err(error(
                "updateCache",
                "update package exceeds the download size limit",
            )))
        } else {
            outcome.map(|result| result.map_err(map_updater_error))
        }
    })
    .await
}

#[tauri::command]
pub async fn updates_transfer(app: tauri::AppHandle) -> UpdateTransferState {
    restore_once(&app).await;
    snapshot(&app)
}

#[tauri::command]
pub async fn updates_download(
    version: String,
    mode: DownloadMode,
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateTransferState> {
    let release = state
        .latest()
        .and_then(|result| result.release)
        .filter(|release| release.version == version)
        .or_else(|| {
            snapshot(&app)
                .release
                .filter(|release| release.version == version)
        })
        .ok_or_else(|| {
            error(
                "updateInvalidRelease",
                "release is not the inspected version",
            )
        })?;
    start_download(
        app,
        release,
        mode,
        DownloadSource::Manual,
        Some(window.label().to_owned()),
    )
    .await
}

#[tauri::command]
pub fn updates_install(task_id: String, app: tauri::AppHandle) -> Result<UpdateTransferState> {
    let state = app.state::<TransferState>();
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| error("updateBusy", "updater state is unavailable"))?;
        if inner.view.task_id.as_deref() != Some(&task_id) {
            return Err(error("invalidArgument", "update task is stale"));
        }
        if matches!(
            inner.view.phase,
            TransferPhase::PreparingInstall | TransferPhase::Installing
        ) {
            return Ok(inner.view.clone());
        }
        if inner.view.phase != TransferPhase::Ready {
            return Err(error("updateBusy", "update is not ready to install"));
        }
        inner.view.phase = TransferPhase::PreparingInstall;
        inner.view.error = None;
        inner.publish(&app);
    }
    if let Err(failure) = crate::window::request_update_install(&app, task_id.clone()) {
        cancel_install(&app, &task_id);
        return Err(error("updateInstall", failure.to_string()));
    }
    Ok(snapshot(&app))
}

pub fn cancel_install(app: &tauri::AppHandle, task_id: &str) {
    let state = app.state::<TransferState>();
    if let Ok(mut inner) = state.inner.lock() {
        if inner.view.task_id.as_deref() == Some(task_id)
            && inner.view.phase == TransferPhase::PreparingInstall
        {
            inner.view.phase = TransferPhase::Ready;
            inner.publish(app);
        }
    };
}

pub async fn install_approved(app: tauri::AppHandle, task_id: String) -> Result<()> {
    let state = app.state::<TransferState>();
    let (manifest, retained_update) = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| error("updateBusy", "updater state is unavailable"))?;
        if inner.view.task_id.as_deref() != Some(&task_id)
            || inner.view.phase != TransferPhase::PreparingInstall
        {
            return Err(error("updateBusy", "update installation was not approved"));
        }
        let manifest = inner
            .manifest
            .clone()
            .ok_or_else(|| error("updateCache", "verified package is missing"))?;
        inner.view.phase = TransferPhase::Installing;
        inner.publish(&app);
        (manifest, inner.update.clone())
    };
    let result: Result<()> = async {
        // A restored cache has no opaque plugin Update context. Resolve its pinned metadata once;
        // never redownload bytes. Offline failure keeps the verified ready package for retry.
        let update = match retained_update {
            Some(update) => update,
            None => {
                let update = resolve_update(&app, &manifest.release).await?;
                if update.signature != manifest.signature
                    || update.download_url.as_str() != manifest.download_url
                {
                    return Err(error(
                        "updateSignature",
                        "cached package no longer matches the signed release metadata",
                    ));
                }
                update
            }
        };
        let dir = cache_dir(&app)?;
        let key = public_key(&app)?;
        crate::window_state::persist_before_install(&app).map_err(|_| {
            error(
                "updateInstall",
                "could not save window state before installing",
            )
        })?;
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = read_owned(&dir, PACKAGE_NAME, MAX_PACKAGE_BYTES)?;
            verify_package(&bytes, &manifest, &key)?;
            update
                .install(bytes)
                .map_err(|_| error("updateInstall", "could not start the update installer"))
        })
        .await
        .map_err(|_| error("updateInstall", "update installer task failed"))??;
        Ok(())
    }
    .await;
    if let Err(failure) = &result {
        if let Ok(mut inner) = state.inner.lock() {
            if inner.view.task_id.as_deref() == Some(&task_id) {
                inner.install_failed(failure.clone());
                inner.publish(&app);
            }
        }
    } else {
        app.restart();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/update-package.txt");
    const FIXTURE_KEY: &str = include_str!("../tests/fixtures/update-package.pub");
    const FIXTURE_SIGNATURE: &str = include_str!("../tests/fixtures/update-package.txt.sig");

    fn manifest() -> CacheManifest {
        let (name, os) = match std::env::consts::OS {
            "macos" => ("app.tar.gz", "macos"),
            "linux" => ("AppImage", "linux"),
            _ => ("exe", "windows"),
        };
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            _ => "x64",
        };
        let name = format!("silk-book-0.3.0-{os}-{arch}.{name}");
        let url = format!("https://github.com/yofengi/silk-book/releases/download/v0.3.0/{name}");
        CacheManifest {
            release: ReleaseInfo {
                version: "0.3.0".into(),
                notes: "fixture".into(),
                url: "https://github.com/yofengi/silk-book/releases/tag/v0.3.0".into(),
                asset: Some(crate::updates::ReleaseAsset {
                    name,
                    url: url.clone(),
                }),
            },
            signature: FIXTURE_SIGNATURE.trim().into(),
            download_url: url,
            bytes: FIXTURE.len() as u64,
            target: target(),
            source: DownloadSource::Automatic,
            mode: DownloadMode::DownloadAndInstall,
        }
    }

    #[test]
    fn signature_checks_actual_bytes_global_comment_and_version() {
        let mut saved = manifest();
        assert!(verify_package(FIXTURE, &saved, FIXTURE_KEY).is_ok());
        let mut corrupt = FIXTURE.to_vec();
        corrupt[0] ^= 1;
        assert_eq!(
            verify_package(&corrupt, &saved, FIXTURE_KEY)
                .unwrap_err()
                .kind,
            "updateSignature"
        );
        saved.release.version = "0.4.0".into();
        assert_eq!(
            verify_package(FIXTURE, &saved, FIXTURE_KEY)
                .unwrap_err()
                .kind,
            "updateSignature"
        );
        assert!(verify_package(FIXTURE, &saved, "invalid").is_err());
    }

    #[test]
    fn concurrent_windows_share_task_and_cannot_replace_active_release() {
        let mut inner = TransferInner::default();
        let release = manifest().release;
        assert!(inner
            .start(
                release.clone(),
                DownloadMode::DownloadOnly,
                DownloadSource::Automatic
            )
            .unwrap());
        let id = inner.view.task_id.clone();
        assert!(!inner
            .start(
                release.clone(),
                DownloadMode::DownloadAndInstall,
                DownloadSource::Manual
            )
            .unwrap());
        assert_eq!(inner.view.task_id, id);
        assert_eq!(inner.view.source, DownloadSource::Automatic);
        let mut other = release.clone();
        other.version = "0.4.0".into();
        assert_eq!(
            inner
                .start(
                    other.clone(),
                    DownloadMode::DownloadOnly,
                    DownloadSource::Manual
                )
                .unwrap_err()
                .kind,
            "updateBusy"
        );
        inner.view.phase = TransferPhase::Ready;
        assert!(!inner
            .start(
                release,
                DownloadMode::DownloadAndInstall,
                DownloadSource::Manual
            )
            .unwrap());
        inner.view.phase = TransferPhase::Error;
        assert!(inner
            .start(other, DownloadMode::DownloadOnly, DownloadSource::Manual)
            .unwrap());
        assert_ne!(inner.view.task_id, id);
    }

    #[test]
    fn restart_restores_verified_package_without_network_and_upgrade_cleans_only_owned_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("personal.txt"), b"keep").unwrap();
        let saved = manifest();
        write_cache(dir.path(), &saved, FIXTURE).unwrap();
        let restored = restored_cache(dir.path(), "0.2.0", FIXTURE_KEY)
            .unwrap()
            .unwrap();
        assert_eq!(restored.release.version, "0.3.0");
        assert_eq!(restored.signature, saved.signature);
        assert_eq!(restored.mode, DownloadMode::DownloadAndInstall);
        assert_eq!(restored.source, DownloadSource::Automatic);
        assert!(restored_cache(dir.path(), "0.3.0", FIXTURE_KEY)
            .unwrap()
            .is_none());
        assert_eq!(
            std::fs::read(dir.path().join("personal.txt")).unwrap(),
            b"keep"
        );
        assert!(!dir.path().join(PACKAGE_NAME).exists());
        assert!(!dir.path().join(MANIFEST_NAME).exists());
    }

    #[test]
    fn incomplete_tampered_and_foreign_platform_cache_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut saved = manifest();
        write_cache(dir.path(), &saved, FIXTURE).unwrap();
        std::fs::write(dir.path().join(PACKAGE_NAME), b"truncated").unwrap();
        assert_eq!(
            restored_cache(dir.path(), "0.2.0", FIXTURE_KEY)
                .unwrap_err()
                .kind,
            "updateCache"
        );
        let mut corrupt = FIXTURE.to_vec();
        corrupt[0] ^= 1;
        std::fs::write(dir.path().join(PACKAGE_NAME), &corrupt).unwrap();
        assert_eq!(
            restored_cache(dir.path(), "0.2.0", FIXTURE_KEY)
                .unwrap_err()
                .kind,
            "updateSignature"
        );
        saved.target = "wrong-platform".into();
        write_cache(dir.path(), &saved, FIXTURE).unwrap();
        assert_eq!(
            restored_cache(dir.path(), "0.2.0", FIXTURE_KEY)
                .unwrap_err()
                .kind,
            "updateCache"
        );
    }

    #[test]
    fn unsafe_owned_entry_is_not_followed_or_recursively_removed() {
        let dir = tempfile::tempdir().unwrap();
        let foreign = dir.path().join(PACKAGE_NAME);
        std::fs::create_dir(&foreign).unwrap();
        std::fs::write(foreign.join("personal.txt"), b"keep").unwrap();
        assert!(read_owned(dir.path(), PACKAGE_NAME, MAX_PACKAGE_BYTES).is_err());
        assert!(clean_owned(dir.path()).is_err());
        assert_eq!(
            std::fs::read(foreign.join("personal.txt")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn updater_feed_cannot_pick_an_uninspected_or_wrong_arch_package() {
        let saved = manifest();
        assert!(validate_download_url(&saved.release, &saved.download_url).is_ok());
        let other = saved
            .download_url
            .replace("x64", "arm64")
            .replace("silk-book-", "other-");
        assert!(validate_download_url(&saved.release, &other).is_err());
        assert!(validate_download_url(&saved.release, "https://example.com/setup.exe").is_err());
    }

    #[test]
    fn unusable_cache_enables_download_retry_while_install_or_network_failure_keeps_ready() {
        let mut inner = TransferInner {
            manifest: Some(manifest()),
            ..Default::default()
        };
        inner.view.phase = TransferPhase::Installing;
        inner.view.release = Some(manifest().release);
        inner.install_failed(error("updateNetwork", "offline metadata"));
        assert_eq!(inner.view.phase, TransferPhase::Ready);
        assert!(inner.manifest.is_some());
        inner.install_failed(error("updateInstall", "launch failed"));
        assert_eq!(inner.view.phase, TransferPhase::Ready);
        inner.install_failed(error("updateSignature", "corrupt bytes"));
        assert_eq!(inner.view.phase, TransferPhase::Error);
        assert!(inner.manifest.is_none());
        assert!(inner
            .start(
                manifest().release,
                DownloadMode::DownloadOnly,
                DownloadSource::Manual
            )
            .unwrap());
    }

    #[test]
    fn oversized_download_is_dropped_even_if_the_plugin_finishes_in_the_same_poll() {
        let exceeded = AtomicBool::new(false);
        let result = tauri::async_runtime::block_on(bounded_download(
            async {
                exceeded.store(true, Ordering::Relaxed);
                Ok(vec![1, 2, 3])
            },
            &exceeded,
        ));
        assert_eq!(result.unwrap_err().kind, "updateCache");
        let result = tauri::async_runtime::block_on(bounded_download(
            async { Ok(vec![1, 2, 3]) },
            &AtomicBool::new(false),
        ));
        assert_eq!(result.unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn versions_require_new_stable_precedence_and_cache_paths_cannot_escape() {
        assert!(newer_version("0.3.0", "0.2.0").is_ok());
        for version in [
            "0.2.0",
            "0.2.0+build.1",
            "0.1.0",
            "0.3.0-beta.1",
            "../../escape",
        ] {
            assert!(newer_version(version, "0.2.0").is_err());
        }
        let mut release = manifest().release;
        for url in [
            "https://evil.example/releases/tag/v0.3.0",
            "https://github.com/yofengi/silk-book/releases/tag/v0.3.0?redirect=true",
            "https://github.com/yofengi/silk-book/releases/tag/v0.4.0",
        ] {
            release.url = url.into();
            assert!(pinned_endpoint(&release).is_err());
        }
    }

    #[test]
    fn signed_version_rejects_downgrades_hidden_by_manifest() {
        assert!(validate_signed_version("timestamp:1\tversion:0.2.0", "0.3.0").is_err());
        assert!(validate_signed_version("timestamp:1\tfile:app.tar.gz", "0.3.0").is_err());
        assert!(validate_signed_version("timestamp:1\tversion:v0.3.0", "0.3.0").is_ok());
    }
}
