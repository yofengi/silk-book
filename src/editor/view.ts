// CodeMirror 实例创建与 Compartment 管理。全局只有一个 EditorView，每个标签页持有自己的 EditorState。
// 规则：可切换功能一律通过 Compartment 热切换，不重建 EditorView。
import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap, type CompletionSource } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { editorThemeExt } from '../themes';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension, type Text } from '@codemirror/state';
import {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection, type Command,
} from '@codemirror/view';
import { showMinimap } from '@replit/codemirror-minimap';
import { getSetting } from '../core/settings';
import { editorPhrases } from '../i18n';
import { smartCopyExt } from './smart-copy';
import { spellcheckExt } from './spellcheck';

/** 每个 EditorState 内都带有这组 Compartment（Compartment 实例全局共享，内容按 state 独立） */
export const compartments = {
  language: new Compartment(),
  theme: new Compartment(),
  phrases: new Compartment(),
  minimap: new Compartment(),
  /** 补全：语言补全源（始终启用）+ 单词补全（按 wordCompletion 开关） */
  completion: new Compartment(),
  lineWrap: new Compartment(),
  /** 制表符行为 + tabSize + indentUnit */
  tabSize: new Compartment(),
  /** 以下为全局设置（常规）：设置变化时对所有标签页 reconfigure */
  lineNumbers: new Compartment(),
  activeLine: new Compartment(),
  smartCopy: new Compartment(),
  spellcheck: new Compartment(),
};

export interface FeatureFlags {
  minimap: boolean;
  wordCompletion: boolean;
  lineWrap: boolean;
}

export function minimapExt(on: boolean): Extension {
  if (!on) return [];
  return showMinimap.of({
    create: () => ({ dom: document.createElement('div') }),
    displayText: 'blocks',
    showOverlay: 'always',
  });
}

/** 合并语言补全源与单词补全；两者都没有时不挂 autocompletion */
export function completionExt(word: boolean, lang: CompletionSource | null = null): Extension {
  const override: CompletionSource[] = [];
  if (lang) override.push(lang);
  if (word) override.push(completeAnyWord);
  return override.length ? autocompletion({ override }) : [];
}

export function lineWrapExt(on: boolean): Extension {
  return on ? EditorView.lineWrapping : [];
}

export function lineNumbersExt(on: boolean): Extension {
  return on ? lineNumbers() : [];
}

/** 高亮光标所在行：行背景 + 行号槽 */
export function activeLineExt(on: boolean): Extension {
  return on ? [highlightActiveLine(), highlightActiveLineGutter()] : [];
}

/** 'spaces2' → 2；'tab' 或未知值 → 0（插入 \t） */
export function tabSpaces(behavior: string): number {
  const m = /^spaces([248])$/.exec(behavior);
  return m ? Number(m[1]) : 0;
}

/**
 * Tab 键：有选区跨行时整体缩进（indentMore，按 indentUnit）；否则在光标处插入 \t 或 N 个空格。
 * Shift+Tab 反缩进。只影响新键入的内容，已有制表符不替换。
 */
function insertTabCmd(spaces: number): Command {
  const unit = spaces ? ' '.repeat(spaces) : '\t';
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    if (state.selection.ranges.some((r) => !r.empty && state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number)) {
      return indentMore(view);
    }
    view.dispatch(state.update(state.changeByRange((r) => ({
      changes: { from: r.from, to: r.to, insert: unit },
      range: EditorSelection.cursor(r.from + unit.length),
    })), { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

export function tabSizeExt(n: number, behavior: string = getSetting('editor.tabBehavior')): Extension {
  const spaces = tabSpaces(behavior);
  return [
    // 已有制表符的显示宽度仍按 editor.tabSize，不随 Tab 键行为变化
    EditorState.tabSize.of(n),
    indentUnit.of(spaces ? ' '.repeat(spaces) : '\t'),
    keymap.of([{ key: 'Tab', run: insertTabCmd(spaces), shift: indentLess }]),
  ];
}

function baseExtensions(): Extension {
  return [
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
    ]),
  ];
}

export function createState(text: string | Text, flags: FeatureFlags, tabSize: number, extra: Extension): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      // 行号放最前，保证行号槽在折叠槽左侧（与原先顺序一致）
      compartments.lineNumbers.of(lineNumbersExt(getSetting('editor.lineNumbers'))),
      compartments.activeLine.of(activeLineExt(getSetting('editor.highlightActiveLine'))),
      baseExtensions(),
      compartments.language.of([]),
      compartments.theme.of(editorThemeExt()),
      compartments.phrases.of(EditorState.phrases.of(editorPhrases())),
      compartments.minimap.of(minimapExt(flags.minimap)),
      compartments.completion.of(completionExt(flags.wordCompletion)),
      compartments.lineWrap.of(lineWrapExt(flags.lineWrap)),
      compartments.tabSize.of(tabSizeExt(tabSize)),
      compartments.smartCopy.of(smartCopyExt(getSetting('editor.smartCopy'))),
      compartments.spellcheck.of(spellcheckExt(getSetting('editor.spellcheck'))),
      extra,
    ],
  });
}

export function createView(parent: HTMLElement, state: EditorState): EditorView {
  return new EditorView({ parent, state });
}
