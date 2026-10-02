use std::io::Read;

use chardetng::EncodingDetector;
use encoding_rs::{
    CoderResult, Encoding, BIG5, EUC_KR, GB18030, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8,
};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

pub const SAMPLE_SIZE: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Eol {
    Lf,
    Crlf,
    Cr,
    Mixed,
}

#[derive(Clone, Copy, Debug)]
pub struct DetectedEncoding {
    pub encoding: &'static Encoding,
    pub has_bom: bool,
    pub bom_len: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingInfo {
    pub id: String,
    pub label: String,
    pub group: String,
    pub bom: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnsiEncodingInfo {
    pub code_page: u32,
    pub id: String,
}

#[derive(Debug)]
pub struct DecodedText {
    pub text: String,
    pub malformed: bool,
}

pub fn sample<R: Read>(reader: &mut R) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(SAMPLE_SIZE as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn bom_encoding(sample: &[u8]) -> Option<DetectedEncoding> {
    if sample.starts_with(&[0xef, 0xbb, 0xbf]) {
        Some(DetectedEncoding {
            encoding: UTF_8,
            has_bom: true,
            bom_len: 3,
        })
    } else if sample.starts_with(&[0xff, 0xfe]) {
        Some(DetectedEncoding {
            encoding: UTF_16LE,
            has_bom: true,
            bom_len: 2,
        })
    } else if sample.starts_with(&[0xfe, 0xff]) {
        Some(DetectedEncoding {
            encoding: UTF_16BE,
            has_bom: true,
            bom_len: 2,
        })
    } else {
        None
    }
}

pub fn detect(sample: &[u8]) -> DetectedEncoding {
    if let Some(detected) = bom_encoding(sample) {
        return detected;
    }
    let utf8_prefix = match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(err) => err.error_len().is_none(),
    };
    let encoding = if utf8_prefix {
        UTF_8
    } else {
        let mut detector = EncodingDetector::new();
        detector.feed(sample, true);
        detector.guess(None, true)
    };
    DetectedEncoding {
        encoding,
        has_bom: false,
        bom_len: 0,
    }
}

pub fn resolve_encoding(label: &str) -> Result<&'static Encoding> {
    let normalized = label.trim().to_ascii_lowercase();
    if normalized == "ansi" {
        return ansi_encoding().map(|(_, encoding)| encoding);
    }
    let codec_label = normalized.strip_suffix("-bom").unwrap_or(&normalized);
    Encoding::for_label(codec_label.as_bytes())
        .ok_or_else(|| AppError::InvalidArgument(format!("unknown encoding: {label}")))
}

pub fn detect_with_override(
    sample: &[u8],
    override_label: Option<&str>,
) -> Result<DetectedEncoding> {
    if let Some(bom) = bom_encoding(sample) {
        return Ok(bom);
    }
    match override_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None | Some("auto") => Ok(detect(sample)),
        Some(label) => Ok(DetectedEncoding {
            encoding: resolve_encoding(label)?,
            has_bom: false,
            bom_len: 0,
        }),
    }
}

pub fn ansi_encoding() -> Result<(u32, &'static Encoding)> {
    #[cfg(windows)]
    {
        let code_page = unsafe { windows::Win32::Globalization::GetACP() };
        let encoding = encoding_for_code_page(code_page).ok_or_else(|| {
            AppError::Unsupported(format!("Windows code page {code_page} is not supported"))
        })?;
        Ok((code_page, encoding))
    }
    #[cfg(not(windows))]
    {
        Err(AppError::Unsupported(
            "system ANSI encoding is only available on Windows".into(),
        ))
    }
}

