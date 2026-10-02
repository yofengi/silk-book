// 状态栏：左侧完整路径（文件操作菜单），右侧 档位 / 编码 / 换行符 / 语言。
// 浮层菜单复用主菜单的 .menu 样式（玻璃）；悬停短延迟或点击打开，键盘可操作，Esc 关闭。菜单项只执行命令。
import { executeCommand, isEnabled } from '../core/commands';
import { events } from '../core/events';
import { getSetting } from '../core/settings';
import { encodingLabel, encodingName, loadEncodings, sameEncoding } from '../editor/encodings';
import { languageName } from '../editor/languages';
import { activeTab } from '../editor/tabs';
import { t } from '../i18n';
import type { EncodingInfo } from '../ipc';

const HOVER_OPEN_MS = 350;
const HOVER_CLOSE_MS = 300;

const ico = (d: string) => `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON = {
  reload: ico('M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5'),
  copy: ico('M5.5 5.5h7v8h-7zM3.5 10.5v-8h7'),
  folder: ico('M2 4.5h4l1.5 1.5H14v7H2z'),
  file: ico('M4 2h5l3 3v9H4zM9 2v3h3'),
  enc: ico('M3 12 6 4l3 8M4 9.5h4M10.5 7.5h3M10.5 10.5h3'),
  eol: ico('M13 3.5v4.5H4M6.5 5.5 4 8l2.5 2.5'),
  save: ico('M3 2.5h8l2.5 2.5v8.5h-11zM5 2.5v3.5h5v-3.5M5 13.5v-4h6v4'),
  warn: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.6v.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  check: ico('M3.5 8.5 6.5 11.5 12.5 4.5'),
  chevron: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5l-3.5 3.5" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
};

type Item =
  | { kind: 'cmd'; label: string; icon?: string; command: string; args?: unknown; checked?: boolean }
  | { kind: 'sub'; label: string; icon?: string; enabled?: boolean; build: () => Promise<Item[]> }
  | { kind: 'head'; label: string }
  | { kind: 'sep' };

interface Open {
  owner: HTMLElement; menu: HTMLElement; sub: HTMLElement | null; subOwner: HTMLElement | null;
  /** 点击 / 键盘打开：指针离开不自动关闭 */
  viaKeyboard: boolean;
  /** 打开前的焦点（通常是编辑器），关闭时归还 */
  returnFocus: HTMLElement | null;
}
let open: Open | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let subRequest = 0;

const focusables = (m: HTMLElement) => [...m.querySelectorAll<HTMLElement>(':scope > [role="menuitem"], :scope > [role="menuitemradio"]')]
  .filter((element) => element.getAttribute('aria-disabled') !== 'true');

function focusAt(m: HTMLElement, i: number): void {
  const list = focusables(m);
  if (!list.length) return;
  const k = (i + list.length) % list.length;
  for (const it of list) it.tabIndex = -1;
  list[k].tabIndex = 0;
  list[k].focus();
}

function build(items: Item[], label: string, isSub: boolean): HTMLElement {
  const m = document.createElement('div');
  m.className = `menu sb-menu${isSub ? ' menu-sub' : ''}`;
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', label);
  for (const e of items) {
    if (e.kind === 'sep') {
      const s = document.createElement('div');
      s.className = 'menu-sep';
      s.setAttribute('role', 'separator');
      m.append(s);
      continue;
    }
    if (e.kind === 'head') {
      const hd = document.createElement('div');
      hd.className = 'menu-head';
      hd.setAttribute('role', 'presentation');
      hd.textContent = e.label;
      m.append(hd);
      continue;
    }
    const it = document.createElement('div');
    it.className = 'menu-item';
    it.tabIndex = -1;
    const ic = document.createElement('span');
    ic.className = 'menu-icon';
    const lab = document.createElement('span');
    lab.className = 'menu-label';
    lab.textContent = e.label;
    const right = document.createElement('span');
    right.className = 'menu-key';
    it.append(ic, lab, right);
    if (e.kind === 'sub') {
      ic.innerHTML = e.icon ?? '';
      it.setAttribute('role', 'menuitem');
      it.setAttribute('aria-haspopup', 'menu');
      it.setAttribute('aria-expanded', 'false');
      if (e.enabled === false) it.setAttribute('aria-disabled', 'true');
      right.innerHTML = ICON.chevron;
      it.addEventListener('click', () => void openSub(it, e, false));
      it.addEventListener('pointerenter', () => void openSub(it, e, false));
      it.addEventListener('sb-open-sub', () => void openSub(it, e, true));
    } else {
      if (e.checked !== undefined) {
        it.setAttribute('role', 'menuitemradio');
        it.setAttribute('aria-checked', String(e.checked));
        ic.innerHTML = e.checked ? ICON.check : '';
      } else {
        it.setAttribute('role', 'menuitem');
        ic.innerHTML = e.icon ?? '';
      }
      if (!isEnabled(e.command)) it.setAttribute('aria-disabled', 'true');
      it.addEventListener('click', () => {
        if (!isEnabled(e.command)) return;
        closeAll(false);
        void executeCommand(e.command, e.args);
      });
      if (!isSub) it.addEventListener('pointerenter', closeSub);
    }
    it.addEventListener('pointermove', () => { if (it.getAttribute('aria-disabled') !== 'true' && document.activeElement !== it) it.focus(); });
    m.append(it);
  }
  m.addEventListener('keydown', (ev) => onKey(ev, m));
  m.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  m.addEventListener('pointerleave', scheduleClose);
  return m;
}

async function openSub(owner: HTMLElement, e: Extract<Item, { kind: 'sub' }>, focusFirst: boolean): Promise<void> {
  if (!open || e.enabled === false) return;
  if (open.subOwner === owner && open.sub) { if (focusFirst) focusAt(open.sub, 0); return; }
  closeSub();
  const request = ++subRequest;
  const cur = open;
  const items = await e.build();
  if (open !== cur || request !== subRequest || !owner.isConnected) return;
  closeSub();
  const sub = build(items, e.label, true);
  document.body.append(sub);
  const r = owner.getBoundingClientRect();
  // Use the outer menu edges: item padding otherwise makes adjacent glass
  // surfaces overlap and sample each other's tint instead of the editor.
  const parent = cur.menu.getBoundingClientRect();
  const w = sub.offsetWidth;
  const left = parent.right + 2 + w > window.innerWidth - 4 ? parent.left - w - 2 : parent.right + 2;
  sub.style.left = `${Math.max(4, left)}px`;
  sub.style.top = `${Math.max(4, Math.min(r.top - 5, window.innerHeight - sub.offsetHeight - 4))}px`;
  cur.sub = sub;
  cur.subOwner = owner;
  owner.setAttribute('aria-expanded', 'true');
  owner.classList.add('open');
  if (focusFirst) {
    const checked = focusables(sub).findIndex((x) => x.getAttribute('aria-checked') === 'true');
    focusAt(sub, Math.max(0, checked));
  }
}

function closeSub(): void {
  ++subRequest;
  if (!open) return;
  open.sub?.remove();
  open.sub = null;
  open.subOwner?.setAttribute('aria-expanded', 'false');
  open.subOwner?.classList.remove('open');
  open.subOwner = null;
}

function onKey(ev: KeyboardEvent, m: HTMLElement): void {
  // 悬停打开后开始用键盘操作：从此按键盘菜单规则保留焦点与浮层。
  if (open) open.viaKeyboard = true;
  clearTimeout(closeTimer);
  const cur = document.activeElement as HTMLElement | null;
  const list = focusables(m);
  const i = cur ? list.indexOf(cur) : -1;
  switch (ev.key) {
    case 'ArrowDown': focusAt(m, i + 1); break;
    case 'ArrowUp': focusAt(m, i < 0 ? -1 : i - 1); break;
    case 'Home': focusAt(m, 0); break;
    case 'End': focusAt(m, -1); break;
    case 'ArrowRight':
      if (cur?.getAttribute('aria-haspopup') === 'menu') cur.dispatchEvent(new CustomEvent('sb-open-sub'));
      break;
    case 'ArrowLeft':
      if (open && m === open.sub && open.subOwner) { const o = open.subOwner; closeSub(); o.focus(); }
      break;
    case 'Enter': case ' ':
      if (cur && m.contains(cur)) {
        if (cur.getAttribute('aria-haspopup') === 'menu') cur.dispatchEvent(new CustomEvent('sb-open-sub'));
        else cur.click();
      }
      break;
    case 'Escape':
      if (open && m === open.sub && open.subOwner) { const o = open.subOwner; closeSub(); o.focus(); } else closeAll(true);
      break;
    case 'Tab': closeAll(true); break;
    default: return;
  }
  ev.preventDefault();
  ev.stopPropagation();
}

function onOutside(e: PointerEvent): void {
  const n = e.target as Node;
  if (!open || open.menu.contains(n) || open.sub?.contains(n) || open.owner.contains(n)) return;
  closeAll(false);
}
const onBlur = () => closeAll(false);

function scheduleClose(): void {
  clearTimeout(closeTimer);
  // 键盘打开的菜单（焦点在菜单内）不因指针离开而关闭
  closeTimer = setTimeout(() => {
    if (!open) return;
    const a = document.activeElement;
    if (open.viaKeyboard && (open.menu.contains(a) || !!open.sub?.contains(a) || a === open.owner)) return;
    closeAll(false);
  }, HOVER_CLOSE_MS);
}

function closeAll(restoreFocus: boolean): void {
  clearTimeout(hoverTimer);
  clearTimeout(closeTimer);
  if (!open) return;
  const o = open;
  const a = document.activeElement;
  const focusInside = o.menu.contains(a) || !!o.sub?.contains(a);
  closeSub();
  o.menu.remove();
  o.owner.setAttribute('aria-expanded', 'false');
  o.owner.classList.remove('open');
  open = null;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('blur', onBlur);
  window.removeEventListener('resize', onBlur);
  // Esc：回到状态栏按钮；其余情况（执行命令 / 指针移走）焦点归还给打开前的元素（编辑器）
  if (restoreFocus) o.owner.focus();
  else if (focusInside) (o.returnFocus?.isConnected ? o.returnFocus : null)?.focus();
}

function openFor(owner: HTMLElement, items: Item[], label: string, viaKeyboard: boolean): void {
  if (open?.owner === owner) return;
  const prev = open?.returnFocus ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !owner.parentElement?.contains(document.activeElement) ? document.activeElement : null);
  closeAll(false);
  const menu = build(items, label, false);
  document.body.append(menu);
  const r = owner.getBoundingClientRect();
  const w = menu.offsetWidth;
  // Right-hand metadata menus align with their button's right edge. Keep them
  // over the editor rather than the minimap's flat background when it is shown.
  const rightAligned = !owner.classList.contains('sb-path');
  const minimap = rightAligned ? document.querySelector<HTMLElement>('.editor-host .cm-minimap-gutter')?.getBoundingClientRect() : undefined;
  const rightEdge = minimap && minimap.width > 0 ? Math.max(w + 8, Math.min(window.innerWidth, minimap.left)) : window.innerWidth;
  const left = Math.min(Math.max(4, rightAligned ? r.right - w : r.left), rightEdge - w - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(4, r.top - menu.offsetHeight - 4)}px`;
  owner.setAttribute('aria-expanded', 'true');
  owner.classList.add('open');
  open = { owner, menu, sub: null, subOwner: null, viaKeyboard, returnFocus: prev };
  if (viaKeyboard) focusAt(menu, 0);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
}

