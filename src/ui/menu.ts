// 主菜单：标题栏左上角的图标按钮 + 下拉菜单（玻璃浮层，与命令面板一致）。
// 菜单项只引用命令 id；快捷键文字从 keybinding 注册表读取（用户覆盖后自动更新）。
import { executeCommand, isEnabled, registerCommand } from '../core/commands';
import { events } from '../core/events';
import { formatKey, keybindingFor, registerKeybinding } from '../core/keybindings';
import { getSetting } from '../core/settings';
import { t } from '../i18n';

type Entry =
  | { kind: 'cmd'; label: string; command: string; args?: unknown; shortcutOf?: string }
  | { kind: 'sub'; label: string; build: () => Entry[] }
  | { kind: 'sep' }
  | { kind: 'note'; label: string };

const ICON_MENU = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';
const ICON_CHEVRON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5l-3.5 3.5" stroke="currentColor" stroke-width="1" fill="none"/></svg>';

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

function recentEntries(): Entry[] {
  const list = getSetting('files.recent');
  const items: Entry[] = list.length
    ? list.map((p) => ({ kind: 'cmd', label: baseName(p), command: 'file.open', args: p, shortcutOf: '' }) as Entry)
    : [{ kind: 'note', label: t('menu.recent.empty') }];
  return [...items, { kind: 'sep' }, { kind: 'cmd', label: t('menu.recent.clear'), command: 'file.clearRecent' }];
}

// 每次打开菜单都重新构建，文案随当前界面语言解析
function mainEntries(): Entry[] {
  return [
    { kind: 'cmd', label: t('menu.file.new'), command: 'file.new' },
    { kind: 'cmd', label: t('menu.file.open'), command: 'file.open' },
    { kind: 'sub', label: t('menu.file.recent'), build: recentEntries },
    { kind: 'cmd', label: t('menu.file.save'), command: 'file.save' },
    { kind: 'cmd', label: t('menu.file.saveAs'), command: 'file.saveAs' },
    { kind: 'sep' },
    { kind: 'cmd', label: t('menu.settings'), command: 'settings.open' },
    { kind: 'sep' },
    { kind: 'cmd', label: t('menu.quit'), command: 'app.quit' },
  ];
}

let button: HTMLButtonElement | null = null;
let root: HTMLElement | null = null; // 当前打开的主菜单
let sub: HTMLElement | null = null; // 当前打开的子菜单
let subOwner: HTMLElement | null = null;
let returnFocus: HTMLElement | null = null;

