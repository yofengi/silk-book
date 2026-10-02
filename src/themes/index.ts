// 主题：CSS 变量（light.css / dark.css）是唯一来源；CodeMirror 主题与 HighlightStyle 只引用 var(--*)，
// 因此切换主题只需改 <html data-theme>，编辑器通过 theme Compartment 更新 dark 标志，不重建 EditorView。
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { events } from '../core/events';
import { getSetting } from '../core/settings';
import { ipc, type WindowMaterial } from '../ipc';
import { parseUserTheme, USER_THEME_PREFIX, type UserTheme } from './user';

export type ThemeSetting = 'glass-system' | 'glass-dark' | 'glass-light' | 'light' | 'dark' | 'system';
export type ThemeKind = 'light' | 'dark';
export interface Theme { id: string; kind: ThemeKind; glass: boolean; user?: UserTheme }
export const THEME_SETTINGS: readonly ThemeSetting[] = ['glass-system', 'glass-dark', 'glass-light', 'light', 'dark', 'system'];
export const DEFAULT_THEME: ThemeSetting = 'glass-system';
/** index.html 内联脚本读取同一个 key，用于首帧前应用主题 */
export const THEME_CACHE_KEY = 'boshu.theme';

const mql = window.matchMedia('(prefers-color-scheme: dark)');
let current: ThemeKind = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

// ---- 用户主题：%APPDATA%\Boshu\themes\*.json，经 ipc.themesList() 读取；workbench.theme = `user:<id>`
const userThemes = new Map<string, UserTheme>();
let userThemesLoaded = false;

export function listUserThemes(): UserTheme[] {
  return [...userThemes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 重新读取用户主题目录（导入/删除后由设置页调用）；无效文件跳过并记录 */
export async function reloadUserThemes(): Promise<void> {
  try {
    const entries = await ipc.themesList();
    userThemes.clear();
    for (const e of entries) {
      const r = parseUserTheme(e.id, e.json);
      if (r.theme) userThemes.set(e.id, r.theme);
      else console.warn(`user theme ${e.fileName} ignored: ${r.error ?? ''}`);
    }
  } catch (e) {
    console.error('themes list failed', e);
  }
  userThemesLoaded = true;
  applyTheme();
}

/** 原始设置值：内置主题 id 或 `user:<id>`；无法识别时回退默认 */
export function themeSettingRaw(): string {
  const v = getSetting('workbench.theme');
  if (v.startsWith(USER_THEME_PREFIX)) {
    // 主题目录尚未读完时保留设置（避免闪回默认）；读完后仍不存在则回退默认
    return !userThemesLoaded || userThemes.has(v.slice(USER_THEME_PREFIX.length)) ? v : DEFAULT_THEME;
  }
  return (THEME_SETTINGS as readonly string[]).includes(v) ? v : DEFAULT_THEME;
}

/** 内置主题设置（用户主题映射到其基底：glass-<kind> 或 <kind>） */
export function themeSetting(): ThemeSetting {
  const raw = themeSettingRaw();
  if (!raw.startsWith(USER_THEME_PREFIX)) return raw as ThemeSetting;
  const u = userThemes.get(raw.slice(USER_THEME_PREFIX.length));
  if (!u) return (localCachedBase() ?? DEFAULT_THEME);
  return (u.glass ? `glass-${u.kind}` : u.kind) as ThemeSetting;
}

function localCachedBase(): ThemeSetting | null {
  try {
    const v = localStorage.getItem(THEME_CACHE_KEY);
    return v && (THEME_SETTINGS as readonly string[]).includes(v) ? (v as ThemeSetting) : null;
  } catch { return null; }
}

export function resolveTheme(s: ThemeSetting = themeSetting()): Theme {
  const raw = themeSettingRaw();
  const user = raw.startsWith(USER_THEME_PREFIX) ? userThemes.get(raw.slice(USER_THEME_PREFIX.length)) : undefined;
  if (user) return { id: raw, kind: user.kind, glass: user.glass, user };
  const glass = s.startsWith('glass-');
  const base = glass ? s.slice(6) : s;
  const kind: ThemeKind = base === 'system' ? (mql.matches ? 'dark' : 'light') : (base as ThemeKind);
  return { id: s, kind, glass };
}

export function currentTheme(): ThemeKind {
  return current;
}

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--tok-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--tok-string)' },
  { tag: [t.number, t.bool, t.atom, t.null], color: 'var(--tok-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--tok-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--tok-function)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--tok-definition)' },
  { tag: t.propertyName, color: 'var(--tok-property)' },
  { tag: t.variableName, color: 'var(--tok-variable)' },
  { tag: [t.operator, t.punctuation], color: 'var(--tok-operator)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--tok-meta)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--tok-tag)' },
  { tag: t.attributeName, color: 'var(--tok-attribute)' },
  { tag: t.heading, color: 'var(--tok-heading)', fontWeight: 'bold' },
  { tag: [t.link, t.url], color: 'var(--tok-link)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: 'var(--tok-invalid)' },
]);

