use crate::error::{AppError, Result};

#[cfg(windows)]
pub fn ansi_code_page() -> u32 {
    unsafe { windows::Win32::Globalization::GetACP() }
}

#[cfg(not(windows))]
pub fn ansi_code_page() -> u32 {
    0
}

#[cfg(windows)]
pub fn system_locale() -> Result<String> {
    use windows::Win32::Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName};

    let mut languages = 0u32;
    let mut size = 0u32;
    let preferred = unsafe {
        windows::Win32::Globalization::GetUserPreferredUILanguages(
            windows::Win32::Globalization::MUI_LANGUAGE_NAME,
            &mut languages,
            None,
            &mut size,
        )
        .is_ok()
    };
    if preferred && size > 1 {
        let mut buffer = vec![0u16; size as usize];
        if unsafe {
            windows::Win32::Globalization::GetUserPreferredUILanguages(
                windows::Win32::Globalization::MUI_LANGUAGE_NAME,
                &mut languages,
                Some(windows::core::PWSTR(buffer.as_mut_ptr())),
                &mut size,
            )
            .is_ok()
        } {
            if let Some(end) = buffer.iter().position(|value| *value == 0) {
                if end > 0 {
                    return Ok(String::from_utf16_lossy(&buffer[..end]));
                }
            }
        }
    }

    let lang_id = unsafe { GetUserDefaultUILanguage() } as u32;
    let mut buffer = [0u16; 85];
    let len = unsafe { LCIDToLocaleName(lang_id, Some(&mut buffer), 0) };
    if len > 1 {
        Ok(String::from_utf16_lossy(&buffer[..(len - 1) as usize]))
    } else {
        Err(AppError::Channel("Windows UI language unavailable".into()))
    }
}

#[cfg(target_os = "macos")]
pub fn system_locale() -> Result<String> {
    use std::ffi::c_void;

    #[repr(C)]
    struct CFRange {
        location: isize,
        length: isize,
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFLocaleCopyPreferredLanguages() -> *const c_void;
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFStringGetLength(string: *const c_void) -> isize;
        fn CFStringGetCharacters(string: *const c_void, range: CFRange, buffer: *mut u16);
        fn CFRelease(value: *const c_void);
    }
    struct PreferredLanguages(*const c_void);
    impl Drop for PreferredLanguages {
        fn drop(&mut self) {
            // SAFETY: Copy returned one owned, non-null array and this owner releases it once.
            unsafe { CFRelease(self.0) };
        }
    }

    // SAFETY: The result is a retained CFArray of language identifier CFStrings, or null.
    let languages = unsafe { CFLocaleCopyPreferredLanguages() };
    if languages.is_null() {
        return Err(AppError::Channel(
            "macOS preferred languages unavailable".into(),
        ));
    }
    let languages = PreferredLanguages(languages);
    // SAFETY: This owner keeps the array and its CFString elements alive during the copy.
    unsafe {
        if CFArrayGetCount(languages.0) == 0 {
            return Err(AppError::Channel(
                "macOS preferred language list is empty".into(),
            ));
        }
        let string = CFArrayGetValueAtIndex(languages.0, 0);
        if string.is_null() {
            return Err(AppError::Channel(
                "macOS preferred language is unavailable".into(),
            ));
        }
        let length = CFStringGetLength(string);
        if length <= 0 {
            return Err(AppError::Channel(
                "macOS preferred language is empty".into(),
            ));
        }
        let mut buffer = vec![0u16; length as usize];
        CFStringGetCharacters(
            string,
            CFRange {
                location: 0,
                length,
            },
            buffer.as_mut_ptr(),
        );
        normalize_locale_tag(&String::from_utf16_lossy(&buffer))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn system_locale() -> Result<String> {
    Err(AppError::Unsupported(
        "native UI language detection is available on Windows and macOS".into(),
    ))
}

#[cfg(any(target_os = "macos", test))]
fn normalize_locale_tag(value: &str) -> Result<String> {
    let tag = value.trim().replace('_', "-");
    let mut subtags = tag.split('-');
    let language = subtags.next().unwrap_or_default();
    if !(2..=8).contains(&language.len())
        || !language.bytes().all(|byte| byte.is_ascii_alphabetic())
        || !subtags
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric()))
    {
        return Err(AppError::Channel("invalid preferred UI language".into()));
    }
    Ok(tag)
}