const items = (m: HTMLElement) => [...m.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([aria-disabled="true"])')];

function focusItem(m: HTMLElement, idx: number): void {
  const list = items(m);
  if (!list.length) return;
  const i = (idx + list.length) % list.length;
  for (const it of list) it.tabIndex = -1;
  list[i].tabIndex = 0;
  list[i].focus();
}

function move(m: HTMLElement, delta: number): void {
  const list = items(m);
  const cur = list.indexOf(document.activeElement as HTMLElement);
  focusItem(m, cur < 0 ? (delta > 0 ? 0 : list.length - 1) : cur + delta);
}

function buildMenu(entries: Entry[], label: string): HTMLElement {
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', label);
  for (const e of entries) {
    if (e.kind === 'sep') {
      const s = document.createElement('div');
      s.className = 'menu-sep';
      s.setAttribute('role', 'separator');
      m.append(s);
      continue;
    }
    const it = document.createElement('div');
    it.className = 'menu-item';
    it.tabIndex = -1;
    const text = document.createElement('span');
    text.className = 'menu-label';
    text.textContent = e.label;
    const right = document.createElement('span');
    right.className = 'menu-key';
    it.append(text, right);
    if (e.kind === 'note') {
      it.classList.add('menu-note');
      it.setAttribute('role', 'presentation');
      m.append(it);
      continue;
    }
    it.setAttribute('role', 'menuitem');
    if (e.kind === 'sub') {
      it.setAttribute('aria-haspopup', 'menu');
      it.setAttribute('aria-expanded', 'false');
      right.innerHTML = ICON_CHEVRON;
      const shortcut = keybindingFor('file.openRecent');
      if (shortcut) {
        const k = document.createElement('span');
        k.textContent = formatKey(shortcut);
        right.prepend(k);
      }
      it.addEventListener('click', () => openSub(it, e.build, false));
      it.addEventListener('pointerenter', () => openSub(it, e.build, false));
    } else {
      if (e.args !== undefined) it.title = String(e.args);
      const kb = e.shortcutOf === '' ? undefined : keybindingFor(e.shortcutOf ?? e.command);
      if (kb) right.textContent = formatKey(kb);
      if (!isEnabled(e.command)) it.setAttribute('aria-disabled', 'true');
      it.addEventListener('click', () => activate(e));
      it.addEventListener('pointerenter', () => { if (m === root) closeSub(); });
    }
    it.addEventListener('pointermove', () => { if (it.getAttribute('aria-disabled') !== 'true' && document.activeElement !== it) it.focus(); });
    m.append(it);
  }
  m.addEventListener('keydown', (ev) => onKey(ev, m));
  return m;
}

function activate(e: Extract<Entry, { kind: 'cmd' }>): void {
  if (!isEnabled(e.command)) return;
  closeMenu(false);
  void executeCommand(e.command, e.args);
}

function openSub(owner: HTMLElement, build: () => Entry[], focusFirst: boolean): void {
  if (subOwner === owner && sub) { if (focusFirst) focusItem(sub, 0); return; }
  closeSub();
  sub = buildMenu(build(), owner.textContent ?? '');
  sub.classList.add('menu-sub');
  document.body.append(sub);
  const r = owner.getBoundingClientRect();
  const w = sub.offsetWidth;
  const left = r.right + 2 + w > window.innerWidth ? r.left - w - 2 : r.right + 2;
  sub.style.left = `${Math.max(4, left)}px`;
  sub.style.top = `${Math.max(4, Math.min(r.top - 5, window.innerHeight - sub.offsetHeight - 4))}px`;
  subOwner = owner;
  owner.setAttribute('aria-expanded', 'true');
  owner.classList.add('open');
  if (focusFirst) focusItem(sub, 0);
}

function closeSub(): void {
  sub?.remove();
  sub = null;
  subOwner?.setAttribute('aria-expanded', 'false');
  subOwner?.classList.remove('open');
  subOwner = null;
}

function onKey(ev: KeyboardEvent, m: HTMLElement): void {
  const t = document.activeElement as HTMLElement | null;
  switch (ev.key) {
    case 'ArrowDown': move(m, 1); break;
    case 'ArrowUp': move(m, -1); break;
    case 'Home': focusItem(m, 0); break;
    case 'End': focusItem(m, -1); break;
    case 'ArrowRight':
      if (t?.getAttribute('aria-haspopup') === 'menu') {
        t.click();
        if (sub) focusItem(sub, 0);
      }
      break;
    case 'ArrowLeft':
      if (m === sub && subOwner) { const o = subOwner; closeSub(); o.focus(); }
      break;
    case 'Enter':
    case ' ':
      if (t && m.contains(t)) {
        if (t.getAttribute('aria-haspopup') === 'menu') { t.click(); if (sub) focusItem(sub, 0); } else t.click();
      }
      break;
    case 'Escape':
      if (m === sub && subOwner) { const o = subOwner; closeSub(); o.focus(); } else closeMenu(true);
      break;
    case 'Tab': closeMenu(true); break;
    default: return;
  }
  ev.preventDefault();
  ev.stopPropagation();
}

function onOutside(e: PointerEvent): void {
  const n = e.target as Node;
  if (root?.contains(n) || sub?.contains(n) || button?.contains(n)) return;
  closeMenu(false);
}

export function isMenuOpen(): boolean {
  return !!root;
}

export function openMenu(): void {
  if (!button) return;
  if (root) { closeMenu(true); return; }
  returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : null;
  root = buildMenu(mainEntries(), t('menu.main'));
  document.body.append(root);
  const r = button.getBoundingClientRect();
  root.style.left = `${Math.max(4, r.left)}px`;
  root.style.top = `${r.bottom + 2}px`;
  button.setAttribute('aria-expanded', 'true');
  button.classList.add('open');
  focusItem(root, 0);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
}

const onBlur = () => closeMenu(false);

export function closeMenu(restoreFocus: boolean): void {
  if (!root) return;
  closeSub();
  root.remove();
  root = null;
  button?.setAttribute('aria-expanded', 'false');
  button?.classList.remove('open');
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('blur', onBlur);
  window.removeEventListener('resize', onBlur);
  if (restoreFocus) (returnFocus ?? button)?.focus();
  returnFocus = null;
}

/** 创建菜单按钮（不设 data-tauri-drag-region，避免被当作拖拽区） */
export function createMenuButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tb-menu';
  b.innerHTML = ICON_MENU;
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  const syncTitle = () => {
    const k = keybindingFor('menu.open');
    b.setAttribute('aria-label', t('menu.label'));
    b.title = k ? t('menu.labelWithKey', { key: formatKey(k) }) : t('menu.label');
  };
  syncTitle();
  events.on('keybindings.changed', syncTitle);
  events.on('locale.changed', () => { syncTitle(); closeMenu(false); });
  b.addEventListener('click', () => void executeCommand('menu.open'));
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!root) void executeCommand('menu.open'); }
  });
  button = b;
  return b;
}

export function registerMenuCommands(): void {
  registerCommand({ id: 'menu.open', title: () => t('cmd.menu.open'), run: openMenu });
  registerKeybinding({ key: 'Alt', command: 'menu.open' });
  registerKeybinding({ key: 'Alt+F', command: 'menu.open' });
}
