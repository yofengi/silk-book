// 智能复制：仅复制（不含剪切）时，裁剪每个选区起止处多余的空格、制表符与空白行；内部内容不变。
// 空选区（整行复制）与关闭时交给 CodeMirror 默认处理。
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** 只裁剪选区首尾的空白；内部缩进、空行与换行符保持原样。 */
export function smartTrim(text: string): string {
  return text.trim();
}

export function smartCopyExt(on: boolean): Extension {
  if (!on) return [];
  return EditorView.domEventHandlers({
    copy(event, view) {
      const { state } = view;
      const ranges = state.selection.ranges.filter((r) => !r.empty);
      if (!ranges.length || !event.clipboardData) return false;
      const text = ranges.map((r) => smartTrim(state.sliceDoc(r.from, r.to))).join(state.lineBreak);
      event.preventDefault();
      event.clipboardData.clearData();
      event.clipboardData.setData('text/plain', text);
      return true;
    },
  });
}
