// 编辑器 <-> 预览 双向滚动同步：基于 data-line 源行号锚点线性插值。
// 防回环：一侧程序化滚动后，在短时间内忽略另一侧产生的 scroll 事件。
import type { EditorView } from '@codemirror/view';

interface Anchor { line: number; top: number }

const LOCK_MS = 120;

/** 收集预览中所有锚点（相对 preview 内容顶部的偏移），行号与位置都单调递增 */
function anchors(preview: HTMLElement): Anchor[] {
  const base = preview.getBoundingClientRect().top - preview.scrollTop;
  const out: Anchor[] = [];
  for (const el of preview.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(el.dataset.line);
    if (Number.isFinite(line)) out.push({ line, top: el.getBoundingClientRect().top - base });
  }
  out.sort((a, b) => a.line - b.line || a.top - b.top);
  const mono: Anchor[] = [];
  for (const a of out) {
    const last = mono[mono.length - 1];
    if (!last || (a.line > last.line && a.top >= last.top)) mono.push(a);
  }
  return mono;
}

export class ScrollSync {
  private ignoreEditorUntil = 0;
  private ignorePreviewUntil = 0;
  private raf = 0;
  private readonly onEditor = () => this.schedule('editor');
  private readonly onPreview = () => this.schedule('preview');

  constructor(private view: EditorView, private preview: HTMLElement, private afterPreviewScroll: () => void) {
    view.scrollDOM.addEventListener('scroll', this.onEditor, { passive: true });
    preview.addEventListener('scroll', this.onPreview, { passive: true });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.view.scrollDOM.removeEventListener('scroll', this.onEditor);
    this.preview.removeEventListener('scroll', this.onPreview);
  }

  private schedule(from: 'editor' | 'preview'): void {
    if (from === 'preview') this.afterPreviewScroll(); // 分段渲染补齐
    const now = performance.now();
    if (from === 'editor' && now < this.ignoreEditorUntil) return;
    if (from === 'preview' && now < this.ignorePreviewUntil) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => (from === 'editor' ? this.editorToPreview() : this.previewToEditor()));
  }

  /** 编辑器顶部可见行（1 基，带小数） */
  private editorTopLine(): number {
    const v = this.view;
    const y = Math.max(0, v.scrollDOM.getBoundingClientRect().top - v.documentTop);
    const block = v.lineBlockAtHeight(y);
    const line = v.state.doc.lineAt(block.from).number;
    return line + (block.height > 0 ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0);
  }

  editorToPreview(): void {
    const as = anchors(this.preview);
    if (!as.length) return;
    const line = this.editorTopLine();
    let top: number;
    const i = as.findIndex((a) => a.line > line);
    if (i === 0) top = (as[0].top * (line - 1)) / Math.max(1, as[0].line - 1);
    else if (i === -1) top = as[as.length - 1].top;
    else {
      const a = as[i - 1], b = as[i];
      top = a.top + ((b.top - a.top) * (line - a.line)) / (b.line - a.line);
    }
    if (this.view.scrollDOM.scrollTop <= 0) top = 0;
    this.ignorePreviewUntil = performance.now() + LOCK_MS;
    this.preview.scrollTop = top;
  }

  previewToEditor(): void {
    const as = anchors(this.preview);
    if (!as.length) return;
    const y = this.preview.scrollTop;
    let line: number;
    const i = as.findIndex((a) => a.top > y);
    if (i === 0) line = 1 + (as[0].line - 1) * (as[0].top > 0 ? y / as[0].top : 0);
    else if (i === -1) line = as[as.length - 1].line;
    else {
      const a = as[i - 1], b = as[i];
      line = a.line + ((b.line - a.line) * (y - a.top)) / (b.top - a.top || 1);
    }
    const v = this.view;
    const n = Math.min(v.state.doc.lines, Math.max(1, Math.floor(line)));
    const block = v.lineBlockAt(v.state.doc.line(n).from);
    // 文档坐标 -> scrollTop：documentTop 与 scrollDOM 顶部之差即为当前偏移
    const docOffset = v.documentTop - v.scrollDOM.getBoundingClientRect().top + v.scrollDOM.scrollTop;
    this.ignoreEditorUntil = performance.now() + LOCK_MS;
    v.scrollDOM.scrollTop = y <= 0 ? 0 : docOffset + block.top + block.height * (line - n);
  }
}
