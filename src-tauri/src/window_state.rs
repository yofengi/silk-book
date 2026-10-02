//! Last closed window's normal logical size and maximized state, controlled by window.rememberSize.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{utils::config::WindowConfig, Manager};

use crate::error::{AppError, Result};

const MIN_WIDTH: f64 = 640.0;
const MIN_HEIGHT: f64 = 400.0;
const MAX_LOGICAL_SIZE: f64 = 32_768.0;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedGeometry {
    version: u32,
    width: f64,
    height: f64,
    maximized: bool,
}

impl Default for SavedGeometry {
    fn default() -> Self {
        Self {
            version: 1,
            width: 1000.0,
            height: 700.0,
            maximized: false,
        }
    }
}

impl SavedGeometry {
    fn valid(self) -> bool {
        self.version == 1
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width > 0.0
            && self.height > 0.0
    }

    fn bounded(self, work_area: Option<(f64, f64)>) -> Self {
        let saved = if self.valid() { self } else { Self::default() };
        let (max_width, max_height) = work_area
            .filter(|(width, height)| {
                width.is_finite() && height.is_finite() && *width > 0.0 && *height > 0.0
            })
            .unwrap_or((MAX_LOGICAL_SIZE, MAX_LOGICAL_SIZE));
        Self {
            width: saved
                .width
                .clamp(MIN_WIDTH, max_width.clamp(MIN_WIDTH, MAX_LOGICAL_SIZE)),
            height: saved
                .height
                .clamp(MIN_HEIGHT, max_height.clamp(MIN_HEIGHT, MAX_LOGICAL_SIZE)),
            ..saved
        }
    }
}

#[derive(Clone, Copy)]
struct Observation {
    width: u32,
    height: u32,
    scale_factor: f64,
    minimized: bool,
    maximized: bool,
}

struct GeometryStore {
    latest: SavedGeometry,
    remember_size: bool,
    windows: HashMap<String, SavedGeometry>,
    restoring: HashSet<String>,
}

impl Default for GeometryStore {
    fn default() -> Self {
        Self {
            latest: SavedGeometry::default(),
            remember_size: true,
            windows: HashMap::new(),
            restoring: HashSet::new(),
        }
    }
}

impl GeometryStore {
    fn initial_geometry(&self, work_area: Option<(f64, f64)>) -> SavedGeometry {
        let saved = if self.remember_size {
            self.latest
        } else {
            SavedGeometry::default()
        };
        saved.bounded(work_area)
    }

    fn register(&mut self, label: &str, saved: SavedGeometry, restoring: bool) {
        self.windows.insert(label.into(), saved);
        if restoring {
            self.restoring.insert(label.into());
        }
    }
    fn observe(&mut self, label: &str, observation: Observation) {
        if self.restoring.contains(label)
            || observation.minimized
            || observation.width == 0
            || observation.height == 0
            || !observation.scale_factor.is_finite()
            || observation.scale_factor <= 0.0
        {
            return;
        }
        let Some(saved) = self.windows.get_mut(label) else {
            return;
        };
        saved.maximized = observation.maximized;
        if !observation.maximized {
            saved.width = f64::from(observation.width) / observation.scale_factor;
            saved.height = f64::from(observation.height) / observation.scale_factor;
            *saved = saved.bounded(None);
        }
    }

    fn closed(&mut self, label: &str) -> Option<SavedGeometry> {
        self.restoring.remove(label);
        let saved = self.windows.remove(label)?;
        if !self.remember_size {
            return None;
        }
        self.latest = saved;
        Some(saved)
    }
}

pub struct WindowGeometryState {
    inner: Mutex<GeometryStore>,
    path: Option<PathBuf>,
}

impl Default for WindowGeometryState {
    fn default() -> Self {
        let settings_path = crate::settings::settings_path().ok();
        let remember_size = settings_path
            .as_deref()
            .map(|path| match crate::settings::load(path) {
                Ok(value) => crate::settings::remember_window_size(&value),
                Err(error) => {
                    eprintln!("Boshu window preference could not be loaded: {error}");
                    true
                }
            })
            .unwrap_or(true);
        let path = settings_path.map(|path| path.with_file_name("window-state.json"));
        let latest = path
            .as_deref()
            .and_then(|path| match load(path) {
                Ok(saved) => saved,
                Err(error) => {
                    eprintln!("Boshu window state could not be loaded: {error}");
                    None
                }
            })
            .unwrap_or_default()
            .bounded(None);
        Self {
            inner: Mutex::new(GeometryStore {
                latest,
                remember_size,
                ..Default::default()
            }),
            path,
        }
    }
}

