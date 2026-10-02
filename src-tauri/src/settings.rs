use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::{Map, Value};

use crate::error::{AppError, Result};

#[derive(Clone, Default)]
pub struct SettingsState(Arc<Mutex<u64>>);

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub value: Value,
    pub revision: u64,
}

impl SettingsState {
    /// Keep persistence, revision allocation and publication in the same order.
    /// A slower publisher must not let another window announce a later commit first.
    pub fn patch_and_publish(
        &self,
        path: &std::path::Path,
        set: Option<Map<String, Value>>,
        remove: Option<Vec<String>>,
        publish: impl FnOnce(&SettingsSnapshot),
    ) -> Result<SettingsSnapshot> {
        self.commit(|| patch(path, set, remove), publish)
    }

    pub fn replace_and_publish(
        &self,
        path: &std::path::Path,
        value: Value,
        publish: impl FnOnce(&SettingsSnapshot),
    ) -> Result<SettingsSnapshot> {
        self.commit(
            || {
                save(path, &value)?;
                Ok(value)
            },
            publish,
        )
    }

    fn commit(
        &self,
        update: impl FnOnce() -> Result<Value>,
        publish: impl FnOnce(&SettingsSnapshot),
    ) -> Result<SettingsSnapshot> {
        let mut revision = self
            .0
            .lock()
            .map_err(|err| AppError::Channel(err.to_string()))?;
        let value = update()?;
        *revision += 1;
        let snapshot = SettingsSnapshot {
            value,
            revision: *revision,
        };
        publish(&snapshot);
        Ok(snapshot)
    }
}

/// Keep the existing Windows location and use native per-user locations elsewhere.
pub fn app_config_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA")
            .ok_or_else(|| AppError::InvalidArgument("APPDATA is not set".into()))?;
        Ok(PathBuf::from(appdata).join("Boshu"))
    }
    #[cfg(target_os = "macos")]
    {
        let home_dir = std::env::var_os("HOME")
            .ok_or_else(|| AppError::InvalidArgument("HOME is not set".into()))?;
        Ok(PathBuf::from(home_dir)
            .join("Library")
            .join("Application Support")
            .join("Boshu"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if let Some(config_dir) = std::env::var_os("XDG_CONFIG_HOME") {
            let path = PathBuf::from(config_dir);
            if path.is_absolute() {
                return Ok(path.join("Boshu"));
            }
        }
        let home_dir = std::env::var_os("HOME")
            .ok_or_else(|| AppError::InvalidArgument("HOME is not set".into()))?;
        Ok(PathBuf::from(home_dir).join(".config").join("Boshu"))
    }
}

pub fn settings_path() -> Result<PathBuf> {
    Ok(app_config_dir()?.join("settings.json"))
}

pub fn remember_window_size(value: &Value) -> bool {
    value
        .get("window.rememberSize")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub fn load(path: &std::path::Path) -> Result<Value> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(Value::Object(Default::default()))
        }
        Err(err) => Err(err.into()),
    }
}

pub fn save(path: &std::path::Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    std::fs::create_dir_all(
        path.parent()
            .ok_or_else(|| AppError::InvalidArgument("invalid settings path".into()))?,
    )?;
    crate::fs::write::atomic_write(path, &bytes)
}

pub fn patch(
    path: &std::path::Path,
    set: Option<Map<String, Value>>,
    remove: Option<Vec<String>>,
) -> Result<Value> {
    let mut value = load(path)?;
    let object = value.as_object_mut().ok_or_else(|| {
        AppError::Json(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "settings root must be an object",
        )))
    })?;
    if let Some(set) = set {
        object.extend(set);
    }
    if let Some(remove) = remove {
        for key in remove {
            object.remove(&key);
        }
    }
    save(path, &value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_memory_defaults_to_enabled_and_ignores_invalid_values() {
        for value in [
            serde_json::json!({}),
            serde_json::json!({"window.rememberSize": null}),
            serde_json::json!({"window.rememberSize": "false"}),
            serde_json::json!({"window.rememberSize": true}),
        ] {
            assert!(remember_window_size(&value));
        }
        assert!(!remember_window_size(
            &serde_json::json!({"window.rememberSize": false})
        ));
    }

    #[test]
    fn settings_use_the_platforms_per_user_configuration_directory() {
        let path = settings_path().unwrap();
        #[cfg(windows)]
        assert_eq!(
            path,
            PathBuf::from(std::env::var_os("APPDATA").unwrap())
                .join("Boshu")
                .join("settings.json")
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            path,
            PathBuf::from(std::env::var_os("HOME").unwrap())
                .join("Library/Application Support/Boshu/settings.json")
        );
        assert_eq!(path.file_name().unwrap(), "settings.json");
        assert!(path.is_absolute());
    }

    #[test]
    fn persists_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        assert_eq!(load(&path).unwrap(), serde_json::json!({}));
        let value = serde_json::json!({"futureOption": [1, {"nested": true}]});
        save(&path, &value).unwrap();
        assert_eq!(load(&path).unwrap(), value);
    }

    #[test]
    fn merges_and_removes_without_dropping_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        save(&path, &serde_json::json!({"keep": true, "remove": 1})).unwrap();
        let mut set = Map::new();
        set.insert("new".into(), Value::from(2));
        assert_eq!(
            patch(&path, Some(set), Some(vec!["remove".into()])).unwrap(),
            serde_json::json!({"keep": true, "new": 2})
        );
    }

    #[test]
    fn concurrent_patches_publish_in_commit_order_and_keep_other_window_keys() {
        use std::sync::mpsc;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let state = SettingsState::default();
        let (started, received) = mpsc::sync_channel(1);
        let (release, released) = mpsc::sync_channel(1);
        let published = Arc::new(Mutex::new(Vec::new()));
        let first_state = state.clone();
        let first_path = path.clone();
        let first_published = published.clone();
        let first = std::thread::spawn(move || {
            first_state
                .patch_and_publish(
                    &first_path,
                    Some(
                        serde_json::json!({"first": true})
                            .as_object()
                            .unwrap()
                            .clone(),
                    ),
                    None,
                    |snapshot| {
                        started.send(()).unwrap();
                        released.recv().unwrap();
                        first_published.lock().unwrap().push(snapshot.revision);
                    },
                )
                .unwrap()
        });
        received.recv().unwrap();
        let second_state = state.clone();
        let second_path = path.clone();
        let second_published = published.clone();
        let second = std::thread::spawn(move || {
            second_state
                .patch_and_publish(
                    &second_path,
                    Some(
                        serde_json::json!({"second": true})
                            .as_object()
                            .unwrap()
                            .clone(),
                    ),
                    None,
                    |snapshot| second_published.lock().unwrap().push(snapshot.revision),
                )
                .unwrap()
        });
        release.send(()).unwrap();
        assert_eq!(first.join().unwrap().revision, 1);
        let result = second.join().unwrap();
        assert_eq!(result.revision, 2);
        assert_eq!(
            result.value,
            serde_json::json!({"first": true, "second": true})
        );
        assert_eq!(*published.lock().unwrap(), vec![1, 2]);
        assert_eq!(load(&path).unwrap(), result.value);
    }
}
