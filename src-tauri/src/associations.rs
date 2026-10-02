use serde::Serialize;

use crate::error::{AppError, Result};

const CLASSES: &str = r"Software\Classes";
const CAPABILITIES: &str = r"Software\Boshu\Capabilities";
const ASSOCIATIONS: &str = r"Software\Boshu\Capabilities\FileAssociations";
const REGISTERED_APPS: &str = r"Software\RegisteredApplications";
const APP_PATH: &str = r"Software\Classes\Applications\boshu.exe";
const LEGACY_PROG_IDS: &[&str] = &["Boshu.File", "Boshu.Code", "Boshu.Text"];
const CODE_EXTENSIONS: &[&str] = &[
    "js", "ts", "jsx", "tsx", "json", "py", "rs", "c", "h", "cpp", "hpp", "java", "go", "html",
    "css", "xml", "yaml", "yml", "sql", "toml", "sh", "bat", "ps1", "lua",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IconKind {
    Code,
    Text,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CliAssociationCommand {
    Register(Vec<String>),
    Unregister(Vec<String>),
    UnregisterAll,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociationStatus {
    ext: String,
    registered: bool,
    is_default: Option<bool>,
}

fn validate_exts(exts: &[String]) -> Result<()> {
    for ext in exts {
        if ext.is_empty()
            || ext.len() > 16
            || !ext
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_+-".contains(&c))
        {
            return Err(AppError::InvalidArgument(format!(
                "invalid extension: {ext}"
            )));
        }
    }
    Ok(())
}

fn parse_ext_arg(value: Option<&String>) -> Result<Vec<String>> {
    let value = value.ok_or_else(|| {
        AppError::InvalidArgument(
            "association command requires a comma-separated extension list".into(),
        )
    })?;
    let exts: Vec<String> = value.split(',').map(str::to_owned).collect();
    validate_exts(&exts)?;
    if exts.is_empty() {
        return Err(AppError::InvalidArgument(
            "association extension list cannot be empty".into(),
        ));
    }
    Ok(exts)
}

pub fn parse_cli_args(args: &[String]) -> Option<Result<CliAssociationCommand>> {
    let operation = args.get(1)?.as_str();
    let parsed = match operation {
        "--register-assoc" => {
            if args.len() != 3 {
                Err(AppError::InvalidArgument(
                    "--register-assoc expects one comma-separated extension list".into(),
                ))
            } else {
                parse_ext_arg(args.get(2)).map(CliAssociationCommand::Register)
            }
        }
        "--unregister-assoc" => {
            if args.len() != 3 {
                Err(AppError::InvalidArgument(
                    "--unregister-assoc expects an extension list or all".into(),
                ))
            } else if args.get(2).is_some_and(|value| value == "all") {
                Ok(CliAssociationCommand::UnregisterAll)
            } else {
                parse_ext_arg(args.get(2)).map(CliAssociationCommand::Unregister)
            }
        }
        _ => return None,
    };
    Some(parsed)
}

fn prog_id(ext: &str) -> String {
    format!("Boshu.{ext}")
}

fn icon_kind(ext: &str) -> IconKind {
    if CODE_EXTENSIONS.contains(&ext) {
        IconKind::Code
    } else {
        IconKind::Text
    }
}

fn icon_file_name(kind: IconKind) -> &'static str {
    match kind {
        IconKind::Code => "file-code.ico",
        IconKind::Text => "file-text.ico",
    }
}

fn icon_path(exe: &std::path::Path, kind: IconKind) -> Option<std::path::PathBuf> {
    let path = exe.parent()?.join("icons").join(icon_file_name(kind));
    path.is_file().then_some(path)
}

fn icon_value(exe: &std::path::Path, kind: IconKind) -> String {
    icon_path(exe, kind)
        .map(|path| format!("\"{}\",0", path.display()))
        .unwrap_or_else(|| format!("\"{}\",0", exe.display()))
}

fn is_legacy_prog_id(id: &str) -> bool {
    LEGACY_PROG_IDS
        .iter()
        .any(|legacy| id.eq_ignore_ascii_case(legacy))
}

fn ext_key(ext: &str) -> String {
    format!(r"{CLASSES}\.{ext}\OpenWithProgids")
}

fn user_choice(ext: &str) -> String {
    format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{ext}\UserChoice")
}

#[cfg(windows)]
mod registry {
    use super::*;
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::{
                ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
            },
            System::Registry::{
                RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegDeleteValueW, RegEnumValueW,
                RegGetValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
                HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, KEY_WRITE, REG_NONE,
                REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
            },
            UI::{
                Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST},
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check(status: windows::Win32::Foundation::WIN32_ERROR) -> Result<()> {
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(AppError::Io(std::io::Error::from_raw_os_error(
                status.0 as i32,
            )))
        }
    }

    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            let _ = unsafe { RegCloseKey(self.0) };
        }
    }

    fn create(path: &str) -> Result<Key> {
        let mut key = HKEY::default();
        let name = wide(path);
        check(unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(name.as_ptr()),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                None,
                &mut key,
                None,
            )
        })?;
        Ok(Key(key))
    }

    fn open(
        path: &str,
        access: windows::Win32::System::Registry::REG_SAM_FLAGS,
    ) -> Result<Option<Key>> {
        let mut key = HKEY::default();
        let name = wide(path);
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(name.as_ptr()),
                None,
                access,
                &mut key,
            )
        };
        if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
            Ok(None)
        } else {
            check(status)?;
            Ok(Some(Key(key)))
        }
    }

    fn set(path: &str, name: &str, value: &str) -> Result<()> {
        let key = create(path)?;
        let name = wide(name);
        let data = wide(value);
        let bytes =
            unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), data.len() * 2) };
        check(unsafe { RegSetValueExW(key.0, PCWSTR(name.as_ptr()), None, REG_SZ, Some(bytes)) })
    }

    fn set_none(path: &str, name: &str) -> Result<()> {
        let key = create(path)?;
        let name = wide(name);
        check(unsafe { RegSetValueExW(key.0, PCWSTR(name.as_ptr()), None, REG_NONE, None) })
    }

    fn get(path: &str, name: &str) -> Result<Option<String>> {
        let Some(key) = open(path, KEY_READ)? else {
            return Ok(None);
        };
        let name = wide(name);
        let mut size = 0;
        let status = unsafe {
            RegGetValueW(
                key.0,
                PCWSTR::null(),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        check(status)?;
        let mut buffer = vec![0u16; size as usize / 2];
        check(unsafe {
            RegGetValueW(
                key.0,
                PCWSTR::null(),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        })?;
        Ok(Some(
            String::from_utf16_lossy(&buffer)
                .trim_end_matches('\0')
                .to_owned(),
        ))
    }

    fn exists(path: &str, name: &str) -> Result<bool> {
        let Some(key) = open(path, KEY_READ)? else {
            return Ok(false);
        };
        let name = wide(name);
        let status =
            unsafe { RegQueryValueExW(key.0, PCWSTR(name.as_ptr()), None, None, None, None) };
        if status == ERROR_FILE_NOT_FOUND {
            Ok(false)
        } else {
            check(status)?;
            Ok(true)
        }
    }

    fn delete_value(path: &str, name: &str) -> Result<()> {
        let Some(key) = open(path, KEY_SET_VALUE)? else {
            return Ok(());
        };
        let name = wide(name);
        let status = unsafe { RegDeleteValueW(key.0, PCWSTR(name.as_ptr())) };
        if status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            check(status)
        }
    }

    fn delete_tree(path: &str) -> Result<()> {
        let name = wide(path);
        let status = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(name.as_ptr())) };
        if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
            Ok(())
        } else {
            check(status)
        }
    }

    fn enum_values(path: &str) -> Result<Vec<String>> {
        let Some(key) = open(path, KEY_READ)? else {
            return Ok(Vec::new());
        };
        let mut values = Vec::new();
        let mut index = 0;
        loop {
            let mut name = vec![0u16; 16_384];
            let mut name_len = (name.len() - 1) as u32;
            let status = unsafe {
                RegEnumValueW(
                    key.0,
                    index,
                    Some(PWSTR(name.as_mut_ptr())),
                    &mut name_len,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                break;
            }
            check(status)?;
            values.push(String::from_utf16_lossy(&name[..name_len as usize]));
            index += 1;
        }
        Ok(values)
    }

    fn notify() {
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    }

    fn command(exe: &std::path::Path) -> String {
        format!("\"{}\" \"%1\"", exe.display())
    }

    pub fn status(exts: Vec<String>) -> Result<Vec<AssociationStatus>> {
        validate_exts(&exts)?;
        let exe = std::env::current_exe()?;
        exts.into_iter()
            .map(|ext| {
                let id = get(ASSOCIATIONS, &format!(".{ext}"))?.unwrap_or_else(|| prog_id(&ext));
                let registered = get(&format!(r"{CLASSES}\{id}\shell\open\command"), "")?
                    .is_some_and(|value| value == command(&exe))
                    && exists(&ext_key(&ext), &id)?;
                let is_default = get(&user_choice(&ext), "ProgId")
                    .ok()
                    .flatten()
                    .map(|value| value.eq_ignore_ascii_case(&id));
                Ok(AssociationStatus {
                    ext,
                    registered,
                    is_default,
                })
            })
            .collect()
    }

    pub fn register(exts: Vec<String>) -> Result<()> {
        validate_exts(&exts)?;
        if exts.is_empty() {
            return Ok(());
        }
        let exe = std::env::current_exe()?;
        set(APP_PATH, "FriendlyAppName", "帛书")?;
        set(
            &format!(r"{APP_PATH}\shell\open\command"),
            "",
            &command(&exe),
        )?;
        set(CAPABILITIES, "ApplicationName", "帛书")?;
        set(CAPABILITIES, "ApplicationDescription", "帛书文本编辑器")?;
        set(REGISTERED_APPS, "Boshu", CAPABILITIES)?;
        for ext in exts {
            let id = prog_id(&ext);
            set(&format!(r"{CLASSES}\{id}"), "", &format!("帛书 {ext} file"))?;
            set(
                &format!(r"{CLASSES}\{id}\DefaultIcon"),
                "",
                &icon_value(&exe, icon_kind(&ext)),
            )?;
            set(
                &format!(r"{CLASSES}\{id}\shell\open\command"),
                "",
                &command(&exe),
            )?;
            set_none(&ext_key(&ext), &id)?;
            set_none(&format!(r"{APP_PATH}\SupportedTypes"), &format!(".{ext}"))?;
            set(ASSOCIATIONS, &format!(".{ext}"), &id)?;
        }
        notify();
        Ok(())
    }

    fn association_is_owned(id: &str, exe: &std::path::Path) -> Result<bool> {
        Ok(get(&format!(r"{CLASSES}\{id}\shell\open\command"), "")?
            .is_some_and(|value| value == command(exe)))
    }

    fn has_capability_reference(id: &str) -> Result<bool> {
        Ok(enum_values(ASSOCIATIONS)?.into_iter().any(|name| {
            get(ASSOCIATIONS, &name)
                .ok()
                .flatten()
                .is_some_and(|value| value.eq_ignore_ascii_case(id))
        }))
    }

    pub fn unregister(exts: Vec<String>) -> Result<()> {
        validate_exts(&exts)?;
        let exe = std::env::current_exe()?;
        for ext in exts {
            let extension = format!(".{ext}");
            let id = get(ASSOCIATIONS, &extension)?.unwrap_or_else(|| prog_id(&ext));
            if !association_is_owned(&id, &exe)? {
                continue;
            }

            delete_value(&ext_key(&ext), &id)?;
            delete_value(&format!(r"{APP_PATH}\SupportedTypes"), &extension)?;
            if get(ASSOCIATIONS, &extension)?.as_deref() == Some(id.as_str()) {
                delete_value(ASSOCIATIONS, &extension)?;
            }
            if !has_capability_reference(&id)? {
                delete_tree(&format!(r"{CLASSES}\{id}"))?;
            }
        }
        notify();
        Ok(())
    }

    pub fn unregister_all() -> Result<()> {
        let exe = std::env::current_exe()?;
        let supported_types = enum_values(&format!(r"{APP_PATH}\SupportedTypes"))?;
        let mut exts = enum_values(ASSOCIATIONS)?
            .into_iter()
            .filter_map(|value| value.strip_prefix('.').map(str::to_owned))
            .collect::<Vec<_>>();
        for value in &supported_types {
            if let Some(ext) = value.strip_prefix('.') {
                if !exts.iter().any(|existing| existing == ext) {
                    exts.push(ext.to_owned());
                }
            }
        }

        unregister(exts)?;
        for id in LEGACY_PROG_IDS {
            if !is_legacy_prog_id(id) || !association_is_owned(id, &exe)? {
                continue;
            }
            for value in &supported_types {
                let Some(ext) = value.strip_prefix('.') else {
                    continue;
                };
                delete_value(&ext_key(ext), id)?;
                delete_value(&format!(r"{APP_PATH}\SupportedTypes"), value)?;
            }
            delete_tree(&format!(r"{CLASSES}\{id}"))?;
        }
        let expected_command = command(&exe);
        if get(&format!(r"{APP_PATH}\shell\open\command"), "")?.as_deref()
            == Some(expected_command.as_str())
        {
            delete_tree(APP_PATH)?;
            delete_tree(CAPABILITIES)?;
            delete_value(REGISTERED_APPS, "Boshu")?;
            notify();
        }
        Ok(())
    }

    pub fn open_settings() -> Result<()> {
        use windows::Win32::UI::Shell::ShellExecuteW;
        let uri = wide("ms-settings:defaultapps?registeredAppUser=Boshu");
        let verb = wide("open");
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(uri.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            Err(AppError::Io(std::io::Error::other(
                "cannot open Default Apps settings",
            )))
        } else {
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod registry {
    use super::*;

    pub fn status(_: Vec<String>) -> Result<Vec<AssociationStatus>> {
        Err(AppError::InvalidArgument(
            "file associations are supported on Windows only".into(),
        ))
    }

    pub fn register(_: Vec<String>) -> Result<()> {
        Err(AppError::InvalidArgument(
            "file associations are supported on Windows only".into(),
        ))
    }

    pub fn unregister(_: Vec<String>) -> Result<()> {
        Err(AppError::InvalidArgument(
            "file associations are supported on Windows only".into(),
        ))
    }

    pub fn unregister_all() -> Result<()> {
        Err(AppError::InvalidArgument(
            "file associations are supported on Windows only".into(),
        ))
    }

    pub fn open_settings() -> Result<()> {
        Err(AppError::InvalidArgument(
            "file associations are supported on Windows only".into(),
        ))
    }
}

#[cfg(windows)]
pub use registry::{open_settings, register, status, unregister, unregister_all};

#[cfg(not(windows))]
pub use registry::{open_settings, register, status, unregister, unregister_all};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_icon_and_prog_id_mapping_is_stable() {
        assert_eq!(prog_id("lua"), "Boshu.lua");
        assert_eq!(prog_id("md"), "Boshu.md");
        assert_eq!(icon_kind("lua"), IconKind::Code);
        assert_eq!(icon_kind("rs"), IconKind::Code);
        assert_eq!(icon_kind("md"), IconKind::Text);
        assert_eq!(icon_kind("markdown"), IconKind::Text);
        assert_eq!(icon_kind("txt"), IconKind::Text);
        assert_eq!(icon_file_name(IconKind::Code), "file-code.ico");
        assert_eq!(icon_file_name(IconKind::Text), "file-text.ico");
        assert!(is_legacy_prog_id("Boshu.File"));
        assert!(is_legacy_prog_id("boshu.text"));
        assert!(!is_legacy_prog_id("Boshu.lua"));
    }
    #[test]
    fn cli_association_arguments_are_parsed_and_validated() {
        let args = |values: &[&str]| {
            values
                .iter()
                .map(|value| (*value).into())
                .collect::<Vec<String>>()
        };

        assert_eq!(
            parse_cli_args(&args(&["boshu.exe", "--register-assoc", "txt,md"]))
                .unwrap()
                .unwrap(),
            CliAssociationCommand::Register(vec!["txt".into(), "md".into()]),
        );
        assert_eq!(
            parse_cli_args(&args(&["boshu.exe", "--unregister-assoc", "all"]))
                .unwrap()
                .unwrap(),
            CliAssociationCommand::UnregisterAll,
        );
        assert_eq!(
            parse_cli_args(&args(&["boshu.exe", "--unregister-assoc", "txt,lua"]))
                .unwrap()
                .unwrap(),
            CliAssociationCommand::Unregister(vec!["txt".into(), "lua".into()]),
        );
        assert!(
            parse_cli_args(&args(&["boshu.exe", "--register-assoc", ".txt"]))
                .unwrap()
                .is_err()
        );
        assert!(
            parse_cli_args(&args(&["boshu.exe", "--register-assoc", "txt,MD"]))
                .unwrap()
                .is_err()
        );
        assert!(parse_cli_args(&args(&["boshu.exe", "--register-assoc"]))
            .unwrap()
            .is_err());
        assert!(
            parse_cli_args(&args(&["boshu.exe", "--register-assoc", "txt", "extra"]))
                .unwrap()
                .is_err()
        );
        assert!(
            parse_cli_args(&args(&["boshu.exe", "--unregister-assoc", ""]))
                .unwrap()
                .is_err()
        );
        assert!(parse_cli_args(&args(&["boshu.exe", "--unknown"])).is_none());
    }
}