/** 编码列表分组：Unicode、ANSI（系统）、其他（可滚动） */
function encodingItems(list: EncodingInfo[], command: string, current: { encoding: string; hasBom: boolean } | null): Item[] {
  const groups: [string, EncodingInfo[]][] = [
    [t('statusbar.group.Unicode'), list.filter((e) => e.group === 'Unicode')],
    [t('statusbar.group.System'), list.filter((e) => e.group === 'System')],
    [t('statusbar.group.other'), list.filter((e) => e.group !== 'Unicode' && e.group !== 'System')],
  ];
  const out: Item[] = [];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    if (out.length) out.push({ kind: 'sep' });
    out.push({ kind: 'head', label });
    for (const e of items) {
      const checked = !!current && sameEncoding(e.id, current.encoding) && (e.group !== 'Unicode' || e.bom === current.hasBom);
      // ANSI 与设置页保持一致：“ANSI (GBK)”
      const label = e.group === 'System' ? encodingName(e.id) : e.label + (e.group === 'Unicode' && e.bom ? ' BOM' : '');
      out.push({ kind: 'cmd', label, command, args: e.id, checked });
    }
  }
  return out;
}

/** 路径中间省略：保留盘符/首段与文件名，按可用宽度截断中间 */
function fitPath(el: HTMLElement, full: string): void {
  el.textContent = full;
  if (el.scrollWidth <= el.clientWidth || el.clientWidth === 0) return;
  let lo = 1;
  let hi = full.length;
  let best = '…';
  while (lo <= hi) {
    const keep = (lo + hi) >> 1;
    const tail = Math.ceil(keep * 0.6);
    const s = `${full.slice(0, keep - tail)}…${full.slice(full.length - tail)}`;
    el.textContent = s;
    if (el.scrollWidth <= el.clientWidth) { best = s; lo = keep + 1; } else hi = keep - 1;
  }
  el.textContent = best;
}