#[cfg(windows)]
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{mpsc, OnceLock},
    thread,
    time::Duration,
};

#[cfg(windows)]
const SPELL_CHECK_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(windows)]
type SpellCheckResult = Result<Vec<String>>;

#[cfg(windows)]
struct SpellRequest {
    words: Vec<String>,
    reply: mpsc::Sender<SpellCheckResult>,
}

#[cfg(windows)]
// This sender is intentionally process-scoped and never dropped. The worker keeps
// its COM apartment and checker alive until process termination.
static SPELL_WORKER: OnceLock<std::result::Result<mpsc::Sender<SpellRequest>, String>> =
    OnceLock::new();

#[cfg(windows)]
struct ComApartment;

#[cfg(windows)]
impl ComApartment {
    fn initialize() -> std::result::Result<Self, String> {
        let result = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
        };
        result
            .ok()
            .map(|_| Self)
            .map_err(|error| format!("COM initialization failed: {error:?}"))
    }
}

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(windows)]
pub fn spell_check(words: &[String]) -> Result<Vec<String>> {
    if words.len() > 2000 || words.iter().any(|word| word.chars().count() > 64) {
        return Err(AppError::InvalidArgument(
            "spell_check accepts at most 2000 words of 64 characters each".into(),
        ));
    }

    let worker = spell_worker_sender()?;
    let (reply, result) = mpsc::channel();
    worker
        .send(SpellRequest {
            words: words.to_vec(),
            reply,
        })
        .map_err(|_| AppError::Unsupported("spell-check worker stopped".into()))?;

    match result.recv_timeout(SPELL_CHECK_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(AppError::Unsupported(
            "spell-check provider timed out".into(),
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(AppError::Unsupported("spell-check worker stopped".into()))
        }
    }
}

#[cfg(windows)]
fn spell_worker_sender() -> Result<&'static mpsc::Sender<SpellRequest>> {
    match SPELL_WORKER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        let result = thread::Builder::new()
            .name("boshu-spell-check".into())
            .spawn(move || spell_worker_loop(receiver));
        match result {
            Ok(_) => Ok(sender),
            Err(error) => Err(format!("could not start spell-check worker: {error}")),
        }
    }) {
        Ok(sender) => Ok(sender),
        Err(error) => Err(AppError::Unsupported(error.clone())),
    }
}

#[cfg(windows)]
fn spell_worker_loop(receiver: mpsc::Receiver<SpellRequest>) {
    let apartment = match ComApartment::initialize() {
        Ok(apartment) => apartment,
        Err(error) => {
            send_worker_startup_error(receiver, error);
            return;
        }
    };
    let checker = match create_spell_checker() {
        Ok(checker) => checker,
        Err(error) => {
            let message = error.to_string();
            // There are no COM objects left after checker creation failed.
            drop(apartment);
            send_worker_startup_error(receiver, message);
            return;
        }
    };

    while let Ok(request) = receiver.recv() {
        let result = catch_unwind(AssertUnwindSafe(|| {
            spell_check_with_checker(&checker, &request.words)
        }))
        .unwrap_or_else(|_| {
            Err(AppError::Unsupported(
                "spell-check provider panicked".into(),
            ))
        });
        let _ = request.reply.send(result);
    }

    // Release COM objects before uninitializing COM if the channel ever closes.
    drop(checker);
    drop(apartment);
}

#[cfg(windows)]
fn send_worker_startup_error(receiver: mpsc::Receiver<SpellRequest>, message: String) {
    while let Ok(request) = receiver.recv() {
        let _ = request
            .reply
            .send(Err(AppError::Unsupported(message.clone())));
    }
}

#[cfg(windows)]
fn create_spell_checker() -> Result<windows::Win32::Globalization::ISpellChecker> {
    use windows::{
        core::w,
        Win32::{
            Globalization::{ISpellCheckerFactory, SpellCheckerFactory},
            System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
        },
    };

    let factory: ISpellCheckerFactory =
        unsafe { CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }.map_err(
            |err| AppError::Unsupported(format!("Windows spell checking API unavailable: {err}")),
        )?;
    let supported = unsafe { factory.IsSupported(w!("en-US")) }
        .map_err(|err| AppError::Unsupported(format!("en-US spell checker unavailable: {err}")))?;
    if !supported.as_bool() {
        return Err(AppError::Unsupported(
            "en-US spell checker unavailable".into(),
        ));
    }
    unsafe { factory.CreateSpellChecker(w!("en-US")) }
        .map_err(|err| AppError::Unsupported(format!("cannot create en-US spell checker: {err}")))
}

