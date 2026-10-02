// 字体：通过 CSS 变量 --ui-font / --mono-font / --editor-font-size / --editor-line-height / --ui-font-size 应用。
// 随包字体（bundled_fonts 返回的任意族，目前为 Maple Mono NF CN WOFF2）只在被选中的族才注册 @font-face，未选用的不下载。
import { events } from '../core/events';
import { getSetting } from '../core/settings';
import { ipc, type BundledFont } from '../ipc';

export const BUNDLED_MONO = 'Maple Mono NF CN';
export const MONO_FALLBACK = '"Cascadia Code", Consolas, "Microsoft YaHei UI", monospace';
export const UI_DEFAULT = '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif';

const FONT_KEYS = new Set(['editor.fontFamily', 'editor.fontSize', 'editor.lineHeight', 'workbench.fontFamily', 'workbench.fontSize']);

/** 把用户输入（单个族名或逗号分隔列表）转为安全的 font-family 值；非法字符整体丢弃 */
export function cssFamilyList(input: string): string {
  const out: string[] = [];
  for (const part of input.split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '').trim();
    if (!name || !/^[\p{L}\p{N} _.-]{1,64}$/u.test(name)) continue;
    out.push(/^(serif|sans-serif|monospace|system-ui|cursive|fantasy)$/.test(name) ? name : `"${name}"`);
  }
  return out.join(', ');
}

function familyNames(input: string): string[] {
  return input.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '').trim().toLowerCase());
}

/** 已知的界面字体族（小写）。后端若返回其一且未给 role，则作为界面字体置顶；Maple Hand 待许可证确认，目前后端不返回 */
const KNOWN_UI_FAMILIES = new Set(['maple hand']);

export type BundledRole = 'mono' | 'ui';

function roleOf(f: BundledFont): BundledRole {
  return f.role ?? (KNOWN_UI_FAMILIES.has(f.family.toLowerCase()) ? 'ui' : 'mono');
}

let bundledList: Promise<BundledFont[]> | null = null;
/** bundled_fonts 结果（只含路径，不下载字体文件）；失败返回 [] 且下次重试 */
function listBundled(): Promise<BundledFont[]> {
  bundledList ??= ipc.bundledFonts().catch((e: unknown) => {
    console.error('bundled_fonts failed', e);
    bundledList = null;
    return [];
  });
  return bundledList;
}

/** 随包字体族名（去重，保持后端顺序），用于字体下拉置顶 */
export async function bundledFamilies(role: BundledRole): Promise<string[]> {
  const out: string[] = [];
  for (const f of await listBundled()) if (roleOf(f) === role && !out.includes(f.family)) out.push(f.family);
  return out;
}

const registered = new Map<string, Promise<boolean>>();
/**
 * 为某个随包字体族注册 @font-face（幂等，按族懒注册）。URL 按 IPC.md：url(convertFileSrc(path)) format('woff2')。
 * 返回该族是否为随包字体。
 */
function ensureBundledFamily(familyLower: string): Promise<boolean> {
  let p = registered.get(familyLower);
  if (!p) {
    p = listBundled().then((fonts) => {
      const faces = fonts.filter((f) => f.family.toLowerCase() === familyLower);
      for (const f of faces) {
        const url = ipc.assetUrl(f.path);
        if (!url) continue;
        const fmt = /^[a-z0-9-]+$/.test(f.format ?? '') ? ` format("${f.format}")` : '';
        document.fonts.add(new FontFace(f.family, `url("${url}")${fmt}`, { weight: String(f.weight), style: f.style, display: 'swap' }));
      }
      // bundled_fonts 失败时（listBundled 已重置）不缓存结果，下次 applyFonts 重试
      if (!faces.length && bundledList === null) registered.delete(familyLower);
      return faces.length > 0;
    });
    registered.set(familyLower, p);
  }
  return p;
}

/** 对设置值中出现的随包字体族注册 @font-face；有注册时等字形加载后再发一次 fonts.changed 以便编辑器重新测量 */
function ensureSelectedBundled(families: string[], size: number): void {
  for (const name of families) {
    if (!name) continue;
    void ensureBundledFamily(name)
      .then((isBundled) => {
        if (!isBundled) return;
        return document.fonts.load(`${size}px "${name.replace(/["\\]/g, '')}"`).then(() => events.emit('fonts.changed', undefined));
      })
      .catch((e: unknown) => console.error('bundled font registration failed', e));
  }
}

function clampNum(v: number, lo: number, hi: number, def: number): number {
  return Number.isFinite(v) && v >= lo && v <= hi ? v : def;
}

export function applyFonts(): void {
  const s = document.documentElement.style;
  const mono = getSetting('editor.fontFamily').trim() || BUNDLED_MONO;
  const uiRaw = getSetting('workbench.fontFamily');
  ensureSelectedBundled(familyNames(mono), getSetting('editor.fontSize'));
  ensureSelectedBundled(familyNames(uiRaw), getSetting('workbench.fontSize'));
  const monoList = cssFamilyList(mono);
  s.setProperty('--mono-font', monoList ? `${monoList}, ${MONO_FALLBACK}` : MONO_FALLBACK);
  const ui = cssFamilyList(uiRaw);
  if (ui) s.setProperty('--ui-font', `${ui}, ${UI_DEFAULT}`);
  else s.removeProperty('--ui-font');
  s.setProperty('--editor-font-size', `${clampNum(getSetting('editor.fontSize'), 8, 40, 14)}px`);
  s.setProperty('--editor-line-height', String(clampNum(getSetting('editor.lineHeight'), 1, 3, 1.5)));
  s.setProperty('--ui-font-size', `${clampNum(getSetting('workbench.fontSize'), 10, 20, 13)}px`);
  events.emit('fonts.changed', undefined);
}

export function installFontWatcher(): void {
  applyFonts();
  events.on('settings.changed', ({ key }) => { if (FONT_KEYS.has(key)) applyFonts(); });
}
