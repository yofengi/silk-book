import './confirm-dialog.css';
import { events } from '../core/events';
import { productName, t } from '../i18n';
import type { ConfirmOptions } from '../ipc/types';

interface Request {
  message: string;
  title?: string;
  signal?: AbortSignal;
  resolve(answer: boolean): void;
  abort(): void;
  settled: boolean;
  returnFocus: HTMLElement | null;
}

interface Visible {
  request: Request;
  el: HTMLElement;
  native: HTMLDialogElement | null;
  heading: HTMLElement;
  message: HTMLElement;
  cancel: HTMLButtonElement;
  accept: HTMLButtonElement;
  cleanup(): void;
}

const queue: Request[] = [];
let active: Visible | null = null;
let sequence = 0;
let keyboardInstalled = false;

function focusables(visible: Visible): HTMLElement[] {
  return visible.message.tabIndex === 0 ? [visible.message, visible.cancel, visible.accept] : [visible.cancel, visible.accept];
}

/** Installed through IPC imports before the application's capturing keybindings.
 * Keep the singleton guard so later confirmations preserve this ordering. */
function installInputGuard(): void {
  if (keyboardInstalled || typeof window === 'undefined') return;
  keyboardInstalled = true;
  window.addEventListener('keydown', (event) => {
    const visible = active;
    if (!visible) return;
    // Browser defaults (selection copy, Space and IME) remain available inside
    // the dialog; application/editor listeners never receive these keystrokes.
    event.stopImmediatePropagation();
    if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(visible.request, false);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const choices = focusables(visible);
      const index = choices.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? choices.indexOf(visible.cancel) : (index + (event.shiftKey ? -1 : 1) + choices.length) % choices.length;
      choices[next].focus();
    } else if (event.key === 'Enter') {
      // No form submit or implicit default action can select acceptance.
      event.preventDefault();
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const focused = document.activeElement;
      if (focused === visible.cancel) finish(visible.request, false);
      else if (focused === visible.accept) finish(visible.request, true);
    } else if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && ['r', 'p'].includes(event.key.toLowerCase()))) {
      event.preventDefault();
    }
  }, true);
  window.addEventListener('keyup', (event) => {
    if (active) event.stopImmediatePropagation();
  }, true);
  window.addEventListener('focusin', (event) => {
    const visible = active;
    if (visible && !visible.el.contains(event.target as Node)) visible.cancel.focus();
  }, true);
  window.addEventListener('beforeinput', (event) => {
    const visible = active;
    if (visible && !visible.el.contains(event.target as Node)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  for (const type of ['pointerdown', 'click'] as const) window.addEventListener(type, (event) => {
    const visible = active;
    if (visible && !visible.el.contains(event.target as Node)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}

installInputGuard();

function labels(visible: Visible): void {
  visible.heading.textContent = visible.request.title ?? `${productName()} · ${t('common.confirmTitle')}`;
  visible.cancel.textContent = t('common.cancel');
  visible.accept.textContent = t('common.confirm');
}

events.on('locale.changed', () => { if (active) labels(active); });

function finish(request: Request, answer: boolean): void {
  if (request.settled) return;
  request.settled = true;
  request.signal?.removeEventListener('abort', request.abort);
  const index = queue.indexOf(request);
  if (index >= 0) queue.splice(index, 1);
  const wasVisible = active?.request === request;
  if (wasVisible) {
    const visible = active!;
    active = null;
    visible.cleanup();
  }
  request.resolve(answer);
  if (wasVisible) {
    queueMicrotask(pump);
    // Let lifecycle consumers release body.inert before restoring focus.
    setTimeout(() => {
      if (!active && !document.body.inert && request.returnFocus?.isConnected
        && (!document.activeElement || document.activeElement === document.body || document.activeElement === document.documentElement)) {
        request.returnFocus.focus({ preventScroll: true });
      }
    }, 0);
  }
}

function content(el: HTMLElement, request: Request, native: HTMLDialogElement | null): Visible {
  const id = `confirm-${++sequence}`;
  el.className = 'confirm-dialog';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', `${id}-title`);
  el.setAttribute('aria-describedby', `${id}-message`);
  const heading = document.createElement('h2');
  heading.className = 'confirm-dialog-title';
  heading.id = `${id}-title`;
  const message = document.createElement('p');
  message.className = 'confirm-dialog-message';
  message.id = `${id}-message`;
  message.textContent = request.message;
  message.tabIndex = -1;
  const actions = document.createElement('div');
  actions.className = 'confirm-dialog-actions';
  const cancel = document.createElement('button');
  cancel.className = 'confirm-dialog-cancel';
  cancel.type = 'button';
  cancel.autofocus = true;
  const accept = document.createElement('button');
  accept.className = 'confirm-dialog-accept';
  accept.type = 'button';
  actions.append(cancel, accept);
  el.append(heading, message, actions);
  const reject = () => finish(request, false);
  const approve = () => finish(request, true);
  const onCancel = (event: Event) => { event.preventDefault(); reject(); };
  const outside = (event: MouseEvent) => {
    if (event.target !== el) return;
    const rect = el.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.preventDefault();
  };
  cancel.addEventListener('click', reject);
  accept.addEventListener('click', approve);
  el.addEventListener('cancel', onCancel);
  el.addEventListener('close', reject);
  el.addEventListener('pointerdown', outside);
  el.addEventListener('click', outside);
  const visible: Visible = { request, el, native, heading, message, cancel, accept, cleanup() {
    cancel.removeEventListener('click', reject);
    accept.removeEventListener('click', approve);
    el.removeEventListener('cancel', onCancel);
    el.removeEventListener('close', reject);
    el.removeEventListener('pointerdown', outside);
    el.removeEventListener('click', outside);
    if (native?.open) native.close();
    el.remove();
  } };
  labels(visible);
  return visible;
}

function showFallback(request: Request): void {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-dialog-overlay';
  const visible = content(document.createElement('div'), request, null);
  overlay.append(visible.el);
  // Older WKWebView lacks showModal/inert. Sibling placement also avoids an
  // explicit body.inert inherited from an ongoing close/install lifecycle.
  // Leave inert ownership to that lifecycle: our overlay and input guards
  // isolate the background without restoring another operation's state.
  document.documentElement.append(overlay);
  const cleanup = visible.cleanup;
  visible.cleanup = () => {
    cleanup();
    overlay.remove();
  };
  active = visible;
  visible.message.tabIndex = visible.message.scrollHeight > visible.message.clientHeight ? 0 : -1;
  visible.cancel.focus();
}

function pump(): void {
  if (active) return;
  const request = queue.shift();
  if (!request) return;
  if (request.signal?.aborted) { finish(request, false); queueMicrotask(pump); return; }
  const dialog = document.createElement('dialog');
  if (typeof dialog.showModal !== 'function') { showFallback(request); return; }
  const visible = content(dialog, request, dialog);
  document.body.append(dialog);
  active = visible;
  try {
    dialog.showModal();
    visible.message.tabIndex = visible.message.scrollHeight > visible.message.clientHeight ? 0 : -1;
    visible.cancel.focus();
  } catch {
    active = null;
    visible.cleanup();
    showFallback(request);
  }
}

export function confirmDialog(message: string, title?: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (options.signal?.aborted || typeof document === 'undefined' || !document.body) return Promise.resolve(false);
  installInputGuard();
  return new Promise((resolve) => {
    const request: Request = {
      message, title, signal: options.signal, resolve, settled: false,
      returnFocus: active?.request.returnFocus ?? document.activeElement as HTMLElement | null,
      abort() { finish(request, false); },
    };
    request.signal?.addEventListener('abort', request.abort, { once: true });
    queue.push(request);
    pump();
  });
}