#[cfg(windows)]
fn spell_check_with_checker(
    checker: &windows::Win32::Globalization::ISpellChecker,
    words: &[String],
) -> Result<Vec<String>> {
    use windows::{
        core::PCWSTR,
        Win32::{Foundation::S_FALSE, Globalization::ISpellingError},
    };

    let mut misspelled = Vec::new();
    for word in words {
        let wide: Vec<u16> = word.encode_utf16().chain(Some(0)).collect();
        let errors = unsafe { checker.Check(PCWSTR(wide.as_ptr())) }
            .map_err(|err| AppError::Unsupported(format!("spell checker failed: {err}")))?;
        loop {
            let mut error = None::<ISpellingError>;
            let status = unsafe { errors.Next(&mut error) };
            if status == S_FALSE {
                break;
            }
            status.ok().map_err(|err| {
                AppError::Unsupported(format!("spell checker enumeration failed: {err}"))
            })?;
            if error.is_some() {
                misspelled.push(word.clone());
                break;
            }
        }
    }
    Ok(misspelled)
}

#[cfg(not(windows))]
pub fn spell_check(words: &[String]) -> Result<Vec<String>> {
    if words.len() > 2000 || words.iter().any(|word| word.chars().count() > 64) {
        return Err(AppError::InvalidArgument(
            "spell_check accepts at most 2000 words of 64 characters each".into(),
        ));
    }
    Err(AppError::Unsupported(
        "Windows spell checking API is unavailable".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn locale_is_nonempty() {
        assert!(!system_locale().unwrap().is_empty());
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn unavailable_locale_allows_the_frontend_system_language_fallback() {
        assert!(matches!(system_locale(), Err(AppError::Unsupported(_))));
    }

    #[test]
    fn preferred_language_tags_preserve_script_and_normalize_apple_separators() {
        assert_eq!(normalize_locale_tag("zh-Hans-CN").unwrap(), "zh-Hans-CN");
        assert_eq!(normalize_locale_tag("zh_Hant_TW").unwrap(), "zh-Hant-TW");
        assert_eq!(normalize_locale_tag("ja_JP").unwrap(), "ja-JP");
        assert_eq!(normalize_locale_tag("en-US").unwrap(), "en-US");
        assert!(normalize_locale_tag("").is_err());
        assert!(normalize_locale_tag("not a locale").is_err());
    }

    #[test]
    fn spell_check_enforces_limits() {
        let words = vec!["x".repeat(65)];
        assert!(matches!(
            spell_check(&words),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn spell_check_smoke_or_unsupported() {
        if !is_en_us_supported() {
            return;
        }

        let mut input = vec!["helo".to_owned(), "wrold".to_owned()];
        input.extend(std::iter::repeat_n("hello".to_owned(), 198));
        for _ in 0..50 {
            match spell_check(&input) {
                Ok(words) => {
                    assert!(words.iter().any(|word| word == "helo"));
                    assert!(words.iter().any(|word| word == "wrold"));
                    assert!(!words.iter().any(|word| word == "hello"));
                }
                Err(AppError::Unsupported(_)) => return,
                Err(error) => panic!("unexpected spell check error: {error}"),
            }
        }
    }

    #[cfg(windows)]
    fn is_en_us_supported() -> bool {
        use windows::{
            core::w,
            Win32::{
                Globalization::{ISpellCheckerFactory, SpellCheckerFactory},
                System::Com::{
                    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                    COINIT_MULTITHREADED,
                },
            },
        };

        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if initialized.is_err() {
            return false;
        }
        let supported = (|| {
            let factory: ISpellCheckerFactory =
                unsafe { CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }
                    .ok()?;
            unsafe { factory.IsSupported(w!("en-US")).ok() }.map(|supported| supported.as_bool())
        })()
        .unwrap_or(false);
        unsafe { CoUninitialize() };
        supported
    }
}
