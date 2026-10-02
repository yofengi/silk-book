// 用户主题：JSON 格式见 docs/ARCHITECTURE.md 4.6。只应用白名单内的 CSS 变量，值必须是安全的颜色/渐变/阴影 token。
// 纯函数，便于单独测试；应用逻辑在 themes/index.ts。
import { t } from '../i18n';

export type UserThemeKind = 'light' | 'dark';

export interface UserTheme {
  /** 文件 id（由后端生成，workbench.theme 存为 `user:<id>`） */
  id: string;
  name: string;
  kind: UserThemeKind;
  glass: boolean;
  /** 已校验的变量 → 值 */
  colors: Record<string, string>;
}

export interface ParseResult {
  theme: UserTheme | null;
  /** 被忽略的键或值，用于在设置页提示 */
  warnings: string[];
  error?: string;
}

export const USER_THEME_PREFIX = 'user:';

/** 可由用户主题覆盖的变量：themes/*.css 中定义的颜色类变量（字体/字号变量不在此列，走字体设置） */
export const THEME_VARS: readonly string[] = [
  '--bg', '--fg', '--muted', '--border', '--accent', '--accent-fg', '--focus', '--dirty',
  '--titlebar-bg', '--titlebar-fg', '--titlebar-inactive-bg', '--tab-bg', '--tab-hover', '--statusbar-bg',
  '--editor-bg', '--gutter-bg', '--active-line', '--selection', '--match', '--cursor',
  '--hover', '--pressed', '--overlay', '--shadow', '--scrollbar', '--scrollbar-hover',
  '--float-bg', '--float-border', '--float-shadow', '--float-sheen', '--glass-fallback', '--inactive-surface',
  '--preview-bg', '--code-bg', '--win-hover', '--win-active',
  '--tok-keyword', '--tok-string', '--tok-number', '--tok-comment', '--tok-operator', '--tok-variable',
  '--tok-definition', '--tok-function', '--tok-type', '--tok-property', '--tok-meta', '--tok-tag',
  '--tok-attribute', '--tok-heading', '--tok-link', '--tok-invalid',
];
const VAR_SET = new Set(THEME_VARS);

/** 允许出现在值中的 CSS 函数（颜色、渐变、数学）；其他函数（url/image/element/expression/attr…）一律拒绝 */
const FUNCS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient', 'calc',
]);
/** 字符集：不含 ; { } < > " ' \ @ ! : 等可逃逸声明的字符 */
const SAFE_CHARS = /^[#a-zA-Z0-9\s.,%()+\-/*]*$/;
const MAX_VALUE = 240;
const MAX_NAME = 60;

/** 校验单个值；合法返回规范化值，否则 null */
export function safeCssValue(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s || s.length > MAX_VALUE || !SAFE_CHARS.test(s)) return null;
  // 括号必须配对且不为负
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return null;
  }
  if (depth !== 0) return null;
  // 每个 "ident(" 都必须是白名单函数；"(" 前没有 ident（裸括号）也拒绝
  const re = /([a-zA-Z-]*)\(/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!FUNCS.has(m[1].toLowerCase())) return null;
  }
  return s;
}

/** 解析并校验用户主题 JSON（后端已确保是 JSON 对象） */
export function parseUserTheme(id: string, json: unknown): ParseResult {
  const warnings: string[] = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { theme: null, warnings, error: t('theme.error.notObject') };
  const o = json as Record<string, unknown>;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, MAX_NAME) : id;
  if (o.kind !== 'light' && o.kind !== 'dark') return { theme: null, warnings, error: t('theme.error.badKind') };
  if (o.glass !== undefined && typeof o.glass !== 'boolean') warnings.push('glass');
  const c = o.colors;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { theme: null, warnings, error: t('theme.error.noColors') };
  const colors: Record<string, string> = {};
  for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
    if (!VAR_SET.has(k)) { warnings.push(k); continue; }
    const safe = safeCssValue(v);
    if (safe === null) { warnings.push(k); continue; }
    colors[k] = safe;
  }
  return { theme: { id, name, kind: o.kind, glass: o.glass === true, colors }, warnings };
}