function menuButton(cls: string, label: () => string, items: () => Item[]): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `sb-item sb-btn ${cls}`;
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.addEventListener('click', (e) => {
    clearTimeout(hoverTimer);
    // 悬停已打开：点击固定菜单（指针离开不再关闭）；再次点击关闭
    if (open?.owner === b) {
      if (!open.viaKeyboard && e.detail > 0) { open.viaKeyboard = true; return; }
      closeAll(e.detail === 0);
      return;
    }
    openFor(b, items(), label(), true);
  });
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); openFor(b, items(), label(), true); }
  });
  b.addEventListener('pointerenter', () => {
    clearTimeout(closeTimer);
    clearTimeout(hoverTimer);
    if (open?.owner === b) return;
    hoverTimer = setTimeout(() => openFor(b, items(), label(), false), open ? 0 : HOVER_OPEN_MS);
  });
  b.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); if (open?.owner === b) scheduleClose(); });
  return b;
}

export function mountStatusBar(): HTMLElement {
  const bar = document.createElement('footer');
  bar.className = 'statusbar';

  const pathBtn = menuButton('sb-path', () => t('statusbar.pathMenu'), () => [
    { kind: 'cmd', label: t('statusbar.reload'), icon: ICON.reload, command: 'file.reload' },
    { kind: 'cmd', label: t('statusbar.copyPath'), icon: ICON.copy, command: 'file.copyPath' },
    { kind: 'cmd', label: t('statusbar.revealInFolder'), icon: ICON.folder, command: 'file.revealInFolder' },
  ]);
  const pathText = document.createElement('span');
  pathText.className = 'sb-path-text';
  pathBtn.innerHTML = ICON.file;
  pathBtn.append(pathText);

  const tier = document.createElement('span');
  tier.className = 'sb-item';
  const warn = document.createElement('span');
  warn.className = 'sb-item sb-warn';
  warn.innerHTML = ICON.warn;
  warn.setAttribute('role', 'img');
  warn.tabIndex = 0;

  const encBtn = menuButton('sb-enc', () => t('statusbar.encodingMenu'), () => {
    const cur = activeTab()?.doc;
    const now = cur ? { encoding: cur.encoding, hasBom: cur.hasBom } : null;
    return [
      { kind: 'sub', label: t('statusbar.reopenWithEncoding'), icon: ICON.reload, enabled: isEnabled('file.reopenWithEncoding'), build: async () => encodingItems((await loadEncodings()).filter((e) => !e.bom || e.group !== 'Unicode'), 'file.reopenWithEncoding', now ? { ...now, hasBom: false } : null) },
      { kind: 'sub', label: t('statusbar.saveWithEncoding'), icon: ICON.save, build: async () => encodingItems(await loadEncodings(), 'file.saveWithEncoding', now) },
    ];
  });
  const eolBtn = menuButton('sb-eol', () => t('statusbar.eolMenu'), () => {
    const cur = activeTab()?.doc.eol;
    return (['CRLF', 'LF', 'CR'] as const).map((e) => ({ kind: 'cmd', label: t(`files.eol.${e}`), command: 'editor.setEol', args: e, checked: cur === e }) as Item);
  });

  const langBtn = document.createElement('button');
  langBtn.type = 'button';
  langBtn.className = 'sb-item sb-btn';
  langBtn.addEventListener('click', () => void executeCommand('editor.setLanguage'));

  const spacer = document.createElement('span');
  spacer.className = 'tb-spacer';
  bar.append(pathBtn, spacer, tier, warn, encBtn, eolBtn, langBtn);

  let lastPath = '';
  const render = () => {
    const at = activeTab();
    bar.setAttribute('aria-label', t('statusbar.label'));
    bar.hidden = !at || !getSetting('workbench.statusBar');
    if (!at || bar.hidden) { closeAll(false); return; }
    const d = at.doc;
    lastPath = d.path ?? t('tab.untitled');
    pathBtn.title = lastPath;
    pathBtn.setAttribute('aria-label', t('statusbar.pathTip', { path: lastPath }));
    fitPath(pathText, lastPath);
    tier.textContent = t(`statusbar.tier.${d.tier}`);
    tier.title = t('statusbar.tierTip');
    warn.hidden = !d.malformed;
    const msg = t('statusbar.malformed', { encoding: encodingName(d.encoding) });
    warn.title = msg;
    warn.setAttribute('aria-label', msg);
    encBtn.textContent = encodingLabel(d.encoding, d.hasBom);
    encBtn.title = t('statusbar.encodingMenu');
    eolBtn.textContent = d.eol === 'MIXED' ? t('files.eol.MIXED') : d.eol;
    eolBtn.title = t('statusbar.eolTip', { name: t(`files.eol.${d.eol}`) });
    langBtn.textContent = languageName(at.languageId);
    langBtn.title = t('statusbar.changeLanguageMode');
  };
  for (const ev of ['tabs.listChanged', 'tab.activated', 'tab.changed', 'locale.changed'] as const) events.on(ev, () => { render(); if (ev === 'locale.changed') closeAll(false); });
  events.on('settings.changed', ({ key }) => { if (key === 'workbench.statusBar') render(); });
  // 观察整条状态栏（按钮宽度随截断后的文字收缩，窗口变宽时不会触发自身尺寸变化）
  new ResizeObserver(() => { if (!bar.hidden && lastPath) fitPath(pathText, lastPath); }).observe(bar);
  // ANSI 名称就绪后刷新（显示 GBK 等）
  void loadEncodings().then(render);
  queueMicrotask(render);
  return bar;
}
