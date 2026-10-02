// Pointer capture 在指针离开 WebView 时仍接收释放事件；无需 HTML 文件拖放。
import './tab-drag.css';
import { executeCommand, isCommandExecutionBlocked } from '../core/commands';
import { events } from '../core/events';
import { allTabIds, listTabs } from '../editor/tabs';
import { isTransferring } from '../editor/transfer';
import { ipc, type TransferPlacement } from '../ipc';

const START_DISTANCE = 5;
const SCROLL_EDGE = 24;
const SCROLL_STEP = 8;
const PROBE_TIMEOUT_MS = 1500;
const HOVER_INTERVAL_MS = 120;
let sequence = 0;

interface ScreenPoint { x: number; y: number }
interface DropProbe extends ScreenPoint { requestId: string; source: string; session?: string }
interface DropReply { requestId: string; target: string; placement?: TransferPlacement; blocked?: boolean }
interface DropClear { source: string; session: string }
const pendingProbes = new Map<string, { target: string; finish: (reply?: DropReply) => void }>();
let repliesReady: Promise<void> | undefined;

function installDropReplies(): Promise<void> {
  return repliesReady ??= ipc.bus.on<DropReply>('tab-drop-reply', (reply) => {
    if (!reply || typeof reply.requestId !== 'string') return;
    const request = pendingProbes.get(reply.requestId);
    if (request?.target === reply.target) request.finish(reply);
  }).catch((error: unknown) => { repliesReady = undefined; throw error; });
}