pub fn encoding_for_code_page(code_page: u32) -> Option<&'static Encoding> {
    match code_page {
        65001 => Some(UTF_8),
        932 => Some(SHIFT_JIS),
        936 => Some(GBK),
        949 => Some(EUC_KR),
        950 => Some(BIG5),
        54936 => Some(GB18030),
        1250 => Encoding::for_label(b"windows-1250"),
        1251 => Encoding::for_label(b"windows-1251"),
        1252 => Encoding::for_label(b"windows-1252"),
        1253 => Encoding::for_label(b"windows-1253"),
        1254 => Encoding::for_label(b"windows-1254"),
        1255 => Encoding::for_label(b"windows-1255"),
        1256 => Encoding::for_label(b"windows-1256"),
        1257 => Encoding::for_label(b"windows-1257"),
        1258 => Encoding::for_label(b"windows-1258"),
        _ => None,
    }
}

pub fn encoding_id(encoding: &'static Encoding) -> String {
    encoding.name().to_ascii_lowercase()
}

pub fn list_encodings() -> Vec<EncodingInfo> {
    let mut entries = vec![
        ("utf-8", "UTF-8", "Unicode", false),
        ("utf-8-bom", "UTF-8", "Unicode", true),
        ("utf-16le", "UTF-16 LE", "Unicode", false),
        ("utf-16le-bom", "UTF-16 LE", "Unicode", true),
        ("utf-16be", "UTF-16 BE", "Unicode", false),
        ("utf-16be-bom", "UTF-16 BE", "Unicode", true),
        ("gbk", "GBK", "Chinese", false),
        ("gb18030", "GB18030", "Chinese", false),
        ("big5", "Big5", "Chinese", false),
        ("shift_jis", "Shift_JIS", "Japanese", false),
        ("euc-jp", "EUC-JP", "Japanese", false),
        ("euc-kr", "EUC-KR", "Korean", false),
    ];
    if let Ok((code_page, encoding)) = ansi_encoding() {
        entries.push((
            Box::leak("ansi".to_owned().into_boxed_str()),
            Box::leak(format!("ANSI (CP{code_page}, {})", encoding.name()).into_boxed_str()),
            "System",
            false,
        ));
    }
    for number in 1250..=1258 {
        entries.push((
            Box::leak(format!("windows-{number}").into_boxed_str()),
            Box::leak(format!("Windows-{number}").into_boxed_str()),
            "Western",
            false,
        ));
    }
    entries
        .into_iter()
        .filter(|(id, _, _, _)| resolve_encoding(id).is_ok())
        .map(|(id, label, group, bom)| EncodingInfo {
            id: id.to_owned(),
            label: label.to_owned(),
            group: group.to_owned(),
            bom,
        })
        .collect()
}

pub struct StreamDecoder {
    inner: encoding_rs::Decoder,
    malformed: bool,
}

impl StreamDecoder {
    pub fn new(encoding: &'static Encoding) -> Self {
        Self {
            inner: encoding.new_decoder_without_bom_handling(),
            malformed: false,
        }
    }

    pub fn malformed(&self) -> bool {
        self.malformed
    }

    pub fn decode(&mut self, bytes: &[u8], last: bool) -> Result<DecodedText> {
        let mut source = bytes;
        let mut output = Vec::new();
        loop {
            let capacity = source.len().saturating_mul(4).clamp(32, 256 * 1024);
            let mut buffer = vec![0; capacity];
            let (status, read, written, invalid) =
                self.inner.decode_to_utf8(source, &mut buffer, last);
            self.malformed |= invalid;
            output.extend_from_slice(&buffer[..written]);
            source = &source[read..];
            if status == CoderResult::InputEmpty {
                break;
            }
        }
        Ok(DecodedText {
            text: String::from_utf8(output).map_err(|err| AppError::Encoding(err.to_string()))?,
            malformed: self.malformed,
        })
    }
}

#[derive(Default)]
pub struct EolNormalizer {
    pending_cr: bool,
    saw_lf: bool,
    saw_crlf: bool,
    saw_cr: bool,
    // One character per source line break. Retained for exact mixed-EOL round trips.
    map: String,
}