const baseSpec = {
  '&': { height: '100%', backgroundColor: 'var(--editor-bg)', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--mono-font)', fontSize: 'var(--editor-font-size)', lineHeight: 'var(--editor-line-height)' },
  '.cm-content': { caretColor: 'var(--cursor)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cursor)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--selection)' },
  '.cm-selectionMatch, .cm-searchMatch': { backgroundColor: 'var(--match)' },
  '.cm-gutters': { backgroundColor: 'var(--gutter-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--fg)' },
  '.cm-searchMatch-selected': { outline: '1px solid var(--accent)' },
  '.cm-panels': { backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--ui-font)', fontSize: 'var(--ui-font-size)' },
  '.cm-panel.cm-search label': { fontSize: 'inherit', marginRight: '8px' },
  '.cm-textfield': { backgroundColor: 'var(--editor-bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '4px', padding: '3px 6px', fontSize: 'inherit' },
  '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--hover)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '4px', padding: '3px 10px', fontSize: 'inherit' },
  '.cm-button:hover': { backgroundColor: 'var(--pressed)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)', fontSize: '16px', cursor: 'pointer' },
  '.cm-tooltip': { backgroundColor: 'var(--editor-bg)', color: 'var(--fg)', border: 'none', borderRadius: '6px', boxShadow: 'var(--shadow)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono-font)', padding: '4px' },
  '.cm-tooltip-autocomplete ul li': { borderRadius: '4px', padding: '2px 8px' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)', fontWeight: '600' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--pressed)', color: 'var(--fg)' },
};
// 两份规格相同，仅 dark 标志不同（影响 CodeMirror 内置样式的明暗基调）
const editorThemes: Record<ThemeKind, Extension> = {
  light: [EditorView.theme(baseSpec, { dark: false }), syntaxHighlighting(highlightStyle)],
  dark: [EditorView.theme(baseSpec, { dark: true }), syntaxHighlighting(highlightStyle)],
};

// 字体变更只改 CSS 变量，CodeMirror 感知不到；每次字体变更生成一个新的（空规则）主题扩展，
// 使 theme facet 变化 → CodeMirror 重新测量行高/字宽（公开 API，不重建 EditorView）。
let fontGen = 0;
let fontTheme: Extension = EditorView.theme({ '&': { '--boshu-font-gen': '0' } });
export function bumpFontGeneration(): void {
  fontGen++;
  fontTheme = EditorView.theme({ '&': { '--boshu-font-gen': String(fontGen) } });
}

/** 放进 compartments.theme 的扩展 */
export function editorThemeExt(kind: ThemeKind = current): Extension {
  return [editorThemes[kind], fontTheme];
}

/** 应用主题到 DOM；变化时发 theme.changed，由编辑器/预览各自响应 */
export function applyTheme(): void {
  const { kind, glass, user } = resolveTheme();
  const root = document.documentElement;
  // 缓存写基底主题（用户主题写其 glass-<kind>/<kind>），index.html 内联脚本无需理解 user:
  try { localStorage.setItem(THEME_CACHE_KEY, themeSetting()); } catch { /* 忽略 */ }
  root.dataset.theme = kind;
  root.toggleAttribute('data-glass', glass);
  applyUserLayer(user);
  materialReady = syncMaterial(glass, kind).catch((error: unknown) => console.warn('theme material failed', error));
  if (kind === current) return;
  current = kind;
  events.emit('theme.changed', { kind });
}

// 用户主题层：以 inline style 写在 <html> 上，优先级高于 themes/*.css 的基底变量；值已在 user.ts 校验
let layerKeys: string[] = [];
function applyUserLayer(user: UserTheme | undefined): void {
  const s = document.documentElement.style;
  for (const k of layerKeys) s.removeProperty(k);
  layerKeys = [];
  if (!user) return;
  for (const [k, v] of Object.entries(user.colors)) {
    s.setProperty(k, v);
    layerKeys.push(k);
  }
}

export function installThemeWatcher(): Promise<void> {
  applyTheme();
  const loaded = reloadUserThemes();
  // 'system' 与 'glass-system' 都跟随系统明暗
  mql.addEventListener('change', () => { if (themeSetting().endsWith('system')) applyTheme(); });
  reducedTransparency.addEventListener('change', () => applyTheme());
  events.on('settings.changed', ({ key }) => { if (key === 'workbench.theme' || key === 'workbench.glassMaterial') applyTheme(); });
  return loaded.then(() => materialReady);
}

// ---- 窗口材质：仅 Win11（build >= 22000）。失败或 Win10 时不加 .glass-material，
// CSS 保持不透明的渐变底色，透明窗口不会出现“空洞”。
// build 号由 Rust 读注册表：WebView2 的 userAgentData 高熵值不可靠，曾导致误判为非 Win11。
const WIN11_BUILD = 22000;
const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
let win11: Promise<boolean> | undefined;
function isWin11(): Promise<boolean> {
  win11 ??= ipc.osBuild().then((b) => b >= WIN11_BUILD).catch(() => false);
  return win11;
}
let applied = '';
let seq = 0;
let materialReady: Promise<void> = Promise.resolve();
async function syncMaterial(glass: boolean, kind: ThemeKind): Promise<void> {
  const my = ++seq;
  const pref = getSetting('workbench.glassMaterial');
  const want: WindowMaterial = glass && !reducedTransparency.matches && (await isWin11())
    ? (pref === 'mica' ? 'mica' : 'acrylic') : 'none';
  // 窗口主题决定材质明暗：显式主题强制对应明暗，跟随系统的主题交还系统（null），
  // 否则 prefers-color-scheme 会被锁定在上一次设置的值上
  const winTheme = themeSetting().endsWith('system') ? null : kind;
  const key = `${want}:${winTheme ?? 'system'}:${kind}`;
  if (my !== seq || key === applied) return;
  const ok = await ipc.window.setMaterial(want, winTheme);
  if (my !== seq) return;
  applied = ok ? key : '';
  document.documentElement.classList.toggle('glass-material', ok && want !== 'none');
}
