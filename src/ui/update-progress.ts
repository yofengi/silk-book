import type { UpdateTransferState } from '../ipc';
import { t } from '../i18n';
import { updateProgressText, updateTransferPercent } from './update-text';

/** 两个入口共享进度格式；更新不替换 DOM，未知总大小保留原生不定进度。 */
export function createUpdateProgress(): { el: HTMLElement; render(transfer: UpdateTransferState | null): void } {
  const el = document.createElement('div');
  el.className = 'update-progress';
  const bar = document.createElement('progress');
  bar.max = 100;
  const text = document.createElement('span');
  text.className = 'update-progress-text';
  el.append(bar, text);
  return { el, render(transfer) {
    el.hidden = !transfer || !['downloading', 'verifying'].includes(transfer.phase);
    if (!transfer || el.hidden) return;
    const percent = transfer.phase === 'verifying' ? null : updateTransferPercent(transfer);
    if (percent === null) bar.removeAttribute('value');
    else bar.setAttribute('value', String(percent));
    const label = updateProgressText(transfer);
    bar.setAttribute('aria-label', t('updates.progress'));
    bar.setAttribute('aria-valuetext', label);
    if (text.textContent !== label) text.textContent = label;
  } };
}
