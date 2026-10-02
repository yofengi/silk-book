// 预览的轻量状态（在主 chunk 中）：哪些标签页开启了预览、预览容器。渲染实现见 preview.ts（懒加载）。
import { events } from '../core/events';

const open = new Set<string>();
let host: HTMLElement | null = null;

export function setPreviewHost(el: HTMLElement): void {
  host = el;
}

export function previewHost(): HTMLElement | null {
  return host;
}

export function isPreviewOpen(tabId: string | undefined): boolean {
  return !!tabId && open.has(tabId);
}

export function setPreviewOpen(tabId: string, on: boolean): void {
  if (on) open.add(tabId);
  else open.delete(tabId);
  events.emit('tab.changed', { id: tabId });
}