impl EolNormalizer {
    pub fn push(&mut self, text: &str, last: bool) -> String {
        let mut normalized = String::with_capacity(text.len() + 1);
        for ch in text.chars() {
            if self.pending_cr {
                if ch == '\n' {
                    self.saw_crlf = true;
                    self.map.push('C');
                    normalized.push('\n');
                    self.pending_cr = false;
                    continue;
                }
                self.saw_cr = true;
                self.map.push('R');
                normalized.push('\n');
                self.pending_cr = false;
            }
            match ch {
                '\r' => self.pending_cr = true,
                '\n' => {
                    self.saw_lf = true;
                    self.map.push('L');
                    normalized.push('\n');
                }
                _ => normalized.push(ch),
            }
        }
        if last && self.pending_cr {
            self.saw_cr = true;
            self.map.push('R');
            normalized.push('\n');
            self.pending_cr = false;
        }
        normalized
    }

    pub fn eol(&self) -> Eol {
        match (self.saw_lf, self.saw_crlf, self.saw_cr) {
            (true, false, false) => Eol::Lf,
            (false, true, false) => Eol::Crlf,
            (false, false, true) => Eol::Cr,
            (false, false, false) => Eol::Lf,
            _ => Eol::Mixed,
        }
    }

    pub fn mixed_map(&self) -> Option<&str> {
        (self.eol() == Eol::Mixed).then_some(&self.map)
    }
}

pub fn decode_bytes(bytes: &[u8]) -> Result<(String, DetectedEncoding, Eol, Option<String>, bool)> {
    decode_bytes_with_override(bytes, None)
}

pub fn decode_bytes_with_override(
    bytes: &[u8],
    override_label: Option<&str>,
) -> Result<(String, DetectedEncoding, Eol, Option<String>, bool)> {
    let detected = detect_with_override(&bytes[..bytes.len().min(SAMPLE_SIZE)], override_label)?;
    let mut decoder = StreamDecoder::new(detected.encoding);
    let decoded = decoder.decode(&bytes[detected.bom_len..], true)?;
    let mut eols = EolNormalizer::default();
    let text = eols.push(&decoded.text, true);
    Ok((
        text,
        detected,
        eols.eol(),
        eols.mixed_map().map(str::to_owned),
        decoded.malformed,
    ))
}