impl WindowGeometryState {
    fn close_window(&self, label: &str) -> Result<()> {
        let mut store = self
            .inner
            .lock()
            .map_err(|error| AppError::Channel(error.to_string()))?;
        if let Some(saved) = store.closed(label) {
            // Keep allocation and atomic save under one lock so close order cannot reverse on disk.
            if let Some(path) = self.path.as_deref() {
                save(path, saved)?;
            }
        }
        Ok(())
    }
}

/// Called while the settings commit lock is held, before all windows receive the snapshot.
pub fn apply_settings(app: &tauri::AppHandle, value: &serde_json::Value) {
    if let Some(state) = app.try_state::<WindowGeometryState>() {
        match state.inner.lock() {
            Ok(mut store) => store.remember_size = crate::settings::remember_window_size(value),
            Err(error) => eprintln!("Boshu window preference could not be applied: {error}"),
        }
    }
}

fn work_area(monitor: &tauri::Monitor) -> Option<(f64, f64)> {
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let area = monitor.work_area();
    Some((
        f64::from(area.size.width) / scale,
        f64::from(area.size.height) / scale,
    ))
}

fn monitor_for_new_window(
    app: &tauri::AppHandle,
    position: Option<(f64, f64)>,
) -> Option<tauri::Monitor> {
    if let Some((x, y)) = position {
        if let Ok(monitors) = app.available_monitors() {
            // WindowOpenOptions and WindowConfig use logical screen coordinates.
            if let Some(monitor) = monitors.into_iter().find(|monitor| {
                let scale = monitor.scale_factor();
                if !scale.is_finite() || scale <= 0.0 {
                    return false;
                }
                let origin = monitor.position();
                let size = monitor.size();
                let left = f64::from(origin.x) / scale;
                let top = f64::from(origin.y) / scale;
                x >= left
                    && y >= top
                    && x < left + f64::from(size.width) / scale
                    && y < top + f64::from(size.height) / scale
            }) {
                return Some(monitor);
            }
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Apply only dimensions to a new window. The caller keeps its explicit drag position.
pub fn configure_new_window(
    app: &tauri::AppHandle,
    config: &mut WindowConfig,
    position: Option<(f64, f64)>,
) -> Result<()> {
    if position.is_some_and(|(x, y)| !x.is_finite() || !y.is_finite()) {
        return Err(AppError::InvalidArgument("invalid window position".into()));
    }
    let monitor = monitor_for_new_window(app, position);
    let state = app.state::<WindowGeometryState>();
    let mut store = state
        .inner
        .lock()
        .map_err(|error| AppError::Channel(error.to_string()))?;
    let saved = SavedGeometry {
        maximized: false,
        ..store.initial_geometry(monitor.as_ref().and_then(work_area))
    };
    config.width = saved.width;
    config.height = saved.height;
    config.min_width = Some(MIN_WIDTH);
    config.min_height = Some(MIN_HEIGHT);
    config.maximized = false;
    store.register(&config.label, saved, false);
    Ok(())
}

/// Restore the startup window before frontend initialization; native resize events stay in memory.
pub fn restore_main(app: &tauri::AppHandle) -> Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let state = app.state::<WindowGeometryState>();
    let saved = {
        let mut store = state
            .inner
            .lock()
            .map_err(|error| AppError::Channel(error.to_string()))?;
        let saved = store.initial_geometry(monitor.as_ref().and_then(work_area));
        store.register(window.label(), saved, true);
        saved
    };
    let result = (|| -> tauri::Result<()> {
        window.set_min_size(Some(tauri::LogicalSize::new(MIN_WIDTH, MIN_HEIGHT)))?;
        window.unmaximize()?;
        window.set_size(tauri::LogicalSize::new(saved.width, saved.height))?;
        if let Some(monitor) = monitor.as_ref() {
            let scale = monitor.scale_factor();
            if scale.is_finite() && scale > 0.0 {
                let area = monitor.work_area();
                let x = f64::from(area.position.x)
                    + ((f64::from(area.size.width) - saved.width * scale) / 2.0).max(0.0);
                let y = f64::from(area.position.y)
                    + ((f64::from(area.size.height) - saved.height * scale) / 2.0).max(0.0);
                window.set_position(tauri::PhysicalPosition::new(
                    x.round() as i32,
                    y.round() as i32,
                ))?;
            }
        }
        if saved.maximized {
            window.maximize()?;
        }
        // Flush queued native operations before removing the restoration barrier.
        window.is_maximized()?;
        Ok(())
    })();
    state
        .inner
        .lock()
        .map_err(|error| AppError::Channel(error.to_string()))?
        .restoring
        .remove(window.label());
    result.map_err(|error| AppError::Channel(error.to_string()))
}

fn observe(window: &tauri::Window) -> tauri::Result<Observation> {
    let minimized = window.is_minimized()?;
    let size = window.inner_size()?;
    Ok(Observation {
        width: size.width,
        height: size.height,
        scale_factor: window.scale_factor()?,
        minimized,
        maximized: window.is_maximized()?,
    })
}

/// Resize events cache valid normal sizes. Only actual destruction publishes and saves a state.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let Some(state) = window.app_handle().try_state::<WindowGeometryState>() else {
        return;
    };
    if matches!(event, tauri::WindowEvent::Destroyed) {
        if let Err(error) = state.close_window(window.label()) {
            eprintln!("Boshu window state could not be saved: {error}");
        }
    } else if matches!(
        event,
        tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. }
            | tauri::WindowEvent::CloseRequested { .. }
    ) {
        // Query the live native state: stale queued resize payloads must not overwrite a restored size.
        if let Ok(observation) = observe(window) {
            if let Ok(mut store) = state.inner.lock() {
                store.observe(window.label(), observation);
            }
        }
    }
}

