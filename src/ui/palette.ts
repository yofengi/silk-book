// 命令面板 / 通用快速选择器
import { commandTitle, executeCommand, isCommandExecutionBlocked, isEnabled, listCommands } from '../core/commands';
import { events } from '../core/events';
import { keybindingFor } from '../core/keybindings';
import { getSetting } from '../core/settings';
import { t } from '../i18n';

export interface PickItem {
  label: string;
  value: string;
  detail?: string;
}

let overlay: HTMLElement | null = null;

function close(): void {
  overlay?.remove();
  overlay = null;
}

// 列表项与占位符在打开时已按旧语言生成：切换语言时直接关闭，再次打开即为新语言
events.on('locale.changed', close);
events.on('commands.executionChanged', ({ blocked }) => { if (blocked) close(); });

export function openPicker(items: PickItem[], onPick: (value: string) => void, placeholder = ''): void {
  if (isCommandExecutionBlocked()) return;
  close();
  const prevFocus = document.activeElement as HTMLElement | null;
  overlay = document.createElement('div');
  overlay.className = 'palette-overlay';
  const box = document.createElement('div');
  box.className = 'palette';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', placeholder || t('palette.label'));
  const input = document.createElement('input');
  input.className = 'palette-input';
  input.placeholder = placeholder;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'palette-list');
  const list = document.createElement('ul');
  list.className = 'palette-list';
  list.id = 'palette-list';
  list.setAttribute('role', 'listbox');
  box.append(input, list);
  overlay.append(box);
  document.body.append(overlay);

  let filtered = items;
  let sel = 0;
  const render = () => {
    list.replaceChildren();
    filtered.forEach((it, i) => {
      const li = document.createElement('li');
      li.id = `palette-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === sel));
      li.className = i === sel ? 'selected' : '';
      const l = document.createElement('span');
      l.textContent = it.label;
      li.append(l);
      if (it.detail) {
        const d = document.createElement('span');
        d.className = 'detail';
        d.textContent = it.detail;
        li.append(d);
      }
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.append(li);
    });
    input.setAttribute('aria-activedescendant', filtered.length ? `palette-opt-${sel}` : '');
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i: number) => {
    if (isCommandExecutionBlocked()) return;
    const it = filtered[i];
    close();
    prevFocus?.focus();
    if (it) onPick(it.value);
  };
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    filtered = items.filter((it) => it.label.toLowerCase().includes(q) || it.value.toLowerCase().includes(q));
    sel = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') sel = Math.min(sel + 1, filtered.length - 1);
    else if (e.key === 'ArrowUp') sel = Math.max(sel - 1, 0);
    else if (e.key === 'Enter') return choose(sel);
    else if (e.key === 'Escape') { close(); prevFocus?.focus(); return; }
    else return;
    e.preventDefault();
    render();
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  render();
  input.focus();
}

export function openCommandPalette(): void {
  const items = listCommands()
    .filter((c) => c.id !== 'palette.open' && isEnabled(c.id))
    .map((c) => ({ label: commandTitle(c), value: c.id, detail: keybindingFor(c.id) }));
  openPicker(items, (id) => void executeCommand(id), t('palette.placeholder'));
}

export function openRecentPicker(): void {
  const items = getSetting('files.recent').map((p) => ({ label: p.split(/[\\/]/).pop() ?? p, value: p, detail: p }));
  openPicker(items, (p) => void executeCommand('file.open', p), items.length ? t('palette.recentPlaceholder') : t('palette.recentEmpty'));
}
