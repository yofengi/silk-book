// 大文件策略（ARCHITECTURE 4.1）：档位判定、视口高亮 + 下方 N 屏预解析、按行构建文档
import { forceParsing, syntaxTree } from '@codemirror/language';
import { Text, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { getSetting } from '../core/settings';
import { sizeTier, type SizeTier } from './document';
import type { FeatureFlags } from './view';

export { sizeTier };

/** 每个空闲时间片内的解析预算上限（毫秒），保持主线程响应 */
const SLICE_BUDGET_MS = 8;

export function isLargeTier(tier: SizeTier): boolean {
  return tier !== 'Normal';
}

/** Large/Huge 默认关闭小地图与单词补全（顶栏开关仍可打开） */
export function tierFlagsOverride(tier: SizeTier): Partial<FeatureFlags> | undefined {
  return isLargeTier(tier) ? { minimap: false, wordCompletion: false } : undefined;
}

interface IdleHandle { cancel(): void }

function scheduleIdle(fn: (remaining: () => number) => void): IdleHandle {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback((d) => fn(() => d.timeRemaining()), { timeout: 200 });
    return { cancel: () => cancelIdleCallback(id) };
  }
  const id = setTimeout(() => fn(() => SLICE_BUDGET_MS), 16);
  return { cancel: () => clearTimeout(id) };
}

/**
 * 预解析插件：视口变化或空闲时，以小时间片 forceParsing 到“视口末尾 + N 屏”。
 * 若语法树尚未覆盖到视口起点（用户跳到远处），不追赶前缀，避免全量解析；
 * 此时由 CodeMirror 内置的视口解析负责可见区。
 */
export function prerenderPlugin(screens: number): Extension {
  return ViewPlugin.fromClass(
    class {
      private pending: IdleHandle | null = null;
      constructor(private view: EditorView) {
        this.schedule();
      }
      update(u: ViewUpdate): void {
        if (u.viewportChanged || u.docChanged) this.schedule();
      }
      destroy(): void {
        this.pending?.cancel();
        this.pending = null;
      }
      private target(): number {
        const { state, viewport } = this.view;
        const doc = state.doc;
        const first = doc.lineAt(viewport.from).number;
        const last = doc.lineAt(viewport.to).number;
        const screenLines = Math.max(1, last - first + 1);
        return doc.line(Math.min(doc.lines, last + screens * screenLines)).to;
      }
      private schedule(): void {
        this.pending?.cancel();
        this.pending = scheduleIdle((remaining) => {
          this.pending = null;
          const view = this.view;
          const covered = syntaxTree(view.state).length;
          if (covered < view.viewport.from) return;
          const target = this.target();
          if (covered >= target) return;
          const budget = Math.max(1, Math.min(SLICE_BUDGET_MS, remaining()));
          if (!forceParsing(view, target, budget)) this.schedule();
        });
      }
    },
  );
}

/** 按档位附加的扩展 */
export function largeFileExtensions(tier: SizeTier): Extension {
  if (!isLargeTier(tier)) return [];
  return prerenderPlugin(Math.max(0, getSetting('editor.prerenderScreens')));
}

/** 流式按行累积，避免 join('') + split 产生的整串峰值；最终用 Text.of 构建文档 */
export class LineCollector {
  private lines: string[] = [];
  private tail = '';
  push(s: string): void {
    if (!s) return;
    let i = s.indexOf('\n');
    if (i < 0) {
      this.tail += s;
      return;
    }
    this.lines.push(this.tail + s.slice(0, i));
    let start = i + 1;
    while ((i = s.indexOf('\n', start)) >= 0) {
      this.lines.push(s.slice(start, i));
      start = i + 1;
    }
    this.tail = s.slice(start);
  }
  finish(): Text {
    this.lines.push(this.tail);
    this.tail = '';
    const t = Text.of(this.lines);
    this.lines = [];
    return t;
  }
}