fn load(path: &Path) -> Result<Option<SavedGeometry>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let saved: SavedGeometry = serde_json::from_slice(&bytes)?;
    Ok(saved.valid().then_some(saved))
}

fn save(path: &Path, saved: SavedGeometry) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidArgument("invalid window state path".into()))?;
    std::fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec_pretty(&saved)?;
    crate::fs::write::atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(width: f64, height: f64, maximized: bool) -> SavedGeometry {
        SavedGeometry {
            version: 1,
            width,
            height,
            maximized,
        }
    }
    fn observation(
        width: u32,
        height: u32,
        scale: f64,
        minimized: bool,
        maximized: bool,
    ) -> Observation {
        Observation {
            width,
            height,
            scale_factor: scale,
            minimized,
            maximized,
        }
    }

    #[test]
    fn a_resize_is_saved_in_logical_pixels_for_another_dpi() {
        let mut store = GeometryStore::default();
        store.register("main", SavedGeometry::default(), false);
        store.observe("main", observation(1500, 1050, 1.5, false, false));
        assert_eq!(store.closed("main"), Some(saved(1000.0, 700.0, false)));
    }

    #[test]
    fn minimize_and_zero_dimensions_keep_the_last_normal_size_and_maximize_state() {
        let mut store = GeometryStore::default();
        store.register("main", saved(900.0, 650.0, false), false);
        store.observe("main", observation(1920, 1040, 1.0, false, true));
        store.observe("main", observation(0, 0, 1.0, true, false));
        assert_eq!(store.closed("main"), Some(saved(900.0, 650.0, true)));
    }

    #[test]
    fn unmaximizing_records_the_restored_normal_dimensions() {
        let mut store = GeometryStore::default();
        store.register("main", saved(900.0, 650.0, true), false);
        store.observe("main", observation(960, 720, 1.0, false, false));
        assert_eq!(store.closed("main"), Some(saved(960.0, 720.0, false)));
    }

    #[test]
    fn restore_events_do_not_replace_a_maximized_windows_normal_baseline() {
        let mut store = GeometryStore::default();
        store.register("main", saved(850.0, 600.0, true), true);
        store.observe("main", observation(1000, 700, 1.0, false, false));
        store.observe("main", observation(1920, 1040, 1.0, false, true));
        assert_eq!(store.closed("main"), Some(saved(850.0, 600.0, true)));
    }

    #[test]
    fn the_last_closed_window_wins_independent_of_label_or_creation_order() {
        let mut store = GeometryStore::default();
        store.register("main", saved(800.0, 600.0, false), false);
        store.register("win-2", saved(1100.0, 760.0, false), false);
        store.closed("win-2");
        assert_eq!(store.latest.width, 1100.0);
        store.closed("main");
        assert_eq!(store.latest.width, 800.0);
        assert_eq!(store.closed("main"), None);
    }

    #[test]
    fn disabling_memory_releases_closed_windows_without_publishing_geometry() {
        let mut store = GeometryStore {
            latest: saved(900.0, 650.0, true),
            remember_size: false,
            ..Default::default()
        };
        store.register("main", SavedGeometry::default(), false);
        store.register("win-2", SavedGeometry::default(), false);
        store.observe("main", observation(1100, 740, 1.0, false, false));
        store.observe("win-2", observation(1200, 780, 1.0, false, false));
        assert_eq!(store.closed("main"), None);
        assert_eq!(store.closed("win-2"), None);
        assert_eq!(store.latest, saved(900.0, 650.0, true));
        assert!(store.windows.is_empty());
    }

    #[test]
    fn reenabling_memory_uses_sizes_observed_while_disabled() {
        let mut store = GeometryStore {
            remember_size: false,
            ..Default::default()
        };
        store.register("main", SavedGeometry::default(), false);
        store.observe("main", observation(1150, 790, 1.0, false, false));
        store.observe("main", observation(1920, 1040, 1.0, false, true));
        store.remember_size = true;
        assert_eq!(store.closed("main"), Some(saved(1150.0, 790.0, true)));
    }

    #[test]
    fn disabled_startup_and_new_windows_ignore_a_previously_maximized_size() {
        let mut store = GeometryStore {
            latest: saved(1250.0, 820.0, true),
            remember_size: false,
            ..Default::default()
        };
        assert_eq!(store.initial_geometry(None), SavedGeometry::default());
        assert_eq!(
            store.initial_geometry(Some((900.0, 650.0))),
            saved(900.0, 650.0, false)
        );
        store.remember_size = true;
        assert_eq!(store.initial_geometry(None), saved(1250.0, 820.0, true));
    }

    #[test]
    fn disabled_closing_does_not_write_a_geometry_file_but_reenabled_closing_does() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window-state.json");
        let previous = saved(900.0, 650.0, true);
        save(&path, previous).unwrap();
        let unchanged = std::fs::read(&path).unwrap();
        let state = WindowGeometryState {
            inner: Mutex::new(GeometryStore {
                latest: previous,
                remember_size: false,
                ..Default::default()
            }),
            path: Some(path.clone()),
        };
        {
            let mut store = state.inner.lock().unwrap();
            store.register("main", SavedGeometry::default(), false);
            store.register("win-2", SavedGeometry::default(), false);
            store.observe("main", observation(1140, 780, 1.0, false, false));
            store.observe("win-2", observation(1050, 750, 1.0, false, false));
        }
        state.close_window("main").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), unchanged);
        state.inner.lock().unwrap().remember_size = true;
        state.close_window("win-2").unwrap();
        assert_eq!(load(&path).unwrap(), Some(saved(1050.0, 750.0, false)));
    }

    #[test]
    fn another_monitor_clamps_to_work_area_without_going_below_minimum() {
        assert_eq!(
            saved(1900.0, 1080.0, true).bounded(Some((1280.0, 760.0))),
            saved(1280.0, 760.0, true)
        );
        assert_eq!(
            saved(100.0, 90.0, false).bounded(Some((500.0, 300.0))),
            saved(MIN_WIDTH, MIN_HEIGHT, false)
        );
    }

    #[test]
    fn invalid_dimensions_and_dpi_never_replace_the_valid_state() {
        let mut store = GeometryStore::default();
        store.register("main", saved(850.0, 600.0, true), false);
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            store.observe("main", observation(900, 650, scale, false, false));
        }
        store.observe("main", observation(0, 650, 1.0, false, false));
        assert_eq!(store.closed("main"), Some(saved(850.0, 600.0, true)));
        assert_eq!(
            saved(f64::NAN, f64::INFINITY, false).bounded(None),
            SavedGeometry::default()
        );
    }

    #[test]
    fn persisted_geometry_survives_reload_and_leaves_editor_settings_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        let state = dir.path().join("nested").join("window-state.json");
        std::fs::write(&settings, br#"{"editor.wordWrap":true}"#).unwrap();
        let geometry = saved(925.0, 675.0, true);
        save(&state, geometry).unwrap();
        assert_eq!(load(&state).unwrap(), Some(geometry));
        assert_eq!(
            std::fs::read(&settings).unwrap(),
            br#"{"editor.wordWrap":true}"#
        );
        save(&state, saved(800.0, 600.0, false)).unwrap();
        assert_eq!(load(&state).unwrap(), Some(saved(800.0, 600.0, false)));
    }

    #[test]
    fn missing_or_unknown_version_has_a_safe_default_and_corrupt_file_can_be_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window-state.json");
        assert_eq!(load(&path).unwrap(), None);
        std::fs::write(
            &path,
            br#"{"version":2,"width":900,"height":650,"maximized":false}"#,
        )
        .unwrap();
        assert_eq!(load(&path).unwrap(), None);
        std::fs::write(&path, b"corrupt").unwrap();
        assert!(load(&path).is_err());
        save(&path, SavedGeometry::default()).unwrap();
        assert_eq!(load(&path).unwrap(), Some(SavedGeometry::default()));
    }
}
