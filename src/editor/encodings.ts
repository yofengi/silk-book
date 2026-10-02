// 编码元数据：list_encodings / ansi_encoding 缓存、显示名、默认编码 / 换行的解析
import { getSetting } from '../core/settings';
import { ipc, type AnsiEncoding, type EncodingInfo, type Eol } from '../ipc';

let listP: Promise<EncodingInfo[]> | null = null;
let ansiP: Promise<AnsiEncoding | null> | null = null;
let ansi: AnsiEncoding | null = null;

export function loadEncodings(): Promise<EncodingInfo[]> {
  listP ??= ipc.listEncodings().catch((e: unknown) => {
    console.error('list_encodings failed', e);
    listP = null;
    return [];
  });
  return listP;
}

export function loadAnsi(): Promise<AnsiEncoding | null> {
  ansiP ??= ipc.ansiEncoding().then((a) => (ansi = a)).catch(() => null);
  return ansiP;
}

/** encoding_rs 名称 / 列表 id → 显示名（不含 BOM 后缀） */
const NAMES: Record<string, string> = {
  'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', gbk: 'GBK', gb18030: 'GB18030', big5: 'Big5',
  shift_jis: 'Shift_JIS', 'euc-jp': 'EUC-JP', 'euc-kr': 'EUC-KR',
};

export function encodingName(enc: string): string {
  const k = enc.toLowerCase().replace(/-bom$/, '');
  if (k === 'ansi') return ansi ? `ANSI (${encodingName(ansi.id)})` : 'ANSI';
  if (NAMES[k]) return NAMES[k];
  const w = /^windows-(\d+)$/.exec(k);
  return w ? `Windows-${w[1]}` : enc;
}

/** 状态栏显示：UTF-8 / UTF-8 BOM / UTF-16 LE BOM / GBK … */
export function encodingLabel(enc: string, bom: boolean): string {
  const unicode = /^utf-(8|16)/i.test(enc);
  return encodingName(enc) + (bom && unicode ? ' BOM' : '');
}

/** 两个编码标识是否指同一编码（忽略大小写 / BOM 后缀；ansi 与其实际代码页等同） */
export function sameEncoding(a: string, b: string): boolean {
  const n = (x: string) => {
    const k = x.toLowerCase().replace(/-bom$/, '');
    return k === 'ansi' && ansi ? ansi.id.toLowerCase() : k;
  };
  return n(a) === n(b);
}

/** 列表 id 'ansi' → 实际编码 id（如 gbk），便于状态栏显示；未知时原样交后端解析 */
export function resolveAnsi(id: string): string {
  return id.toLowerCase() === 'ansi' && ansi ? ansi.id : id;
}

/** files.defaultEncoding → { encoding, hasBom } */
export function defaultEncoding(): { encoding: string; hasBom: boolean } {
  switch (getSetting('files.defaultEncoding')) {
    case 'utf-8-bom': return { encoding: 'UTF-8', hasBom: true };
    case 'utf-16le-bom': return { encoding: 'UTF-16LE', hasBom: true };
    case 'utf-16be-bom': return { encoding: 'UTF-16BE', hasBom: true };
    case 'ansi': return { encoding: ansi?.id ?? 'ansi', hasBom: false };
    default: return { encoding: 'UTF-8', hasBom: false };
  }
}

export function defaultEol(): Eol {
  const v = getSetting('files.defaultEol');
  return v === 'LF' || v === 'CR' ? v : 'CRLF';
}
