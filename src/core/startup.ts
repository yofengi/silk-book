// The native window starts hidden. Paint has a bounded opportunity; hidden WebViews may skip RAF.
import { ipc, errorMessage } from '../ipc';
import { productName, t } from '../i18n';

export function paintOpportunity(): Promise<void> {
  return new Promise((resolve) => {
    let frame: number | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (frame !== undefined) cancelAnimationFrame(frame);
      resolve();
    };
    const timeout = setTimeout(finish, 64);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
  });
}

/** Call only after theme, UI, and all close/quit/incoming-file subscriptions are ready. */
export async function revealStartupWindow(): Promise<void> {
  document.getElementById('app')?.getBoundingClientRect();
  performance.mark('startup:ui-ready');
  await paintOpportunity();
  await ipc.windowReady();
  document.documentElement.dataset.startup = 'ready';
  performance.mark('startup:window-shown');
}

/** Also used when main's dynamic import fails, before its CSS or UI is available. */
export async function failStartup(error: unknown): Promise<void> {
  console.error('startup failed', error);
  document.documentElement.dataset.startup = 'failed';
  document.documentElement.style.setProperty('background', '#202020', 'important');
  document.body.style.cssText = 'margin:0;padding:40px;box-sizing:border-box;min-height:100vh;background:#202020;color:#fff;font:16px system-ui';
  const panel = document.createElement('section');
  const title = document.createElement('h1');
  title.textContent = t('window.startupFailed', { name: productName() });
  const detail = document.createElement('pre');
  detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
  detail.textContent = errorMessage(error);
  const hint = document.createElement('p');
  hint.textContent = t('window.startupFailedHint');
  const close = document.createElement('button');
  close.textContent = t('common.close');
  close.addEventListener('click', () => { void ipc.window.close(); });
  panel.append(title, detail, hint, close);
  document.body.replaceChildren(panel);
  await paintOpportunity();
  await ipc.windowStartupFailed(`${title.textContent}\n${detail.textContent}`).catch((failure: unknown) => {
    // A native watchdog covers a broken IPC or an error before this bootstrap module loaded.
    console.error('could not report startup failure', failure);
  });
}