pub fn encode(
    text: &str,
    label: &str,
    eol: Eol,
    has_bom: bool,
    eol_map: Option<&str>,
    allow_lossy: bool,
) -> Result<Vec<u8>> {
    let encoding = resolve_encoding(label)?;
    if eol == Eol::Mixed && eol_map.is_none() {
        return Err(AppError::InvalidArgument(
            "mixed EOL requires eolMap".into(),
        ));
    }
    if let Some(map) = eol_map {
        if !map
            .bytes()
            .all(|byte| byte == b'C' || byte == b'L' || byte == b'R')
        {
            return Err(AppError::InvalidArgument("invalid eolMap".into()));
        }
    }
    let mut restored = String::with_capacity(text.len());
    let mut breaks = eol_map.unwrap_or("").bytes();
    for part in text.split_inclusive('\n') {
        if let Some(content) = part.strip_suffix('\n') {
            restored.push_str(content);
            match eol {
                Eol::Lf => restored.push('\n'),
                Eol::Crlf => restored.push_str("\r\n"),
                Eol::Cr => restored.push('\r'),
                Eol::Mixed => match breaks.next() {
                    Some(b'C') => restored.push_str("\r\n"),
                    Some(b'L') => restored.push('\n'),
                    Some(b'R') => restored.push('\r'),
                    None => restored.push('\n'),
                    _ => return Err(AppError::InvalidArgument("invalid eolMap".into())),
                },
            }
        } else {
            restored.push_str(part);
        }
    }
    let mut result = Vec::new();
    if has_bom {
        if encoding == UTF_8 {
            result.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        } else if encoding == UTF_16LE {
            result.extend_from_slice(&[0xff, 0xfe]);
        } else if encoding == UTF_16BE {
            result.extend_from_slice(&[0xfe, 0xff]);
        } else {
            return Err(AppError::InvalidArgument(
                "BOM is supported only for UTF-8 and UTF-16".into(),
            ));
        }
    }
    if encoding == UTF_16LE || encoding == UTF_16BE {
        for unit in restored.encode_utf16() {
            let bytes = if encoding == UTF_16LE {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            };
            result.extend_from_slice(&bytes);
        }
    } else if encoding == UTF_8 {
        result.extend_from_slice(restored.as_bytes());
    } else {
        let (bytes, _, unmappable) = encoding.encode(&restored);
        if unmappable {
            let mut count = 0;
            let mut first = None;
            let mut lossy = String::with_capacity(restored.len());
            for ch in restored.chars() {
                let value = ch.to_string();
                if encoding.encode(&value).2 {
                    count += 1;
                    first.get_or_insert(ch);
                    if allow_lossy {
                        lossy.push('?');
                    } else {
                        lossy.push(ch);
                    }
                } else {
                    lossy.push(ch);
                }
            }
            if !allow_lossy {
                return Err(AppError::Unmappable {
                    count,
                    first: first.unwrap_or('?'),
                });
            }
            let (bytes, _, still_unmappable) = encoding.encode(&lossy);
            if still_unmappable {
                return Err(AppError::Unmappable {
                    count,
                    first: first.unwrap_or('?'),
                });
            }
            result.extend_from_slice(&bytes);
        } else {
            result.extend_from_slice(&bytes);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gbk_round_trip() {
        let text = "中文测试文件，简体汉字内容。编辑器编码保存。\n";
        let bytes = encode(text, "gbk", Eol::Lf, false, None, false).unwrap();
        let (decoded, info, eol, _, malformed) = decode_bytes(&bytes).unwrap();
        assert_eq!(info.encoding.name(), "GBK");
        assert_eq!(eol, Eol::Lf);
        assert!(!malformed);
        assert_eq!(decoded, text);
    }

    #[test]
    fn utf16be_bom_and_crlf() {
        let bytes = encode("甲\n乙\n", "utf-16be", Eol::Crlf, true, None, false).unwrap();
        let (text, info, eol, _, malformed) = decode_bytes(&bytes).unwrap();
        assert!(info.has_bom);
        assert_eq!(info.encoding, UTF_16BE);
        assert_eq!(eol, Eol::Crlf);
        assert!(!malformed);
        assert_eq!(
            encode(&text, info.encoding.name(), eol, true, None, false).unwrap(),
            bytes
        );
    }

    #[test]
    fn rejects_invalid_mixed_map_and_reports_unrepresentable_text() {
        assert!(encode("a\n", "utf-8", Eol::Mixed, false, Some("X"), false).is_err());
        assert!(matches!(
            encode("😀", "gbk", Eol::Lf, false, None, false),
            Err(AppError::Unmappable {
                count: 1,
                first: '😀'
            })
        ));
        assert_eq!(
            encode("😀", "gbk", Eol::Lf, false, None, true).unwrap(),
            b"?".to_vec()
        );
    }

    #[test]
    fn mixed_and_bare_cr_round_trip() {
        let original = b"first\r\nsecond\nthird\r\nfourth\r";
        let (text, _, eol, map, malformed) = decode_bytes(original).unwrap();
        assert_eq!(text, "first\nsecond\nthird\nfourth\n");
        assert_eq!(eol, Eol::Mixed);
        assert_eq!(map.as_deref(), Some("CLCR"));
        assert!(!malformed);
        assert_eq!(
            encode(&text, "utf-8", eol, false, map.as_deref(), false).unwrap(),
            original
        );

        let (text, _, eol, map, _) = decode_bytes(b"a\rb\r").unwrap();
        assert_eq!(text, "a\nb\n");
        assert_eq!(eol, Eol::Cr);
        assert_eq!(map, None);
    }

    #[test]
    fn malformed_input_sets_flag_and_forced_encoding_wins_without_bom() {
        let (_, _, _, _, malformed) = decode_bytes_with_override(b"\xff", Some("utf-8")).unwrap();
        assert!(malformed);
        let (text, info, _, _, _) =
            decode_bytes_with_override("中文".as_bytes(), Some("utf-8")).unwrap();
        assert_eq!(text, "中文");
        assert_eq!(info.encoding, UTF_8);
    }
}
