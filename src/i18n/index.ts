// 轻量 i18n（无第三方库）：t(key, params) + {name} 插值 + ICU 复数子集。
// zh-CN 静态打包进主 chunk（唯一来源 + 回退）；其他语言首次使用时 import() 懒加载。
// 本模块只依赖 core/events，可被 ipc / core / ui 任意层引用而不产生循环依赖。
import { events } from '../core/events';
import { zhCN } from './locales/zh-CN';
import type { Key, Locale, LocaleMessages, Params } from './types';

export type { Key, LanguageSetting, Locale, LocaleMessages, Params } from './types';

export const LOCALES: readonly Locale[] = ['zh-CN', 'en', 'zh-TW', 'ja'];

/** 各语言的自称：语言选择器里始终用该语言本身书写，不随界面语言翻译 */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  'zh-CN': '简体中文', en: 'English', 'zh-TW': '繁體中文', ja: '日本語',
};

/** 产品名（品牌名随语言变化，不属于可翻译文案） */
const PRODUCT_NAMES: Readonly<Record<Locale, string>> = {
  'zh-CN': '帛书', en: 'silk book', 'zh-TW': '帛書', ja: '帛書',
};

type Flat = Map<string, string>;

function flatten(obj: object, prefix = '', out: Flat = new Map()): Flat {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out.set(prefix + k, v);
    else if (v && typeof v === 'object') flatten(v as object, `${prefix}${k}.`, out);
  }
  return out;
}

const base = flatten(zhCN);
const cache = new Map<Locale, Flat>();
const loaders: Record<Exclude<Locale, 'zh-CN'>, () => Promise<{ default: LocaleMessages }>> = {
  en: () => import('./locales/en'),
  'zh-TW': () => import('./locales/zh-TW'),
  ja: () => import('./locales/ja'),
};

let locale: Locale = 'zh-CN';
let current: Flat | null = null; // null = 直接使用 zh-CN
let plurals: Intl.PluralRules | null = null;
let loadSeq = 0;

export function getLocale(): Locale {
  return locale;
}

/** 当前语言下的产品名：帛书 / silk book / 帛書 */
export function productName(): string {
  return PRODUCT_NAMES[locale];
}

/**
 * BCP-47 标签 → 支持的语言：zh-TW / zh-HK / zh-MO / zh-Hant* → zh-TW，其余 zh* → zh-CN，ja* → ja，否则 en。
 */
export function resolveLocale(tag: string | null | undefined): Locale {
  const s = (tag ?? '').trim().replace(/_/g, '-').toLowerCase();
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(s)) return 'zh-TW';
  if (/^zh(-|$)/.test(s)) return 'zh-CN';
  if (/^ja(-|$)/.test(s)) return 'ja';
  return 'en';
}

/** 切换界面语言：按需加载语言包，设置 <html lang> 与窗口标题，广播 locale.changed */
export async function setLocale(next: Locale): Promise<void> {
  const seq = ++loadSeq;
  let dict: Flat | null = null;
  if (next !== 'zh-CN') {
    dict = cache.get(next) ?? null;
    if (!dict) {
      try {
        dict = flatten((await loaders[next]()).default);
      } catch (e) {
        console.error(`[i18n] failed to load locale ${next}`, e);
        dict = new Map(); // 全部回退 zh-CN，但保持所选语言（产品名、lang 属性）
      }
      cache.set(next, dict);
    }
  }
  if (seq !== loadSeq) return; // 更新的切换请求已发出
  const changed = next !== locale;
  locale = next;
  current = dict;
  plurals = null;
  document.documentElement.lang = next;
  document.title = productName();
  if (changed) events.emit('locale.changed', { locale: next });
}

// {count, plural, =0 {…} one {# item} other {# items}}；分支内可含 {name} 占位符，不支持更深嵌套
const BRANCH = String.raw`(?:[^{}]|\{\w+\})*`;
const PLURAL_RE = new RegExp(String.raw`\{(\w+),\s*plural,((?:\s*=?\w+\s*\{${BRANCH}\})+)\s*\}`, 'g');
const OPTION_RE = new RegExp(String.raw`(=?\w+)\s*\{(${BRANCH})\}`, 'g');
const PARAM_RE = /\{(\w+)\}/g;

function pluralBranch(body: string, n: number): string {
  const options = new Map<string, string>();
  for (const m of body.matchAll(OPTION_RE)) options.set(m[1], m[2]);
  plurals ??= new Intl.PluralRules(locale);
  const text = options.get(`=${n}`) ?? options.get(plurals.select(n)) ?? options.get('other') ?? '';
  return text.replace(/#/g, String(n));
}

function format(s: string, params?: Params): string {
  if (!s.includes('{')) return s;
  return s
    .replace(PLURAL_RE, (m, name: string, body: string) => {
      const n = Number(params?.[name]);
      return Number.isFinite(n) ? pluralBranch(body, n) : m;
    })
    .replace(PARAM_RE, (m, name: string) => {
      const v = params?.[name];
      if (v !== undefined) return String(v);
      return name === 'app' ? productName() : m;
    });
}

/** 取当前语言文案；缺失时回退 zh-CN，再缺失返回键名本身。{app} 未显式传入时替换为产品名 */
export function t(key: Key, params?: Params): string {
  return format(current?.get(key) ?? base.get(key) ?? key, params);
}

/** CodeMirror 内置界面的短语；由编辑器通过 EditorState.phrases.of() 安装。 */
export function editorPhrases(): Record<string, string> {
  const keys = {
    Find: 'find', Replace: 'replace', next: 'next', previous: 'previous', all: 'all',
    'match case': 'matchCase', regexp: 'regexp', 'by word': 'byWord',
    replace: 'replace', 'replace all': 'replaceAll', close: 'close',
    'Go to line': 'goToLine', go: 'go',
    'replaced match on line $': 'replacedMatch', 'replaced $ matches': 'replacedMatches',
    'current match': 'currentMatch', 'on line': 'onLine', Completions: 'completions',
    'Selection deleted': 'selectionDeleted', 'Folded lines': 'foldedLines',
    'Unfolded lines': 'unfoldedLines', to: 'to', 'folded code': 'foldedCode',
    unfold: 'unfold', 'Fold line': 'foldLine', 'Unfold line': 'unfoldLine',
    'Control character': 'controlCharacter',
  } as const;
  return Object.fromEntries(Object.entries(keys).map(([phrase, key]) => [phrase, t(`editor.phrases.${key}`)]));
}
