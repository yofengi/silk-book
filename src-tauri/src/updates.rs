//! Public stable GitHub releases. Network state is shared by every app window.
use std::{
    cmp::Ordering,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use percent_encoding::percent_decode_str;
use reqwest::{Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::settings;

const REPOSITORY_URL: &str = "https://github.com/yofengi/silk-book";
const LATEST_API_URL: &str = "https://api.github.com/repos/yofengi/silk-book/releases/latest";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const HOUR_MS: u64 = 3_600_000;

#[derive(Clone, Debug, Serialize)]
pub struct UpdateError {
    kind: &'static str,
    message: String,
}

impl UpdateError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new("updateInvalidRelease", message)
    }
}

type Result<T> = std::result::Result<T, UpdateError>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    platform: String,
    repository_url: &'static str,
    cached_result: Option<UpdateCheckResult>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    name: String,
    url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    version: String,
    notes: String,
    url: String,
    asset: Option<ReleaseAsset>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum UpdateStatus {
    NoReleases,
    Current,
    Available,
    NoAsset,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    status: UpdateStatus,
    checked_at: u64,
    revision: u64,
    release: Option<ReleaseInfo>,
}

#[derive(Default)]
struct UpdateCache {
    outcome: Option<Result<UpdateCheckResult>>,
    finished_at: Option<Instant>,
    last_attempt: u64,
    revision: u64,
}

#[derive(Default)]
pub struct UpdateState {
    checks: tauri::async_runtime::Mutex<UpdateCache>,
    // Metadata readers and browser commands need not wait for an in-flight network request.
    snapshot: std::sync::RwLock<Option<UpdateCheckResult>>,
}

impl UpdateState {
    fn latest(&self) -> Option<UpdateCheckResult> {
        self.snapshot
            .read()
            .ok()
            .and_then(|snapshot| snapshot.clone())
    }

    fn record(
        &self,
        cache: &mut UpdateCache,
        mut outcome: Result<UpdateCheckResult>,
    ) -> Result<UpdateCheckResult> {
        if let Ok(result) = &mut outcome {
            cache.revision = cache.revision.saturating_add(1);
            result.revision = cache.revision;
            if let Ok(mut snapshot) = self.snapshot.write() {
                *snapshot = Some(result.clone());
            }
        }
        cache.outcome = Some(outcome.clone());
        cache.finished_at = Some(Instant::now());
        outcome
    }
}

fn platform() -> String {
    format!(
        "{} {}",
        match std::env::consts::OS {
            "macos" => "macOS",
            "windows" => "Windows",
            other => other,
        },
        match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "ARM64",
            other => other,
        }
    )
}

