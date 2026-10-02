// 标签页管理：单个 EditorView，每个标签页一个 EditorState；切换时 setState
import type { CompletionSource } from '@codemirror/autocomplete';
import { EditorState, type StateEffect, type Text } from '@codemirror/state';
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { events } from '../core/events';
import { getSetting } from '../core/settings';
import { createDocument, pathKey, type DocumentInfo } from './document';
import { editorPhrases } from '../i18n';
import { largeFileExtensions } from './large-file';
import { languageById, languageForPath, loadCompletions, loadLanguage, PLAIN_TEXT } from './languages';
import { bumpFontGeneration, editorThemeExt } from '../themes';
import { activeLineExt, compartments, completionExt, createState, createView, lineNumbersExt, lineWrapExt, minimapExt, tabSizeExt, type FeatureFlags } from './view';
import { smartCopyExt } from './smart-copy';
import { spellcheckExt } from './spellcheck';

export interface Tab {
  id: string;
  doc: DocumentInfo;
  state: EditorState;
  languageId: string;
  flags: FeatureFlags;
  /** 当前语言的补全源（无则 null），与单词补全合并 */
  completionSource: CompletionSource | null;
  /** 保存时的文档快照，用于判断 dirty */
  savedDoc: EditorState['doc'];
  /** 元数据（换行符 / 编码）已修改但未保存 */
  metaDirty?: boolean;
}

/** 非文件标签页（如“设置”）：不持有 EditorState；激活时 activeTab() 返回 undefined，文件类命令自然禁用 */
export interface SpecialTab {
  id: string;
  /** 标题按当前界面语言解析（切换语言后标签栏重绘即更新） */
  title: () => string;
}
export const SPECIAL_PREFIX = 'special:';

const tabs: Tab[] = [];
const specials: SpecialTab[] = [];
/** 标签栏显示顺序（文件与特殊标签页混排，可拖拽重排） */
const order: string[] = [];
let activeId: string | null = null;
let view: EditorView | null = null;
let seq = 0;

export function mountEditor(parent: HTMLElement): void {
  const placeholder = createState('', { minimap: false, wordCompletion: false, lineWrap: false }, 4, EditorView.editable.of(false));
  view = createView(parent, placeholder);
  // 主题切换：对所有标签页的 state 下发 theme Compartment reconfigure，不重建 view
  const refreshTheme = () => {
    const effects = compartments.theme.reconfigure(editorThemeExt());
    for (const t of tabs) reconfigure(t, effects);
    if (view && !activeTab()) view.dispatch({ effects });
  };
  events.on('theme.changed', refreshTheme);
  // 字体 CSS 变量变化：换一个主题扩展实例触发重新测量
  events.on('fonts.changed', () => { bumpFontGeneration(); refreshTheme(); });
  // 常规设置：全局生效，对所有标签页下发 reconfigure（不重建 view）
  events.on('settings.changed', ({ key }) => {
    const eff = globalEffect(key);
    if (!eff) return;
    if (key === 'editor.wordWrap') for (const t of tabs) t.flags.lineWrap = getSetting('editor.wordWrap');
    for (const t of tabs) reconfigure(t, eff);
    if (key === 'editor.wordWrap') events.emit('tab.changed', { id: activeId ?? '' });
  });
  events.on('spellcheck.unsupported', () => {
    for (const t of tabs) reconfigure(t, compartments.spellcheck.reconfigure([]));
  });
  events.on('locale.changed', () => {
    const effects = compartments.phrases.reconfigure(EditorState.phrases.of(editorPhrases()));
    for (const t of tabs) reconfigure(t, effects);
    // CodeMirror 的已挂载搜索面板不会在 phrases reconfigure 后重绘标题。
    if (view) refreshSearchPanel(view);
  });
}

function globalEffect(key: string): StateEffect<unknown> | null {
  switch (key) {
    case 'editor.wordWrap': return compartments.lineWrap.reconfigure(lineWrapExt(getSetting('editor.wordWrap')));
    case 'editor.lineNumbers': return compartments.lineNumbers.reconfigure(lineNumbersExt(getSetting('editor.lineNumbers')));
    case 'editor.highlightActiveLine': return compartments.activeLine.reconfigure(activeLineExt(getSetting('editor.highlightActiveLine')));
    case 'editor.tabBehavior': case 'editor.tabSize':
      return compartments.tabSize.reconfigure(tabSizeExt(getSetting('editor.tabSize')));
    case 'editor.smartCopy': return compartments.smartCopy.reconfigure(smartCopyExt(getSetting('editor.smartCopy')));
    case 'editor.spellcheck': return compartments.spellcheck.reconfigure(spellcheckExt(getSetting('editor.spellcheck')));
    default: return null;
  }
}

export function getView(): EditorView | null {
  return view;
}

export function listTabs(): readonly Tab[] {
  return tabs;
}

export function activeTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeId);
}

export function listSpecialTabs(): readonly SpecialTab[] {
  return specials;
}

/** 当前激活的非文件标签页 */
export function activeSpecial(): SpecialTab | undefined {
  return specials.find((s) => s.id === activeId);
}

