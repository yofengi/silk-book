// 英文拼写检查（editor.spellcheck）：只检查可见范围；代码文件只查注释与字符串，纯文本 / Markdown 查全部正文。
// 去抖后按词缓存，批量（≤ SPELL_BATCH）调用 ipc.spellCheck；后端返回 unsupported 时本会话静默停用。
import { language, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { events } from '../core/events';
import { ipc, isIpcError } from '../ipc';

const SPELL_DEBOUNCE_MS = 400;
const SPELL_BATCH = 2000;
const SPELL_MAX_WORD = 64;

/** 单词（保留大小写：小写化会让专有名词 / 句首词被误判）→ 是否拼写正确 */
const cache = new Map<string, boolean>();
const pending = new Set<string>();
const cacheListeners = new Set<() => void>();
let unsupported = false;

export function spellcheckUnsupported(): boolean {
  return unsupported;
}

const WORD = /[A-Za-z]+(?:'[A-Za-z]+)*/g;
const URL_RE = /\b(?:https?:\/\/|www\.|mailto:)\S+/gi;
const TOKEN_RE = /\S+/g;
/** Markdown 中不检查的节点：代码块 / 行内代码 / 链接地址 / HTML */
const MD_SKIP = /Code|URL|HTML|Comment|Autolink/;

/** 跳过：单字母、过长、全大写、camelCase */
function skipWord(w: string): boolean {
  return w.length < 2 || w.length > SPELL_MAX_WORD || /^[A-Z]+$/.test(w) || /[a-z][A-Z]/.test(w);
}

interface WordHit { from: number; to: number; word: string }

/** 在 [from, to) 中找候选单词；跳过 URL 与含数字 / 下划线的串 */
function wordsIn(state: EditorState, from: number, to: number, out: WordHit[]): void {
  if (to <= from) return;
  const text = state.sliceDoc(from, to);
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index, m.index + m[0].length] as const);
  for (const m of text.matchAll(TOKEN_RE)) {
    if (/[\d_]/.test(m[0]) || urls.some(([a, b]) => m.index >= a && m.index < b)) continue;
    for (const w of m[0].matchAll(WORD)) {
      if (skipWord(w[0])) continue;
      const start = from + m.index + w.index;
      out.push({ from: start, to: start + w[0].length, word: w[0] });
    }
  }
}

function collect(view: EditorView): WordHit[] {
  const { state } = view;
  const lang = state.facet(language)?.name ?? '';
  const tree = syntaxTree(state);
  const out: WordHit[] = [];
  for (const { from, to } of view.visibleRanges) {
    if (!lang) {
      wordsIn(state, from, to, out);
    } else if (lang === 'markdown') {
      let pos = from;
      tree.iterate({
        from, to,
        enter: (n) => {
          if (!MD_SKIP.test(n.name)) return;
          wordsIn(state, pos, Math.min(n.from, to), out);
          pos = Math.max(pos, n.to);
          return false;
        },
      });
      wordsIn(state, pos, to, out);
    } else {
      tree.iterate({
        from, to,
        enter: (n) => {
          // Lezer 语法为 LineComment / String…；legacy StreamLanguage 为小写 comment / string
          if (!/comment|string/i.test(n.name)) return;
          wordsIn(state, Math.max(n.from, from), Math.min(n.to, to), out);
          return false;
        },
      });
    }
  }
  return out;
}

const misspelled = Decoration.mark({ class: 'cm-misspelled' });

function build(hits: WordHit[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const h of hits.sort((a, c) => a.from - c.from)) {
    if (h.from < last || cache.get(h.word) !== false) continue;
    b.add(h.from, h.to, misspelled);
    last = h.to;
  }
  return b.finish();
}

async function checkWords(words: string[]): Promise<void> {
  try {
    for (let i = 0; i < words.length && !unsupported; i += SPELL_BATCH) {
      const batch = words.slice(i, i + SPELL_BATCH);
      try {
        const wrong = new Set(await ipc.spellCheck(batch));
        for (const w of batch) cache.set(w, !wrong.has(w));
      } catch (e) {
        if (isIpcError(e) && e.kind === 'unsupported') {
          unsupported = true;
          events.emit('spellcheck.unsupported', undefined);
        } else console.warn('[spellcheck]', e);
        return;
      }
    }
  } finally {
    // 失败或停用也须释放尚未发送的批次；切标签后的插件可能在等待同一组词。
    for (const w of words) pending.delete(w);
    for (const refresh of cacheListeners) refresh();
  }
}

const plugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none;
  timer: ReturnType<typeof setTimeout> | undefined;
  destroyed = false;
  readonly refresh = () => {
    if (this.destroyed) return;
    this.decorations = unsupported ? Decoration.none : build(collect(this.view));
    this.view.dispatch({});
  };
  constructor(readonly view: EditorView) { cacheListeners.add(this.refresh); this.schedule(); }
  update(u: ViewUpdate) {
    if (u.docChanged) this.decorations = this.decorations.map(u.changes);
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    if (!unsupported) this.timer = setTimeout(() => void this.run(), SPELL_DEBOUNCE_MS);
  }
  async run() {
    if (this.destroyed || unsupported) return;
    const todo = [...new Set(collect(this.view).map((h) => h.word))].filter((w) => !cache.has(w) && !pending.has(w));
    for (const w of todo) pending.add(w);
    if (todo.length) await checkWords(todo);
    if (this.destroyed) return;
    // 检查期间可能已编辑：按当前文档重新收集，只用缓存
    this.refresh();
  }
  destroy() { this.destroyed = true; cacheListeners.delete(this.refresh); clearTimeout(this.timer); }
}, { decorations: (p) => p.decorations });

const theme = EditorView.baseTheme({
  '.cm-misspelled': {
    textDecoration: 'underline wavy var(--spell-error, #e5484d)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
});

export function spellcheckExt(on: boolean): Extension {
  return on && !unsupported ? [plugin, theme] : [];
}
