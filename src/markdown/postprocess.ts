// 把 markdown-it 输出变成安全 DOM：DOMPurify 清洗、链接/图片拦截、Lezer 代码高亮、懒加载 KaTeX / Mermaid。
import { LanguageSupport } from '@codemirror/language';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import DOMPurify from 'dompurify';
import { executeCommand } from '../core/commands';
import { t } from '../i18n';
import { ipc } from '../ipc';
import { languageById, languages, loadLanguage } from '../editor/languages';

// 清洗：禁止表单/样式/脚本类标签，只保留任务列表用的禁用复选框
const PURIFY_CFG = {
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'base', 'meta', 'link'],
  FORBID_ATTR: ['style', 'target', 'formaction'],
  ALLOW_DATA_ATTR: true,
};

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, PURIFY_CFG);
}

const SAFE_IMG = /^(https?:|data:image\/(png|jpe?g|gif|webp|bmp);)/i;

/** 同步处理：链接、图片、复选框。异步增强（高亮/公式/图表）在后面 fire-and-forget */
export function enhance(root: HTMLElement, flags: { hasMath: boolean; hasMermaid: boolean }, docPath?: string | null): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    a.title = EXTERNAL.test(href) ? t('preview.externalLink', { href }) : t('preview.unsupportedLink', { href });
    a.rel = 'noopener noreferrer';
  }
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    const src = img.getAttribute('src') ?? '';
    if (SAFE_IMG.test(src)) {
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      continue;
    }
    const local = docPath ? localImageUrl(src, docPath) : null;
    if (local) {
      img.src = local;
      img.loading = 'lazy';
      continue;
    }
    const ph = document.createElement('span');
    ph.className = 'md-img-blocked';
    ph.textContent = t('preview.image', { alt: img.alt || src });
    ph.title = src;
    img.replaceWith(ph);
  }
  for (const input of root.querySelectorAll<HTMLInputElement>('input')) {
    if (input.type !== 'checkbox' || !input.classList.contains('task-list-item-checkbox')) input.remove();
    else input.disabled = true;
  }
  for (const code of root.querySelectorAll<HTMLElement>('pre.md-code > code[data-lang]')) void highlightBlock(code);
  if (flags.hasMath) void renderMath(root);
  if (flags.hasMermaid) void renderMermaid(root);
}

const EXTERNAL = /^(https?:\/\/|mailto:)/i;

/** Windows 路径：把相对/绝对图片地址解析到文档目录下；越出文档目录或非本地协议返回 null */
function localImageUrl(src: string, docPath: string): string | null {
  // 允许 Windows 盘符（C:\ / C:/），拒绝其他协议与 UNC / 协议相对路径
  if (!src || src.startsWith('//') || src.startsWith('\\\\')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return null;
  let rel: string;
  try { rel = decodeURIComponent(src.split(/[?#]/)[0]); } catch { return null; }
  const SEP = '\\';
  const norm = (p: string) => p.replace(/\//g, SEP);
  const dir = norm(docPath).replace(/\\[^\\]*$/, '');
  const abs = /^[a-z]:[\\/]/i.test(rel) ? norm(rel) : dir + SEP + norm(rel);
  const out: string[] = [];
  for (const part of abs.split(SEP)) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length > 1) out.pop(); else return null; } else out.push(part);
  }
  const full = out.join(SEP);
  // 仅允许文档目录内（与 allow_asset_dir 授权范围一致）
  if (!full.toLowerCase().startsWith(dir.toLowerCase() + SEP)) return null;
  return ipc.assetUrl(full);
}

/** 预览容器上的统一事件拦截：链接从不导航 webview；http/https/mailto 经注册命令用系统打开 */
export function blockNavigation(root: HTMLElement): void {
  const stop = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (e.type === 'click' && e.button === 0 && EXTERNAL.test(href)) void executeCommand('markdown.openLink', href);
  };
  root.addEventListener('click', stop);
  root.addEventListener('auxclick', stop);
  root.addEventListener('dragstart', (e) => { if ((e.target as Element | null)?.closest?.('a,img')) e.preventDefault(); });
}

// ---- Lezer 高亮 ----
const ALIASES: Record<string, string> = { 'c++': 'cpp', shell: 'plaintext', golang: 'go', py: 'python', js: 'javascript', ts: 'typescript' };
const MAX_HIGHLIGHT = 200_000;

async function highlightBlock(code: HTMLElement): Promise<void> {
  const raw = code.dataset.lang ?? '';
  const name = ALIASES[raw] ?? raw;
  const def = languageById(name) ?? languages.find((l) => l.extensions.includes(name));
  const text = code.textContent ?? '';
  if (!def || text.length > MAX_HIGHLIGHT) return;
  let ext;
  try { ext = await loadLanguage(def); } catch { return; }
  if (!(ext instanceof LanguageSupport) || !code.isConnected) return;
  const tree = ext.language.parser.parse(text);
  const frag = document.createDocumentFragment();
  highlightCode(
    text, tree, classHighlighter,
    (t, cls) => {
      if (!cls) { frag.append(t); return; }
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = t;
      frag.append(s);
    },
    () => frag.append('\n'),
  );
  code.replaceChildren(frag);
}

// ---- KaTeX（懒加载） ----
let katexP: Promise<typeof import('katex').default> | null = null;
function loadKatex() {
  katexP ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default);
  return katexP;
}

async function renderMath(root: HTMLElement): Promise<void> {
  const katex = await loadKatex();
  for (const el of root.querySelectorAll<HTMLElement>('.md-math:not([data-done])')) {
    const src = el.textContent ?? '';
    el.dataset.done = '1';
    try {
      // trust:false 禁止 \href/\url 等；输出由 KaTeX 生成，不含脚本
      katex.render(src, el, { displayMode: el.classList.contains('md-math-display'), throwOnError: false, trust: false, strict: 'ignore', maxExpand: 1000 });
    } catch {
      el.textContent = src;
    }
  }
}

// ---- Mermaid（懒加载，securityLevel: strict；主题跟随 data-theme，切换时重渲染） ----
let mermaidP: Promise<typeof import('mermaid').default> | null = null;
let mermaidSeq = 0;
let mermaidTheme = '';
async function loadMermaid() {
  mermaidP ??= import('mermaid').then((m) => m.default);
  const mermaid = await mermaidP;
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
  if (theme !== mermaidTheme) {
    mermaidTheme = theme;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, htmlLabels: false, flowchart: { htmlLabels: false } });
  }
  return mermaid;
}

async function renderMermaid(root: HTMLElement): Promise<void> {
  const mermaid = await loadMermaid();
  for (const pre of root.querySelectorAll<HTMLElement>('pre.md-mermaid:not([data-done])')) {
    pre.dataset.done = '1';
    const src = pre.dataset.src ?? pre.textContent ?? '';
    pre.dataset.src = src;
    try {
      const { svg } = await mermaid.render(`boshu-mermaid-${++mermaidSeq}`, src);
      if (!pre.isConnected) continue;
      const box = document.createElement('div');
      box.className = 'md-mermaid-svg';
      box.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      pre.classList.remove('md-mermaid-error');
      pre.replaceChildren(box);
    } catch (e) {
      pre.classList.add('md-mermaid-error');
      pre.title = String(e);
    }
  }
}

/** 主题切换后重渲染已渲染的 Mermaid 图（源码保存在 data-src） */
export function rerenderMermaid(root: HTMLElement): void {
  const done = root.querySelectorAll<HTMLElement>('pre.md-mermaid[data-done]');
  if (!done.length) return;
  for (const pre of done) delete pre.dataset.done;
  void renderMermaid(root);
}
