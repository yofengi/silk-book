// 扩展名 → 语言包 懒加载映射。每个 import() 被 Vite 拆成独立 chunk。
import type { CompletionSource } from '@codemirror/autocomplete';
import { LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { t } from '../i18n';

export interface LanguageDef {
  id: string;
  name: string;
  extensions: string[];
  load(): Promise<Extension>;
  /** 可选：该语言的补全源（关键字 / 标准库 / 片段），独立懒加载 chunk；与单词补全合并 */
  completions?: () => Promise<CompletionSource>;
}

/** 旧式 StreamParser 语言（@codemirror/legacy-modes）包装为 LanguageSupport，供编辑器与 Markdown 预览 highlightCode 共用 */
async function streamLanguage(parser: Promise<StreamParser<unknown>>): Promise<Extension> {
  return new LanguageSupport(StreamLanguage.define(await parser));
}

export const languages: LanguageDef[] = [
  { id: 'javascript', name: 'JavaScript', extensions: ['js', 'mjs', 'cjs', 'jsx'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })) },
  { id: 'typescript', name: 'TypeScript', extensions: ['ts', 'mts', 'cts', 'tsx'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })) },
  { id: 'python', name: 'Python', extensions: ['py', 'pyw', 'pyi'], load: () => import('@codemirror/lang-python').then((m) => m.python()) },
  { id: 'rust', name: 'Rust', extensions: ['rs'], load: () => import('@codemirror/lang-rust').then((m) => m.rust()) },
  { id: 'cpp', name: 'C/C++', extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'], load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()) },
  { id: 'java', name: 'Java', extensions: ['java'], load: () => import('@codemirror/lang-java').then((m) => m.java()) },
  { id: 'go', name: 'Go', extensions: ['go'], load: () => import('@codemirror/lang-go').then((m) => m.go()) },
  { id: 'html', name: 'HTML', extensions: ['html', 'htm', 'xhtml', 'vue'], load: () => import('@codemirror/lang-html').then((m) => m.html()) },
  { id: 'css', name: 'CSS', extensions: ['css', 'scss', 'less'], load: () => import('@codemirror/lang-css').then((m) => m.css()) },
  { id: 'json', name: 'JSON', extensions: ['json', 'jsonc', 'json5'], load: () => import('@codemirror/lang-json').then((m) => m.json()) },
  { id: 'yaml', name: 'YAML', extensions: ['yaml', 'yml'], load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()) },
  { id: 'markdown', name: 'Markdown', extensions: ['md', 'markdown', 'mdx'], load: () => import('@codemirror/lang-markdown').then((m) => m.markdown()) },
  { id: 'sql', name: 'SQL', extensions: ['sql'], load: () => import('@codemirror/lang-sql').then((m) => m.sql()) },
  { id: 'xml', name: 'XML', extensions: ['xml', 'svg', 'xsd', 'xsl', 'plist'], load: () => import('@codemirror/lang-xml').then((m) => m.xml()) },
  {
    id: 'lua', name: 'Lua', extensions: ['lua'],
    load: () => streamLanguage(import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
    completions: () => import('./completions/lua').then((m) => m.luaCompletion),
  },
];

export const PLAIN_TEXT = { id: 'plaintext' };

/** 语言模式显示名：内置语言用专有名（不翻译），纯文本按界面语言解析 */
export function languageName(id: string): string {
  return languageById(id)?.name ?? t('lang.plaintext');
}

export function languageForPath(path: string | null): LanguageDef | undefined {
  if (!path) return undefined;
  const m = /\.([^.\\/]+)$/.exec(path);
  const ext = m?.[1]?.toLowerCase();
  return ext ? languages.find((l) => l.extensions.includes(ext)) : undefined;
}

export function languageById(id: string): LanguageDef | undefined {
  return languages.find((l) => l.id === id);
}

const cache = new Map<string, Promise<Extension>>();
export function loadLanguage(def: LanguageDef): Promise<Extension> {
  let p = cache.get(def.id);
  if (!p) {
    p = def.load();
    p.catch(() => cache.delete(def.id));
    cache.set(def.id, p);
  }
  return p;
}

const completionCache = new Map<string, Promise<CompletionSource | null>>();
/** 加载语言补全源；无补全或加载失败返回 null（失败不缓存，下次重试） */
export function loadCompletions(def: LanguageDef): Promise<CompletionSource | null> {
  if (!def.completions) return Promise.resolve(null);
  let p = completionCache.get(def.id);
  if (!p) {
    p = def.completions().catch((e: unknown) => {
      console.error(`completion source for ${def.id} failed to load`, e);
      completionCache.delete(def.id);
      return null;
    });
    completionCache.set(def.id, p);
  }
  return p;
}
