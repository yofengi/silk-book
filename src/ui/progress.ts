// 可复用进度条（带取消），供 M3 大文件读取使用
import { t } from '../i18n';

export interface ProgressHandle {
  update(done: number, total: number): void;
  setLabel(text: string): void;
  close(): void;
}

export function showProgress(parent: HTMLElement, label: string, onCancel?: () => void): ProgressHandle {
  const root = document.createElement('div');
  root.className = 'progress';
  const text = document.createElement('span');
  text.className = 'progress-label';
  text.textContent = label;
  const bar = document.createElement('div');
  bar.className = 'progress-track';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-label', label);
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  bar.append(fill);
  const pct = document.createElement('span');
  pct.className = 'progress-pct';
  root.append(text, bar, pct);
  if (onCancel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t('common.cancel');
    btn.addEventListener('click', () => { btn.disabled = true; onCancel(); });
    root.append(btn);
  }
  parent.append(root);
  return {
    update(done, total) {
      const p = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      fill.style.width = `${p}%`;
      bar.setAttribute('aria-valuenow', String(p));
      pct.textContent = `${p}%`;
    },
    setLabel(t) { text.textContent = t; },
    close() { root.remove(); },
  };
}
