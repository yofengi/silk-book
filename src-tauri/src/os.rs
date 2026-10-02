//! 操作系统信息。WebView2 的 userAgentData 高熵值在部分环境不可用或很慢，
//! 因此 Windows build 号由 Rust 直接读注册表。

/// Windows build 号（如 22631）；读取失败或非 Windows 返回 0。
#[cfg(windows)]
pub fn build_number() -> u32 {
    use windows::{
        core::w,
        Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ},
    };
    let mut buf = [0u16; 32];
    let mut len = std::mem::size_of_val(&buf) as u32;
    // SAFETY: buf/len 描述同一块可写缓冲区；RRF_RT_REG_SZ 保证返回以 NUL 结尾的 UTF-16 字符串。
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if status.is_err() {
        return 0;
    }
    parse_build(&String::from_utf16_lossy(&buf))
}

#[cfg(not(windows))]
pub fn build_number() -> u32 {
    0
}

/// 解析注册表字符串（可能带 NUL 结尾），非法返回 0。
pub fn parse_build(s: &str) -> u32 {
    s.trim_end_matches('\0').trim().parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_registry_strings() {
        assert_eq!(parse_build("22631\0\0\0"), 22631);
        assert_eq!(parse_build(" 19045 "), 19045);
        assert_eq!(parse_build(""), 0);
        assert_eq!(parse_build("abc"), 0);
    }

    #[cfg(windows)]
    #[test]
    fn reads_real_build() {
        // Windows 10 起 build 号 >= 10240
        assert!(build_number() >= 10240);
    }
}