#[tauri::command]
pub fn updates_info(app: tauri::AppHandle, state: State<'_, UpdateState>) -> UpdateInfo {
    UpdateInfo {
        current_version: app.package_info().version.to_string(),
        platform: platform(),
        repository_url: REPOSITORY_URL,
        cached_result: state.latest(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn interval_hours(value: &Value) -> u64 {
    match value.get("updates.intervalHours").and_then(Value::as_u64) {
        Some(hours @ (1 | 24 | 168 | 720)) => hours,
        _ => 24,
    }
}

fn check_due(last: u64, hours: u64, now: u64) -> bool {
    last == 0 || last > now || now.saturating_sub(last) >= hours.saturating_mul(HOUR_MS)
}

fn stable_version(tag: &str) -> Result<Version> {
    if tag.len() > 128 {
        return Err(UpdateError::invalid("release tag is too long"));
    }
    let version = Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .map_err(|_| UpdateError::invalid("release tag must be a semantic version"))?;
    if !version.pre.is_empty() {
        return Err(UpdateError::invalid("release is not stable"));
    }
    Ok(version)
}

fn is_newer(tag: &str, current: &str) -> Result<bool> {
    let latest = stable_version(tag)?;
    let current =
        Version::parse(current).map_err(|_| UpdateError::invalid("invalid application version"))?;
    Ok(latest.cmp_precedence(&current) == Ordering::Greater)
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    state: String,
    size: u64,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    assets: Vec<GithubAsset>,
}

fn trusted_asset_url(raw: &str, tag: &str, name: &str) -> Option<String> {
    if name.is_empty()
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let segments: Vec<_> = url
        .path_segments()?
        .map(|s| percent_decode_str(s).decode_utf8().map(|s| s.into_owned()))
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    if segments != ["yofengi", "silk-book", "releases", "download", tag, name] {
        return None;
    }
    Some(url.into())
}

/// Filename architecture must be explicit; do not assume x64 for an unlabelled installer.
fn asset_score(name: &str, os: &str, arch: &str) -> Option<u8> {
    let name = name.to_ascii_lowercase();
    let tokens: Vec<_> = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    let has = |aliases: &[&str]| aliases.iter().any(|alias| tokens.contains(alias));
    let x64 = has(&["x64", "amd64"]) || name.contains("x86_64");
    let arm64 = has(&["arm64", "aarch64"]);
    let x86 = (has(&["x86"]) && !name.contains("x86_64")) || has(&["i686", "ia32"]);
    let arch_ok = match arch {
        "x86_64" => x64 && !arm64 && !x86,
        "aarch64" => arm64 && !x64 && !x86,
        "x86" => x86 && !x64 && !arm64,
        _ => false,
    };
    if !arch_ok {
        return None;
    }
    match os {
        "windows" if !has(&["macos", "darwin", "linux"]) && name.ends_with("-setup.exe") => Some(4),
        "windows" if !has(&["macos", "darwin", "linux"]) && name.ends_with(".msi") => Some(3),
        "windows" if !has(&["macos", "darwin", "linux"]) && name.ends_with(".exe") => Some(2),
        "macos" if !has(&["windows", "linux"]) && name.ends_with(".dmg") => Some(4),
        "linux" if !has(&["windows", "macos", "darwin"]) && name.ends_with(".appimage") => Some(4),
        "linux" if !has(&["windows", "macos", "darwin"]) && name.ends_with(".deb") => Some(3),
        _ => None,
    }
}

fn parse_release(
    value: Value,
    current: &str,
    os: &str,
    arch: &str,
    checked_at: u64,
) -> Result<UpdateCheckResult> {
    let release: GithubRelease = serde_json::from_value(value)
        .map_err(|_| UpdateError::invalid("malformed release payload"))?;
    if release.draft || release.prerelease {
        return Err(UpdateError::invalid("release is not public and stable"));
    }
    let version = stable_version(&release.tag_name)?.to_string();
    let newer = is_newer(&release.tag_name, current)?;
    let mut url = Url::parse(REPOSITORY_URL)
        .map_err(|_| UpdateError::invalid("invalid repository configuration"))?;
    url.path_segments_mut()
        .map_err(|_| UpdateError::invalid("invalid repository configuration"))?
        .extend(["releases", "tag", &release.tag_name]);
    let asset = release
        .assets
        .into_iter()
        .filter_map(|asset| {
            if asset.state != "uploaded" || asset.size == 0 {
                return None;
            }
            let score = asset_score(&asset.name, os, arch)?;
            let url =
                trusted_asset_url(&asset.browser_download_url, &release.tag_name, &asset.name)?;
            Some((
                score,
                ReleaseAsset {
                    name: asset.name,
                    url,
                },
            ))
        })
        .max_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.name.cmp(&a.1.name)))
        .map(|(_, asset)| asset);
    let status = if !newer {
        UpdateStatus::Current
    } else if asset.is_some() {
        UpdateStatus::Available
    } else {
        UpdateStatus::NoAsset
    };
    Ok(UpdateCheckResult {
        status,
        checked_at,
        revision: 0,
        release: Some(ReleaseInfo {
            version,
            notes: release.body.unwrap_or_default(),
            url: url.into(),
            asset,
        }),
    })
}

fn no_releases(checked_at: u64) -> UpdateCheckResult {
    UpdateCheckResult {
        status: UpdateStatus::NoReleases,
        checked_at,
        revision: 0,
        release: None,
    }
}

fn network_error(error: reqwest::Error) -> UpdateError {
    if error.is_timeout() {
        UpdateError::new("updateTimeout", "GitHub request timed out")
    } else {
        UpdateError::new("updateNetwork", "could not connect to GitHub")
    }
}

async fn fetch_latest(current: &str, checked_at: u64) -> Result<UpdateCheckResult> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("silk-book/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(network_error)?;
    let mut response = client
        .get(LATEST_API_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2026-03-10")
        .send()
        .await
        .map_err(network_error)?;
    match response.status().as_u16() {
        404 => return Ok(no_releases(checked_at)),
        429 => {
            return Err(UpdateError::new(
                "updateRateLimit",
                "GitHub API rate limit reached",
            ))
        }
        403 if response
            .headers()
            .get("x-ratelimit-remaining")
            .is_some_and(|v| v == "0")
            || response.headers().contains_key("retry-after") =>
        {
            return Err(UpdateError::new(
                "updateRateLimit",
                "GitHub API rate limit reached",
            ))
        }
        200 => {}
        _ => {
            return Err(UpdateError::new(
                "updateHttp",
                format!("GitHub returned HTTP {}", response.status().as_u16()),
            ))
        }
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(UpdateError::invalid("release payload is too large"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(UpdateError::invalid("release payload is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes)
        .map_err(|_| UpdateError::invalid("release payload is not valid JSON"))?;
    parse_release(
        value,
        current,
        std::env::consts::OS,
        std::env::consts::ARCH,
        checked_at,
    )
}

#[tauri::command]
pub async fn updates_check(
    manual: bool,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    settings_state: State<'_, settings::SettingsState>,
) -> Result<Option<UpdateCheckResult>> {
    let requested = Instant::now();
    let mut cache = state.checks.lock().await;
    // Simultaneous manual checks share failures as well as successes. A later explicit retry is fresh.
    if cache
        .finished_at
        .is_some_and(|finished| finished >= requested)
    {
        return cache.outcome.clone().transpose();
    }
    let path = settings::settings_path()
        .map_err(|_| UpdateError::new("updateSettings", "could not read update settings"))?;
    let load_path = path.clone();
    let settings_value = tauri::async_runtime::spawn_blocking(move || settings::load(&load_path))
        .await
        .map_err(|_| UpdateError::new("updateSettings", "could not read update settings"))?
        .map_err(|_| UpdateError::new("updateSettings", "could not read update settings"))?;
    let now = now_ms();
    let persisted = settings_value
        .get("updates.lastCheckedAt")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if !manual
        && !check_due(
            persisted.max(cache.last_attempt),
            interval_hours(&settings_value),
            now,
        )
    {
        return Ok(state.latest());
    }
    let app = window.app_handle().clone();
    let source = window.label().to_owned();
    let persistence = (*settings_state).clone();
    let mut set = Map::new();
    set.insert("updates.lastCheckedAt".into(), Value::from(now));
    tauri::async_runtime::spawn_blocking(move || {
        persistence.patch_and_publish(&path, Some(set), None, |snapshot| {
            crate::commands::settings::publish(&app, &source, snapshot);
        })
    })
    .await
    .map_err(|_| UpdateError::new("updateSettings", "could not save update timestamp"))?
    .map_err(|_| UpdateError::new("updateSettings", "could not save update timestamp"))?;
    cache.last_attempt = now;
    let outcome = fetch_latest(&window.app_handle().package_info().version.to_string(), now).await;
    let outcome = state.record(&mut cache, outcome);
    if let Ok(result) = &outcome {
        let _ = window.app_handle().emit("updates-checked", result);
    }
    outcome.map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateLink {
    Repository,
    Release,
    Download,
}

#[tauri::command]
pub async fn updates_open(
    target: UpdateLink,
    version: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<()> {
    let url =
        match target {
            UpdateLink::Repository => REPOSITORY_URL.to_owned(),
            UpdateLink::Release | UpdateLink::Download => {
                let snapshot = state.latest();
                let release = snapshot
                    .as_ref()
                    .and_then(|r| r.release.as_ref())
                    .filter(|r| version.as_deref() == Some(r.version.as_str()))
                    .ok_or_else(|| {
                        UpdateError::new("invalidArgument", "release is not the inspected version")
                    })?;
                match target {
                    UpdateLink::Release => release.url.clone(),
                    UpdateLink::Download => release
                        .asset
                        .as_ref()
                        .map(|a| a.url.clone())
                        .ok_or_else(|| {
                            UpdateError::new("invalidArgument", "no installer for this platform")
                        })?,
                    UpdateLink::Repository => unreachable!(),
                }
            }
        };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| UpdateError::new("updateOpen", "could not open the system browser"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str, assets: &[(&str, &str)]) -> serde_json::Value {
        json!({
            "tag_name": tag, "draft": false, "prerelease": false,
            "body": "## Changes\n- Editor fixes",
            "assets": assets.iter().map(|(name, url)| json!({
                "name": name, "browser_download_url": url, "state": "uploaded", "size": 1024
            })).collect::<Vec<_>>()
        })
    }

    #[test]
    fn stable_semver_is_numeric_and_ignores_build_metadata() {
        assert!(is_newer("v0.10.0", "0.9.9").unwrap());
        assert!(!is_newer("v0.1.0+build.2", "0.1.0").unwrap());
        assert!(!is_newer("v0.1.0", "0.2.0").unwrap());
        for tag in [
            "1.0",
            "v1.0.0-beta.1",
            "v01.0.0",
            "version-2.0.0",
            "../../x",
        ] {
            assert!(stable_version(tag).is_err(), "{tag}");
        }
    }

    #[test]
    fn schedules_use_persisted_attempts_and_handle_clock_rollback() {
        let hour = 3_600_000;
        for hours in [1, 24, 168, 720] {
            assert!(!check_due(hour, hours, hour + 1));
            assert!(check_due(hour, hours, hour + hours * hour));
        }
        assert!(check_due(0, 24, hour));
        assert!(check_due(10 * hour, 24, hour));
        assert_eq!(interval_hours(&json!({"updates.intervalHours": 2})), 24);
    }

    #[test]
    fn process_revision_survives_clock_rollback_and_errors_keep_last_valid_release() {
        let state = UpdateState::default();
        let mut cache = UpdateCache::default();
        let first = state
            .record(
                &mut cache,
                parse_release(
                    release("v0.2.0", &[]),
                    "0.1.0",
                    "windows",
                    "x86_64",
                    100_000,
                ),
            )
            .unwrap();
        let second = state
            .record(
                &mut cache,
                parse_release(release("v0.3.0", &[]), "0.1.0", "windows", "x86_64", 50_000),
            )
            .unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(second.revision, 2);
        assert_eq!(second.checked_at, 50_000);
        assert!(state
            .record(
                &mut cache,
                Err(UpdateError::new("updateNetwork", "offline"))
            )
            .is_err());
        let snapshot = state.latest().unwrap();
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.release.unwrap().version, "0.3.0");
        assert!(cache.outcome.unwrap().is_err());
    }

    #[test]
    fn metadata_snapshot_is_available_while_another_window_holds_check_lock() {
        let state = UpdateState::default();
        let mut cache = state.checks.try_lock().unwrap();
        state.record(&mut cache, Ok(no_releases(100))).unwrap();
        assert!(state.checks.try_lock().is_err());
        assert_eq!(state.latest().unwrap().status, UpdateStatus::NoReleases);
    }

    #[test]
    fn release_asset_names_from_ci_match_all_three_published_targets() {
        let assets = [
            ("silk-book-0.2.0-windows-x64-setup.exe", "https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book-0.2.0-windows-x64-setup.exe"),
            ("silk-book-0.2.0-macos-arm64.dmg", "https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book-0.2.0-macos-arm64.dmg"),
            ("silk-book-0.2.0-macos-x64.dmg", "https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book-0.2.0-macos-x64.dmg"),
        ];
        for (os, arch, name) in [
            ("windows", "x86_64", assets[0].0),
            ("macos", "aarch64", assets[1].0),
            ("macos", "x86_64", assets[2].0),
        ] {
            let parsed = parse_release(release("v0.2.0", &assets), "0.1.0", os, arch, 100).unwrap();
            assert_eq!(parsed.status, UpdateStatus::Available);
            assert_eq!(parsed.release.unwrap().asset.unwrap().name, name);
        }
    }

    #[test]
    fn windows_download_selects_exact_arch_and_prefers_installer() {
        let value = release("v0.2.0", &[
            ("silk-book_0.2.0_aarch64-setup.exe", "https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book_0.2.0_aarch64-setup.exe"),
            ("silk-book_0.2.0_x64_en-US.msi", "https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book_0.2.0_x64_en-US.msi"),
            ("silk-book_0.2.0_x64-setup.exe", "https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book_0.2.0_x64-setup.exe"),
        ]);
        let result = parse_release(value, "0.1.0", "windows", "x86_64", 1).unwrap();
        assert_eq!(result.status, UpdateStatus::Available);
        assert!(result
            .release
            .unwrap()
            .asset
            .unwrap()
            .name
            .ends_with("x64-setup.exe"));
    }

    #[test]
    fn macos_selects_dmg_for_exact_arch_and_missing_assets_are_not_current() {
        let value = release("v0.2.0", &[
            ("silk-book_0.2.0_x64.dmg", "https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book_0.2.0_x64.dmg"),
            ("silk-book_0.2.0_aarch64.dmg", "https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book_0.2.0_aarch64.dmg"),
        ]);
        let result = parse_release(value, "0.1.0", "macos", "aarch64", 1).unwrap();
        assert!(result
            .release
            .unwrap()
            .asset
            .unwrap()
            .name
            .contains("aarch64"));
        let empty = parse_release(release("v0.2.0", &[]), "0.1.0", "windows", "x86_64", 1).unwrap();
        assert_eq!(empty.status, UpdateStatus::NoAsset);
    }

    #[test]
    fn asset_urls_must_match_configured_repository_release_tag_and_filename() {
        let asset = "silk-book_0.2.0_x64-setup.exe";
        for url in [
            "https://evil.example/silk-book_0.2.0_x64-setup.exe",
            "https://github.com/other/silk-book/releases/download/v0.2.0/silk-book_0.2.0_x64-setup.exe",
            "https://github.com/yofengi/silk-book/releases/download/v0.1.0/silk-book_0.2.0_x64-setup.exe",
            "https://github.com/yofengi/silk-book/releases/download/v0.2.0/other.exe",
            "https://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book_0.2.0_x64-setup.exe?token=secret",
            "https://user@github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book_0.2.0_x64-setup.exe",
            "http://github.com/yofengi/silk-book/releases/download/v0.2.0/silk-book_0.2.0_x64-setup.exe",
        ] {
            let result = parse_release(release("v0.2.0", &[(asset, url)]), "0.1.0", "windows", "x86_64", 1).unwrap();
            assert_eq!(result.status, UpdateStatus::NoAsset, "{url}");
        }
    }

    #[test]
    fn malformed_unstable_and_absent_releases_remain_distinct() {
        for value in [
            json!({}),
            json!({"tag_name": "garbage"}),
            json!({"tag_name": "v0.2.0", "draft": true}),
            json!({"tag_name": "v0.2.0", "prerelease": true}),
        ] {
            assert!(parse_release(value, "0.1.0", "windows", "x86_64", 1).is_err());
        }
        let same = parse_release(release("v0.1.0", &[]), "0.1.0", "windows", "x86_64", 1).unwrap();
        assert_eq!(same.status, UpdateStatus::Current);
        assert_eq!(no_releases(1).status, UpdateStatus::NoReleases);
    }
}