/** 标签栏顺序（显示顺序，文件与特殊标签页混排） */
export function allTabIds(): string[] {
  return [...order];
}

/** 把标签页移动到显示顺序中的 index 位置（按移除自身后的下标计算）；越界自动夹紧 */
export function moveTab(id: string, index: number): void {
  const from = order.indexOf(id);
  if (from < 0) return;
  order.splice(from, 1);
  const to = Math.max(0, Math.min(index, order.length));
  order.splice(to, 0, id);
  if (to !== from) events.emit('tabs.listChanged', undefined);
}

/** 打开（或切换到）特殊标签页 */
export function openSpecialTab(id: string, title: () => string): void {
  if (!specials.some((s) => s.id === id)) {
    specials.push({ id, title });
    order.push(id);
    events.emit('tabs.listChanged', undefined);
  }
  activateTab(id);
}

export function findTabByPath(path: string): Tab | undefined {
  const k = pathKey(path);
  return tabs.find((t) => t.doc.path !== null && pathKey(t.doc.path) === k);
}

function syncActiveState(): void {
  const t = activeTab();
  if (t && view) t.state = view.state;
}

function dirtyTracker(id: string) {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    t.state = u.state;
    events.emit('doc.changed', { id });
    const dirty = !!t.metaDirty || !u.state.doc.eq(t.savedDoc);
    if (dirty !== t.doc.dirty) {
      t.doc.dirty = dirty;
      events.emit('tab.changed', { id });
    }
  });
}

export function openTab(text: string | Text, info: Partial<DocumentInfo>, flagsOverride?: Partial<FeatureFlags>): Tab {
  const id = `tab-${++seq}`;
  const doc = createDocument(info);
  const flags: FeatureFlags = {
    minimap: getSetting('editor.minimap'),
    wordCompletion: getSetting('editor.wordCompletion'),
    ...flagsOverride,
    lineWrap: getSetting('editor.wordWrap'),
  };
  const state = createState(text, flags, getSetting('editor.tabSize'), [dirtyTracker(id), largeFileExtensions(doc.tier)]);
  const lang = languageForPath(doc.path);
  const tab: Tab = { id, doc, state, languageId: lang?.id ?? PLAIN_TEXT.id, flags, completionSource: null, savedDoc: state.doc };
  tabs.push(tab);
  order.push(id);
  events.emit('tabs.listChanged', undefined);
  activateTab(id);
  if (lang) void applyLanguage(tab, lang.id);
  return tab;
}

/** 当前激活标签页的视图快照（光标 / 滚动锚点），用于跨窗口移动标签页 */
export function viewSnapshot(tab: Tab): { anchor: number; head: number; scrollPos: number } {
  const st = tab.id === activeId && view ? view.state : tab.state;
  const sel = st.selection.main;
  let scrollPos = sel.head;
  if (view && tab.id === activeId) {
    try { scrollPos = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from; } catch { /* 未布局 */ }
  }
  return { anchor: sel.anchor, head: sel.head, scrollPos };
}

/** 恢复光标与滚动锚点（仅对当前激活的标签页生效） */
export function restoreViewSnapshot(tab: Tab, snap: { anchor: number; head: number; scrollPos: number }): void {
  if (!view || tab.id !== activeId) return;
  const len = view.state.doc.length;
  const clamp = (n: number) => Math.max(0, Math.min(Number.isFinite(n) ? n : 0, len));
  view.dispatch({
    selection: { anchor: clamp(snap.anchor), head: clamp(snap.head) },
    effects: EditorView.scrollIntoView(clamp(snap.scrollPos), { y: 'start' }),
  });
}

/** 把标签页标记为“有未保存修改”（跨窗口移入的脏文档没有已保存快照） */
export function markTransferredDirty(tab: Tab): void {
  tab.metaDirty = true;
  if (!tab.doc.dirty) {
    tab.doc.dirty = true;
    events.emit('tab.changed', { id: tab.id });
  }
}

export function activateTab(id: string | null): void {
  syncActiveState();
  const special = specials.find((s) => s.id === id);
  if (special) {
    activeId = special.id;
    events.emit('tab.activated', { id: activeId });
    return;
  }
  const t = tabs.find((x) => x.id === id);
  activeId = t ? t.id : null;
  if (view) {
    if (t) {
      view.setState(t.state);
      refreshSearchPanel(view);
      view.focus();
    } else {
      view.setState(createState('', { minimap: false, wordCompletion: false, lineWrap: false }, 4, EditorView.editable.of(false)));
    }
  }
  events.emit('tab.activated', { id: activeId });
}

/** 关闭标签页（不做确认；确认由命令层负责） */
export function closeTab(id: string): void {
  const i = order.indexOf(id);
  if (i < 0) return;
  const wasActive = id === activeId;
  const ti = tabs.findIndex((t) => t.id === id);
  if (ti >= 0) tabs.splice(ti, 1);
  else specials.splice(specials.findIndex((s) => s.id === id), 1);
  order.splice(i, 1);
  events.emit('tabs.listChanged', undefined);
  if (wasActive) {
    activeId = null;
    const rest = allTabIds();
    activateTab(rest[Math.min(i, rest.length - 1)] ?? null);
  }
}

