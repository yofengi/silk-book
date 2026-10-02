// markdown-it 渲染核心（纯函数，不依赖 DOM）：GFM 表格/删除线/任务列表/linkify、数学公式标记、data-line 行号映射。
// 输出仍需经过 DOMPurify 清洗（见 preview.ts）。
import MarkdownIt, { type StateBlock, type StateCore, type StateInline } from 'markdown-it';

export type RenderEnv = {
  /** 本段在整篇文档中的起始行（0 基） */
  lineOffset?: number;
  hasMath?: boolean;
  hasMermaid?: boolean;
};

export interface RenderResult {
  html: string;
  hasMath: boolean;
  hasMermaid: boolean;
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
md.linkify.set({ fuzzyLink: true });
// markdown-it 默认已启用 GFM 表格与删除线；html:false 使源码中的 HTML 被转义

// ---- data-line：把 token.map 映射成源行号（1 基，对应 CodeMirror 行号） ----
const LINE_TYPES = new Set(['fence', 'code_block', 'hr', 'math_block']);
md.core.ruler.push('data_line', (state: StateCore) => {
  const off = (state.env as RenderEnv).lineOffset ?? 0;
  for (const t of state.tokens) {
    if (t.map && t.level === 0 && (t.nesting === 1 || LINE_TYPES.has(t.type))) t.attrSet('data-line', String(t.map[0] + off + 1));
    else if (t.map && (t.type === 'list_item_open' || t.type === 'tr_open')) t.attrSet('data-line', String(t.map[0] + off + 1));
  }
  return true;
});

// ---- 任务列表：列表项段落开头的 [ ] / [x] 转为禁用的复选框 ----
md.core.ruler.after('inline', 'task_list', (state: StateCore) => {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const inline = toks[i];
    if (inline.type !== 'inline' || toks[i - 1].type !== 'paragraph_open' || toks[i - 2].type !== 'list_item_open') continue;
    const first = inline.children?.[0];
    const m = first && first.type === 'text' ? /^\[([ xX])\]\s/.exec(first.content) : null;
    if (!first || !m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
    inline.children!.unshift(box);
    toks[i - 2].attrJoin('class', 'task-list-item');
  }
  return true;
});

// ---- 数学公式：$..$ 行内，$$..$$ 块级。只输出转义后的源码，KaTeX 在 DOM 阶段懒渲染 ----
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24 /* $ */ || src.charCodeAt(start + 1) === 0x24) return false;
  const next = src.charCodeAt(start + 1);
  if (next === 0x20 || next === 0x09 || Number.isNaN(next)) return false;
  let end = start + 1;
  while ((end = src.indexOf('$', end)) !== -1) {
    if (src.charCodeAt(end - 1) !== 0x5c /* \ */) break;
    end++;
  }
  if (end === -1 || end === start + 1) return false;
  const prev = src.charCodeAt(end - 1);
  if (prev === 0x20 || prev === 0x09) return false;
  const after = src.charCodeAt(end + 1);
  if (after >= 0x30 && after <= 0x39) return false; // "$5 和 $6" 这类金额不当作公式
  if (!silent) {
    const t = state.push('math_inline', 'span', 0);
    t.content = src.slice(start + 1, end);
    (state.env as RenderEnv).hasMath = true;
  }
  state.pos = end + 1;
  return true;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (!state.src.startsWith('$$', pos)) return false;
  if (silent) return true;
  const first = state.src.slice(pos + 2, max);
  let content = '';
  let line = startLine;
  let found = false;
  if (first.trim().endsWith('$$') && first.trim().length >= 2) {
    content = first.trim().slice(0, -2);
    found = true;
  } else {
    const parts = [first];
    while (++line < endLine) {
      pos = state.bMarks[line] + state.tShift[line];
      max = state.eMarks[line];
      const text = state.src.slice(pos, max);
      if (text.trimEnd().endsWith('$$')) {
        parts.push(text.trimEnd().slice(0, -2));
        found = true;
        break;
      }
      parts.push(state.src.slice(state.bMarks[line], max));
    }
    content = parts.join('\n');
  }
  if (!found) return false;
  state.line = line + 1;
  const t = state.push('math_block', 'div', 0);
  t.block = true;
  t.content = content;
  t.map = [startLine, state.line];
  (state.env as RenderEnv).hasMath = true;
  return true;
}

md.inline.ruler.after('escape', 'math_inline', mathInline);
md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

const esc = md.utils.escapeHtml;
md.renderer.rules.math_inline = (tokens, idx) => `<span class="md-math">${esc(tokens[idx].content)}</span>`;
md.renderer.rules.math_block = (tokens, idx) => {
  const line = tokens[idx].attrGet('data-line');
  return `<div class="md-math md-math-display"${line ? ` data-line="${line}"` : ''}>${esc(tokens[idx].content)}</div>\n`;
};

// ---- 代码块：输出转义源码 + data-lang，Lezer 高亮与 Mermaid 在 DOM 阶段懒处理 ----
md.renderer.rules.fence = (tokens, idx, _opts, rawEnv) => {
  const env = rawEnv as RenderEnv | undefined;
  const t = tokens[idx];
  const lang = t.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const line = t.attrGet('data-line');
  const dl = line ? ` data-line="${line}"` : '';
  if (lang === 'mermaid') {
    if (env) env.hasMermaid = true;
    return `<pre class="md-mermaid"${dl}>${esc(t.content)}</pre>\n`;
  }
  const la = lang ? ` data-lang="${esc(lang)}"` : '';
  return `<pre class="md-code"${dl}><code${la}>${esc(t.content)}</code></pre>\n`;
};

export function renderMarkdown(src: string, lineOffset = 0): RenderResult {
  const env: RenderEnv = { lineOffset };
  const html = md.render(src, env);
  return { html, hasMath: !!env.hasMath, hasMermaid: !!env.hasMermaid };
}
