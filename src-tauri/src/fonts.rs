#[cfg(windows)]
pub fn list_system_fonts() -> crate::error::Result<Vec<String>> {
    use std::collections::BTreeSet;
    use windows::{
        core::{BOOL, HSTRING},
        Win32::Graphics::DirectWrite::{
            DWriteCreateFactory, IDWriteFactory, DWRITE_FACTORY_TYPE_SHARED,
        },
    };

    // DirectWrite's system collection includes per-user fonts on supported Windows releases.
    let factory: IDWriteFactory = unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }
        .map_err(|err| crate::error::AppError::Channel(err.to_string()))?;
    let mut collection = None;
    unsafe { factory.GetSystemFontCollection(&mut collection, false) }
        .map_err(|err| crate::error::AppError::Channel(err.to_string()))?;
    let collection = collection.ok_or_else(|| {
        crate::error::AppError::Channel("DirectWrite font collection unavailable".into())
    })?;
    let mut families = BTreeSet::new();
    for index in 0..unsafe { collection.GetFontFamilyCount() } {
        let family = unsafe { collection.GetFontFamily(index) }
            .map_err(|err| crate::error::AppError::Channel(err.to_string()))?;
        let names = unsafe { family.GetFamilyNames() }
            .map_err(|err| crate::error::AppError::Channel(err.to_string()))?;
        let mut name_index = 0;
        for locale in ["zh-cn", "en-us"] {
            let mut exists = BOOL(0);
            unsafe { names.FindLocaleName(&HSTRING::from(locale), &mut name_index, &mut exists) }
                .map_err(|err| crate::error::AppError::Channel(err.to_string()))?;
            if exists.as_bool() {
                break;
            }
            name_index = 0;
        }
        let length = unsafe { names.GetStringLength(name_index) }
            .map_err(|err| crate::error::AppError::Channel(err.to_string()))?;
        let mut buffer = vec![0u16; length as usize + 1];
        unsafe { names.GetString(name_index, &mut buffer) }
            .map_err(|err| crate::error::AppError::Channel(err.to_string()))?;
        let name = String::from_utf16_lossy(&buffer[..length as usize]);
        if !name.is_empty() {
            families.insert(name);
        }
    }
    Ok(families.into_iter().collect())
}

#[cfg(target_os = "macos")]
pub fn list_system_fonts() -> crate::error::Result<Vec<String>> {
    use std::{collections::BTreeSet, ffi::c_void};

    #[repr(C)]
    struct CFRange {
        location: isize,
        length: isize,
    }

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFStringGetLength(string: *const c_void) -> isize;
        fn CFStringGetCharacters(string: *const c_void, range: CFRange, buffer: *mut u16);
        fn CFRelease(value: *const c_void);
    }

    struct FamilyNames(*const c_void);
    impl Drop for FamilyNames {
        fn drop(&mut self) {
            // SAFETY: Copy returned one retained, non-null array; this owner releases it once.
            unsafe { CFRelease(self.0) };
        }
    }

    // SAFETY: CoreText returns a retained CFArray of CFString family names, or null on error.
    let names = unsafe { CTFontManagerCopyAvailableFontFamilyNames() };
    if names.is_null() {
        return Err(crate::error::AppError::Channel(
            "CoreText font collection unavailable".into(),
        ));
    }
    let names = FamilyNames(names);
    let mut families = BTreeSet::new();
    // SAFETY: The array stays owned and valid throughout enumeration; its elements are CFStrings.
    unsafe {
        for index in 0..CFArrayGetCount(names.0) {
            let string = CFArrayGetValueAtIndex(names.0, index);
            if string.is_null() {
                continue;
            }
            let length = CFStringGetLength(string);
            if length <= 0 {
                continue;
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
            families.insert(String::from_utf16_lossy(&buffer));
        }
    }
    Ok(families.into_iter().collect())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn list_system_fonts() -> crate::error::Result<Vec<String>> {
    Err(crate::error::AppError::Unsupported(
        "system font enumeration is available on Windows and macOS".into(),
    ))
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn enumerates_installed_families() {
        let families = super::list_system_fonts().unwrap();
        assert!(!families.is_empty());
        assert!(families
            .iter()
            .any(|name| name == "Consolas" || name == "Segoe UI"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn enumerates_installed_macos_families() {
        let families = super::list_system_fonts().unwrap();
        assert!(!families.is_empty());
        assert!(families
            .iter()
            .any(|name| name == "Menlo" || name == "Helvetica"));
        assert!(families.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
