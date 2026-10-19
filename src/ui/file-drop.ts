import './tab-drag.css';
import { executeCommand, isCommandExecutionBlocked } from '../core/commands';
import { events } from '../core/events';
import { ipc, type TransferPlacement } from '../ipc';

const SCROLL_EDGE = 24;
const SCROLL_STEP = 8;
interface Point { x: number; y: number }

export function bindFileDrop(bar: HTMLElement): Promise<void> {
  let hover: Point | undefined;
  let marker: HTMLElement | undefined;
  let frame = 0;
  const blocked = () => isCommandExecutionBlocked() || document.body.inert
    || document.body.classList.contains('tab-dragging')
    || !!document.querySelector('.confirm-dialog[aria-modal="true"], dialog[open]');
  const clear = () => {
    hover = undefined;
    marker?.remove();
    marker = undefined;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const placementAt = (point: Point): TransferPlacement | undefined => {
    const bounds = bar.getBoundingClientRect();
    if (point.x < bounds.left || point.x >= bounds.right || point.y < bounds.top || point.y >= bounds.bottom) return;
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit || !bar.contains(hit)) return;
    const nodes = [...bar.querySelectorAll<HTMLElement>('[data-tab-id]')];
    const index = nodes.filter(node => {
      const rect = node.getBoundingClientRect();
      return point.x > rect.left + rect.width / 2;
    }).length;
    return { index, beforeId: nodes[index]?.dataset.tabId };
  };
  const render = (): boolean => {
    if (!hover || blocked()) { clear(); return false; }
    const placement = placementAt(hover);
    if (!placement) { clear(); return false; }
    const bounds = bar.getBoundingClientRect();
    const nodes = [...bar.querySelectorAll<HTMLElement>('[data-tab-id]')];
    const edge = nodes[placement.index]?.getBoundingClientRect().left
      ?? nodes.at(-1)?.getBoundingClientRect().right ?? bounds.left + 6;
    if (!marker) {
      marker = document.createElement('div');
      marker.className = 'tab-drop-insertion file-drop-insertion';
      marker.setAttribute('aria-hidden', 'true');
      document.body.append(marker);
    }
    marker.style.left = `${Math.max(bounds.left + 2, Math.min(edge, bounds.right - 2))}px`;
    marker.style.top = `${bounds.top + 2}px`;
    marker.style.height = `${Math.max(0, bounds.height - 4)}px`;
    return true;
  };
  const scrollStep = (): number => {
    if (!hover) return 0;
    const bounds = bar.getBoundingClientRect();
    if (hover.x < bounds.left + SCROLL_EDGE && bar.scrollLeft > 0) return -SCROLL_STEP;
    if (hover.x > bounds.right - SCROLL_EDGE && bar.scrollLeft < bar.scrollWidth - bar.clientWidth) return SCROLL_STEP;
    return 0;
  };
  const scroll = () => {
    frame = 0;
    if (!render()) return;
    const delta = scrollStep();
    if (!delta) return;
    bar.scrollLeft = Math.max(0, Math.min(bar.scrollLeft + delta, bar.scrollWidth - bar.clientWidth));
    if (render() && scrollStep()) frame = requestAnimationFrame(scroll);
  };
  window.addEventListener('blur', clear);
  events.on('commands.executionChanged', ({ blocked }) => { if (blocked) clear(); });
  return ipc.onFileDrop(event => {
    if (event.type === 'leave') { clear(); return; }
    const point = event.position;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || blocked()) { clear(); return; }
    if (event.type === 'drop') {
      const placement = placementAt(point);
      clear();
      if (!event.paths.length) return;
      void executeCommand('file.open', {
        paths: [...event.paths], here: true, drop: true, ...(placement ? { placement } : {}),
      }).catch((error: unknown) => console.error('[file-drop]', error));
      return;
    }
    hover = { ...point };
    if (render() && !frame && scrollStep()) frame = requestAnimationFrame(scroll);
  });
}