/** 对某标签页的 state 下发 reconfigure；活动标签页通过 view.dispatch，其余直接更新其 state */
function reconfigure(tab: Tab, effects: StateEffect<unknown> | readonly StateEffect<unknown>[]): void {
  if (tab.id === activeId && view) {
    view.dispatch({ effects });
    tab.state = view.state;
  } else {
    tab.state = tab.state.update({ effects }).state;
  }
}

export async function applyLanguage(tab: Tab, languageId: string): Promise<void> {
  const def = languageById(languageId);
  tab.languageId = def ? def.id : PLAIN_TEXT.id;
  if (!def) {
    tab.completionSource = null;
    reconfigure(tab, [
      compartments.language.reconfigure([]),
      compartments.completion.reconfigure(completionExt(tab.flags.wordCompletion)),
    ]);
  } else {
    // 补全源独立 chunk，与语言包并行加载；补全加载失败不影响高亮
    const [ext, source] = await Promise.all([loadLanguage(def), loadCompletions(def)]);
    if (!tabs.includes(tab) || tab.languageId !== def.id) return;
    tab.completionSource = source;
    reconfigure(tab, [
      compartments.language.reconfigure(ext),
      compartments.completion.reconfigure(completionExt(tab.flags.wordCompletion, source)),
    ]);
  }
  events.emit('tab.changed', { id: tab.id });
}

export function setFlag(tab: Tab, flag: keyof FeatureFlags, on: boolean): void {
  tab.flags[flag] = on;
  const eff =
    flag === 'minimap' ? compartments.minimap.reconfigure(minimapExt(on))
    : flag === 'wordCompletion' ? compartments.completion.reconfigure(completionExt(on, tab.completionSource))
    : compartments.lineWrap.reconfigure(lineWrapExt(on));
  reconfigure(tab, eff);
  events.emit('tab.changed', { id: tab.id });
}

export function tabText(tab: Tab): string {
  if (tab.id === activeId && view) tab.state = view.state;
  return tab.state.doc.toString();
}

export type SavedMetadata = Pick<DocumentInfo, 'encoding' | 'eol' | 'hasBom' | 'eolMap'>;

/** 以实际写入磁盘的快照为 baseline；异步保存期间的新编辑与元数据修改必须仍为 dirty。 */
export function markSaved(tab: Tab, patch: Partial<DocumentInfo>, savedDoc?: Text, savedMeta?: SavedMetadata): void {
  if (tab.id === activeId && view) tab.state = view.state;
  tab.savedDoc = savedDoc ?? tab.state.doc;
  const pathChanged = patch.path !== undefined && patch.path !== tab.doc.path;
  const metaChanged = savedMeta && (['encoding', 'eol', 'hasBom', 'eolMap'] as const)
    .some((key) => tab.doc[key] !== savedMeta[key]);
  const applied = { ...patch };
  if (metaChanged) {
    for (const key of ['encoding', 'eol', 'hasBom', 'eolMap'] as const) delete applied[key];
  }
  tab.metaDirty = !!metaChanged;
  Object.assign(tab.doc, applied, { dirty: tab.metaDirty || !tab.state.doc.eq(tab.savedDoc) });
  events.emit('tab.changed', { id: tab.id });
  if (pathChanged) {
    const lang = languageForPath(tab.doc.path);
    void applyLanguage(tab, lang?.id ?? PLAIN_TEXT.id);
  }
}

function refreshSearchPanel(editor: EditorView): void {
  if (!searchPanelOpen(editor.state)) return;
  const focused = document.activeElement;
  const field = focused instanceof HTMLInputElement && focused.closest('.cm-search') ? focused : undefined;
  const name = field?.name;
  const selection = field ? [field.selectionStart, field.selectionEnd] : undefined;
  closeSearchPanel(editor);
  openSearchPanel(editor);
  if (name) {
    const input = [...editor.dom.querySelectorAll<HTMLInputElement>('.cm-search input')].find((el) => el.name === name);
    input?.focus();
    if (input && selection) input.setSelectionRange(selection[0], selection[1]);
  } else if (focused instanceof HTMLElement) focused.focus();
  const tab = activeTab();
  if (tab) tab.state = editor.state;
}

/** 修改文档元数据（如换行符）；markDirty 时标记未保存 */
export function updateDocInfo(tab: Tab, patch: Partial<DocumentInfo>, markDirty: boolean): void {
  Object.assign(tab.doc, patch);
  if (markDirty) { tab.metaDirty = true; tab.doc.dirty = true; }
  events.emit('tab.changed', { id: tab.id });
}

/** 用磁盘内容替换标签页文档（重新加载 / 通过编码重新打开）；撤销历史保留为一次替换 */
export function replaceTabContent(tab: Tab, text: Text, patch: Partial<DocumentInfo>): void {
  const tx = { changes: { from: 0, to: tab.state.doc.length, insert: text } };
  if (tab.id === activeId && view) { view.dispatch(tx); tab.state = view.state; }
  else tab.state = tab.state.update(tx).state;
  markSaved(tab, patch);
}
