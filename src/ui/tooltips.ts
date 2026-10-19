import './tooltips.css';
import { motionEnter, motionRemove } from './motion';

let disposeCurrent: (() => void) | undefined;

export function initTooltips(): () => void {
  if (disposeCurrent) return disposeCurrent;
  let hovered: HTMLElement | null = null;
  let focused: HTMLElement | null = null;
  let dismissed: HTMLElement | null = null;
  let owner: HTMLElement | null = null;
  let title = '';
  let bubble: HTMLElement | null = null;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let checking: ReturnType<typeof setTimeout> | undefined;
  let finishExit: (() => void) | undefined;
  let observer: MutationObserver | undefined;
  let disposed = false;

  const hideBubble = (immediate = false) => {
    clearTimeout(pending);
    finishExit?.();
    finishExit = undefined;
    if (bubble) {
      const previous = bubble;
      bubble = null;
      finishExit = motionRemove(previous, 'fade');
      if (immediate) { finishExit(); finishExit = undefined; }
    }
  };
  const clear = (immediate = false) => {
    clearTimeout(checking);
    observer?.disconnect();
    observer = undefined;
    if (owner) {
      title = owner.getAttribute('title') ?? title;
      owner.setAttribute('title', title);
      owner = null;
    }
    hideBubble(immediate);
  };
  const dismiss = () => {
    dismissed = owner ?? hovered ?? focused;
    hideBubble();
    if (owner) {
      title = owner.getAttribute('title') ?? title;
      owner.removeAttribute('title');
      clearTimeout(checking);
      check();
    }
  };
  const target = (node: EventTarget | null): HTMLElement | null => {
    if (!(node instanceof Element)) return null;
    const candidate = node.closest<HTMLElement>('[title]') ?? (owner?.contains(node) ? owner : null);
    return candidate?.closest('.titlebar, .statusbar') && candidate.getAttribute('title') !== '' ? candidate : null;
  };
  const position = () => {
    if (!owner || !bubble) return;
    const bounds = owner.getBoundingClientRect();
    const width = bubble.offsetWidth, height = bubble.offsetHeight;
    bubble.style.left = `${Math.max(8, Math.min(bounds.left + (bounds.width - width) / 2, window.innerWidth - width - 8))}px`;
    const below = bounds.bottom + 8;
    bubble.style.top = `${Math.max(8, Math.min(below + height <= window.innerHeight - 8 ? below : bounds.top - height - 8, window.innerHeight - height - 8))}px`;
  };
  const check = () => {
    if (!owner?.isConnected || owner.hidden) { clear(true); return; }
    checking = setTimeout(check, 200);
  };
  const refresh = () => {
    const next = hovered ?? focused;
    if (!next) dismissed = null;
    if (next === owner) return;
    clear(!!next);
    if (!next || next === dismissed || !next.isConnected) return;
    dismissed = null;
    title = next.getAttribute('title') ?? '';
    if (!title) return;
    owner = next;
    owner.removeAttribute('title');
    observer = new MutationObserver(() => {
      if (!owner?.hasAttribute('title')) return;
      title = owner.getAttribute('title') ?? '';
      owner.removeAttribute('title');
      if (!title) { clear(true); return; }
      if (bubble) { bubble.textContent = title; position(); }
    });
    observer.observe(owner, { attributes: true, attributeFilter: ['title'] });
    pending = setTimeout(() => {
      if (!owner?.isConnected || owner.hidden) { clear(true); return; }
      finishExit?.();
      finishExit = undefined;
      bubble = document.createElement('div');
      bubble.className = 'ui-tooltip';
      bubble.textContent = title;
      bubble.setAttribute('aria-hidden', 'true');
      document.body.append(bubble);
      position();
      motionEnter(bubble, 'fade');
      check();
    }, 450);
  };
  const listeners: (() => void)[] = [];
  const listen = (host: Document | Window, type: string, listener: EventListener, capture = false) => {
    host.addEventListener(type, listener, capture);
    listeners.push(() => host.removeEventListener(type, listener, capture));
  };
  listen(document, 'pointerover', event => {
    if ((event as PointerEvent).pointerType === 'touch') return;
    hovered = target(event.target);
    refresh();
  });
  listen(document, 'pointerout', event => {
    hovered = target((event as PointerEvent).relatedTarget);
    refresh();
  });
  listen(document, 'focusin', event => { focused = target(event.target); refresh(); });
  listen(document, 'focusout', event => { focused = target((event as FocusEvent).relatedTarget); refresh(); });
  listen(document, 'keydown', event => { if ((event as KeyboardEvent).key === 'Escape') dismiss(); });
  listen(document, 'pointerdown', dismiss, true);
  listen(document, 'scroll', dismiss, true);
  listen(window, 'resize', dismiss);
  listen(window, 'blur', dismiss);
  listen(document, 'visibilitychange', dismiss);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clear(true);
    for (const remove of listeners) remove();
    disposeCurrent = undefined;
  };
  disposeCurrent = dispose;
  return dispose;
}
