// Markdown 预览（整个模块经动态 import() 懒加载）。
// Normal 档：整篇渲染；Large/Huge 档：按顶层块分段，只渲染视口及下方 N 屏，其余为估高占位。
import type { EditorView } from '@codemirror/view';
import { getSetting } from '../core/settings';
import type { Tab } from '../editor/tabs';
import { t } from '../i18n';
import { events } from '../core/events';
import { blockNavigation, enhance, rerenderMermaid, sanitize } from './postprocess';
import { renderMarkdown } from './render';
import { ScrollSync } from './scroll-sync';
import { splitSegments, type Segment } from './segments';

/** 分段时每段最少行数（段越大，渲染块越粗） */
const SEGMENT_MIN_LINES = 40;
/** 估算占位高度用的每行像素 */
const EST_LINE_PX = 22;

interface SegState extends Segment {
  el: HTMLElement;
  rendered: boolean;
}

export class Preview {
  readonly root: HTMLElement;
  private content: HTMLElement;
  private tab: Tab | null = null;
  private sync: ScrollSync;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private segs: SegState[] = [];
  private io: IntersectionObserver | null = null;
  private offTheme: () => void;

  constructor(host: HTMLElement, private view: EditorView) {
    this.root = document.createElement('div');
    this.root.className = 'md-preview';
    this.root.setAttribute('role', 'document');
    this.root.setAttribute('aria-label', t('preview.label'));
    this.root.tabIndex = 0;
    this.content = document.createElement('div');
    this.content.className = 'md-body';
    this.root.append(this.content);
    blockNavigation(this.root);
    host.append(this.root);
    this.sync = new ScrollSync(view, this.root, () => this.fillViewport());
    this.offTheme = events.on('theme.changed', () => rerenderMermaid(this.content));
  }

  /** 绑定到标签页并立即渲染 */
  show(tab: Tab): void {
    this.tab = tab;
    clearTimeout(this.timer);
    this.render();
    requestAnimationFrame(() => this.sync.editorToPreview());
  }

  /** 文档变更：防抖重渲染 */
  scheduleRender(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), getSetting('markdown.previewDebounce'));
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.offTheme();
    this.io?.disconnect();
    this.sync.destroy();
    this.root.remove();
  }

  private render(): void {
    const tab = this.tab;
    if (!tab) return;
    const doc = this.view.state.doc;
    const keep = this.root.scrollTop;
    this.io?.disconnect();
    this.io = null;
    this.segs = [];
    if (tab.doc.tier === 'Normal') {
      const r = renderMarkdown(doc.toString());
      this.content.innerHTML = sanitize(r.html);
      enhance(this.content, r, this.tab?.doc.path);
    } else {
      this.renderSegmented(splitSegments(doc, SEGMENT_MIN_LINES));
    }
    this.root.scrollTop = keep;
    this.fillViewport();
  }

  private renderSegmented(list: Segment[]): void {
    const frag = document.createDocumentFragment();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.renderSeg(this.segs[Number((e.target as HTMLElement).dataset.seg)]);
    }, { root: this.root, rootMargin: `0px 0px ${this.prerenderPx()}px 0px` });
    this.io = io;
    list.forEach((s, i) => {
      const el = document.createElement('section');
      el.className = 'md-seg md-seg-pending';
      el.dataset.seg = String(i);
      // 占位也带 data-line，滚动同步在未渲染区按行号插值
      el.dataset.line = String(s.start + 1);
      el.style.height = `${Math.max(1, s.lines) * EST_LINE_PX}px`;
      this.segs.push({ ...s, el, rendered: false });
      io.observe(el);
      frag.append(el);
    });
    this.content.replaceChildren(frag);
  }

  private prerenderPx(): number {
    return (this.root.clientHeight || window.innerHeight) * getSetting('editor.prerenderScreens');
  }

  private renderSeg(s: SegState | undefined): void {
    if (!s || s.rendered) return;
    s.rendered = true;
    const r = renderMarkdown(s.text, s.start);
    s.el.innerHTML = sanitize(r.html);
    s.el.classList.remove('md-seg-pending');
    s.el.style.height = '';
    this.io?.unobserve(s.el);
    enhance(s.el, r, this.tab?.doc.path);
  }

  /** 同步补齐视口及下方 N 屏内的段（快速跳转时 IntersectionObserver 可能晚一帧） */
  private fillViewport(): void {
    if (!this.segs.length) return;
    const top = this.root.scrollTop;
    const bottom = top + this.root.clientHeight + this.prerenderPx();
    for (const s of this.segs) {
      if (s.rendered) continue;
      const y = s.el.offsetTop;
      if (y > bottom) break;
      if (y + s.el.offsetHeight >= top) this.renderSeg(s);
    }
  }
}

export function createPreview(host: HTMLElement, view: EditorView): Preview {
  return new Preview(host, view);
}