async function requestPlacement(target: string, point: ScreenPoint, session?: string): Promise<DropReply | undefined> {
  await installDropReplies();
  const requestId = `${ipc.bus.label}-${++sequence}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(), PROBE_TIMEOUT_MS);
    const finish = (reply?: DropReply) => {
      clearTimeout(timer);
      pendingProbes.delete(requestId);
      resolve(reply);
    };
    pendingProbes.set(requestId, { target, finish });
    void ipc.bus.send(target, 'tab-drop-probe', { requestId, source: ipc.bus.label, ...point, session })
      .catch(() => finish());
  });
}

/** 所有落点均为屏幕物理像素；只有目标标签栏明确应答才尝试合并。 */
export async function dropTabAtScreenPoint(id: string, point: ScreenPoint, position?: ScreenPoint, allowDetach = true): Promise<boolean> {
  if (isCommandExecutionBlocked() || !listTabs().some((tab) => tab.id === id) || isTransferring(id)) return false;
  const target = await ipc.windowDropTarget(point);
  let placement: TransferPlacement | undefined;
  if (target && target !== ipc.bus.label) {
    const reply = await requestPlacement(target, point);
    // 未初始化、关闭/退出中的目标，或没有收到可靠应答时，保留源标签。
    if (!reply || reply.blocked) return false;
    placement = reply.placement;
  }
  // 捕获指针的客户区坐标不代表屏幕上方窗口；本窗内部释放仍只排序。
  if (!placement && !allowDetach) return false;
  await executeCommand('tab.activate', id);
  return await executeCommand('tab.moveToNewWindow', placement
    ? { id, target, placement } : { id, ...position }) === true;
}

function bindDropTarget(bar: HTMLElement): void {
  let marker: HTMLElement | undefined;
  let markerTimer: ReturnType<typeof setTimeout> | undefined;
  let previewKey: string | undefined;
  let generation = 0;
  const clear = () => {
    marker?.remove(); marker = undefined;
    if (markerTimer) clearTimeout(markerTimer);
  };
  const invalidate = () => { ++generation; previewKey = undefined; clear(); };
  events.on('commands.executionChanged', ({ blocked }) => { if (blocked) invalidate(); });
  void ipc.bus.on<DropClear>('tab-drop-clear', (message) => {
    if (message && previewKey === `${message.source}/${message.session}`) invalidate();
  }).catch((error: unknown) => console.warn('tab drop listener failed', error));
  void ipc.bus.on<DropProbe>('tab-drop-probe', (probe) => {
    if (!probe || typeof probe.requestId !== 'string' || typeof probe.source !== 'string'
      || !Number.isFinite(probe.x) || !Number.isFinite(probe.y)) return;
    const key = probe.session ? `${probe.source}/${probe.session}` : undefined;
    const current = key ? ++generation : generation;
    if (key) { previewKey = key; clear(); }
    void (async () => {
      const reply: DropReply = { requestId: probe.requestId, target: ipc.bus.label };
      if (isCommandExecutionBlocked() || document.body.inert) reply.blocked = true;
      else {
        const origin = await ipc.bus.innerOrigin();
        const x = (probe.x - origin.x) / origin.scale;
        const y = (probe.y - origin.y) / origin.scale;
        const rect = bar.getBoundingClientRect();
        const hit = document.elementFromPoint(x, y);
        if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom && hit && bar.contains(hit)) {
          if (key) {
            if (x < rect.left + SCROLL_EDGE) bar.scrollLeft -= SCROLL_STEP;
            else if (x > rect.right - SCROLL_EDGE) bar.scrollLeft += SCROLL_STEP;
          }
          const nodes = [...bar.querySelectorAll<HTMLElement>('[data-tab-id]')];
          const index = nodes.filter((node) => {
            const bounds = node.getBoundingClientRect();
            return x > bounds.left + bounds.width / 2;
          }).length;
          reply.placement = { index, beforeId: nodes[index]?.dataset.tabId };
          if (key && previewKey === key && generation === current && !isCommandExecutionBlocked()) {
            marker = document.createElement('div');
            marker.className = 'tab-drop-insertion';
            marker.setAttribute('aria-hidden', 'true');
            const edge = nodes[index]?.getBoundingClientRect().left ?? nodes.at(-1)?.getBoundingClientRect().right ?? rect.left + 6;
            marker.style.left = `${Math.max(rect.left + 2, Math.min(edge, rect.right - 2))}px`;
            marker.style.top = `${rect.top + 2}px`;
            marker.style.height = `${Math.max(0, rect.height - 4)}px`;
            document.body.append(marker);
            markerTimer = setTimeout(clear, 700);
          }
        }
      }
      // 取客户区位置期间也可能进入退出确认，必须再次检查。
      if (isCommandExecutionBlocked() || document.body.inert) { reply.blocked = true; delete reply.placement; }
      await ipc.bus.send(probe.source, 'tab-drop-reply', reply);
    })().catch((error: unknown) => console.warn('tab drop probe failed', error));
  }).catch((error: unknown) => console.warn('tab drop listener failed', error));
  void installDropReplies().catch((error: unknown) => console.warn('tab drop reply listener failed', error));
}

interface Drag {
  id: string;
  pointer: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  originalOrder: string[];
  preview?: HTMLElement;
  session: string;
  hoverTarget?: string;
  hoverAt: number;
  hoverPending: boolean;
}

export function bindTabDragging(bar: HTMLElement): void {
  bindDropTarget(bar);
  let drag: Drag | undefined;
  let suppressClick = false;
  let frame = 0;
  const tabNodes = () => [...bar.querySelectorAll<HTMLElement>('[data-tab-id]')];
  const tabNode = (id: string) => tabNodes().find((node) => node.dataset.tabId === id);
  const clearForeignPreview = (state: Drag) => {
    if (state.hoverTarget) void ipc.bus.send(state.hoverTarget, 'tab-drop-clear', { source: ipc.bus.label, session: state.session }).catch(() => {});
    state.hoverTarget = undefined;
  };
  const screenPoint = async (x: number, y: number): Promise<ScreenPoint> => {
    const origin = await ipc.bus.innerOrigin();
    return { x: Math.round(origin.x + x * origin.scale), y: Math.round(origin.y + y * origin.scale) };
  };
  const hover = (state: Drag) => {
    if (state.hoverPending || !listTabs().some((tab) => tab.id === state.id) || Date.now() - state.hoverAt < HOVER_INTERVAL_MS) return;
    state.hoverAt = Date.now(); state.hoverPending = true;
    void (async () => {
      const point = await screenPoint(state.x, state.y);
      const target = await ipc.windowDropTarget(point);
      if (drag !== state || !state.active) return;
      if (state.hoverTarget && state.hoverTarget !== target) clearForeignPreview(state);
      if (!target || target === ipc.bus.label) return;
      state.hoverTarget = target;
      await requestPlacement(target, point, state.session);
    })().catch((error: unknown) => console.warn('tab hover failed', error)).finally(() => { state.hoverPending = false; });
  };

  const reorder = () => {
    if (!drag?.active) return;
    const rect = bar.getBoundingClientRect();
    if (drag.y < rect.top || drag.y > rect.bottom) return;
    const others = tabNodes().filter((node) => node.dataset.tabId !== drag?.id);
    const index = others.filter((node) => {
      const bounds = node.getBoundingClientRect();
      return drag!.x > bounds.left + bounds.width / 2;
    }).length;
    void executeCommand('tab.reorder', { id: drag.id, index });
    tabNode(drag.id)?.classList.add('dragging');
  };
  const scroll = () => {
    if (!drag?.active) return;
    const rect = bar.getBoundingClientRect();
    if (drag.y >= rect.top && drag.y <= rect.bottom) {
      if (drag.x < rect.left + SCROLL_EDGE) bar.scrollLeft -= SCROLL_STEP;
      else if (drag.x > rect.right - SCROLL_EDGE) bar.scrollLeft += SCROLL_STEP;
      reorder();
    }
    hover(drag);
    frame = requestAnimationFrame(scroll);
  };
  const end = (event?: PointerEvent, cancelled = false) => {
    const done = drag;
    if (!done || (event && event.pointerId !== done.pointer)) return;
    drag = undefined;
    cancelAnimationFrame(frame);
    done.preview?.remove();
    clearForeignPreview(done);
    document.body.classList.remove('tab-dragging');
    tabNode(done.id)?.classList.remove('dragging');
    if (bar.hasPointerCapture(done.pointer)) bar.releasePointerCapture(done.pointer);
    if (!done.active) {
      // capture 的 pointerup/click 目标是 bar；普通单击仍激活 pointerdown 的标签。
      if (event && !cancelled) void executeCommand('tab.activate', done.id);
      return;
    }
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (cancelled) {
      done.originalOrder.forEach((id, index) => { void executeCommand('tab.reorder', { id, index }); });
      return;
    }
    event?.preventDefault();
    const outside = event && (event.clientX < 0 || event.clientY < 0
      || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight);
    if (event && listTabs().some((tab) => tab.id === done.id)) {
      // 移出的文件先激活，确保命令上下文与拖动目标一致；特殊标签页仅参与排序。
      void screenPoint(event.clientX, event.clientY).then((point) => dropTabAtScreenPoint(done.id, point, {
        x: event.screenX - 80, y: event.screenY - 16,
      }, !!outside)).catch((error: unknown) => console.error('tab detach failed', error));
    }
  };

  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || drag || isCommandExecutionBlocked()) return;
    const target = event.target instanceof Element ? event.target : undefined;
    if (target?.closest('button')) return;
    const tab = target?.closest<HTMLElement>('[data-tab-id]');
    const id = tab?.dataset.tabId;
    if (!id || isTransferring(id)) return;
    drag = {
      id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, active: false, originalOrder: allTabIds(),
      session: `${ipc.bus.label}/${++sequence}`, hoverAt: 0, hoverPending: false,
    };
    bar.setPointerCapture(event.pointerId);
  });
  bar.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= START_DISTANCE) {
      drag.active = true;
      const source = tabNode(drag.id);
      if (source) {
        drag.preview = source.cloneNode(true) as HTMLElement;
        drag.preview.classList.add('tab-drag-preview');
        drag.preview.setAttribute('aria-hidden', 'true');
        drag.preview.removeAttribute('role');
        drag.preview.removeAttribute('data-tab-id');
        drag.preview.style.width = `${source.getBoundingClientRect().width}px`;
        document.body.append(drag.preview);
      }
      document.body.classList.add('tab-dragging');
      frame = requestAnimationFrame(scroll);
    }
    if (drag.active) {
      event.preventDefault();
      if (drag.preview) {
        drag.preview.style.left = `${drag.x + 10}px`;
        drag.preview.style.top = `${drag.y + 10}px`;
      }
      reorder();
      hover(drag);
    }
  });
  bar.addEventListener('pointerup', (event) => end(event));
  bar.addEventListener('pointercancel', (event) => end(event, true));
  bar.addEventListener('lostpointercapture', () => end(undefined, true));
  bar.addEventListener('click', (event) => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drag?.active) { event.preventDefault(); end(undefined, true); }
  }, true);
  window.addEventListener('blur', () => end(undefined, true));
  events.on('commands.executionChanged', ({ blocked }) => { if (blocked) end(undefined, true); });
  // 聚焦标签时 Ctrl+Shift+左右键重排，使用与指针同一个命令。
  bar.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const tab = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tab-id]') : undefined;
    const id = tab?.dataset.tabId;
    if (!id) return;
    event.preventDefault();
    const index = allTabIds().indexOf(id) + (event.key === 'ArrowLeft' ? -1 : 1);
    void executeCommand('tab.reorder', { id, index }).then(() => tabNode(id)?.focus());
  });
}
