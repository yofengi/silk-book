// 原生 DOM UI：顶栏、标签栏、状态栏。所有交互只通过 executeCommand。
import { executeCommand, isEnabled, registerCommand } from '../core/commands';
import { events } from '../core/events';
import { formatKey, keybindingFor, registerKeybinding } from '../core/keybindings';
import { baseName } from '../editor/document';
import { getSetting } from '../core/settings';
import { activeSpecial, activeTab, allTabIds, listSpecialTabs, listTabs } from '../editor/tabs';
import { isTransferring } from '../editor/transfer';
import { t, type Key } from '../i18n';
import { isPreviewOpen } from '../markdown/state';
import { createMenuButton, registerMenuCommands } from './menu';
import { openCommandPalette } from './palette';
import { mountStatusBar } from './statusbar';
import { bindWindowState, registerWindowCommands } from './window';
import { bindTabDragging } from './tab-drag';
import { createUpdateButton } from './updates';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 按钮提示文字：快捷键从 keybinding 注册表读取（用户覆盖后随 renderStatus 刷新） */
function cmdTitle(title: string, command: string): string {
  const k = keybindingFor(command);
  return k ? `${title} (${formatKey(k)})` : title;
}

/** 文案存 i18n 键（data-label-key / data-title-key），切换语言时由 applyLabels 重新解析 */
function cmdButton(labelKey: Key, command: string, titleKey: Key, toggle = false): HTMLButtonElement {
  const b = el('button', 'tb-btn', t(labelKey));
  b.type = 'button';
  b.dataset.labelKey = labelKey;
  b.dataset.titleKey = titleKey;
  b.title = cmdTitle(t(titleKey), command);
  b.dataset.command = command;
  if (toggle) b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => void executeCommand(command));
  return b;
}

// 10x10 线条图标（Windows 11 风格），stroke 跟随 currentColor
const svg = (d: string) => `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
const ICON_MIN = svg('M0 5.5h10');
const ICON_MAX = svg('M.5 .5h9v9h-9z');
const ICON_RESTORE = svg('M2.5 2.5h7v7h-7zM2.5 .5h7v7');
const ICON_CLOSE = svg('M0 0l10 10M10 0L0 10');
const ICON_GEAR = `<svg class="tab-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const ICON_TAB_CLOSE = `<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false"><path d="M0 0l8 8M8 0L0 8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

function setLabel(b: HTMLElement, label: string): void {
  b.title = label;
  b.setAttribute('aria-label', label);
}

function winButton(command: string, labelKey: Key, icon: string, extra = ''): HTMLButtonElement {
  const b = el('button', `win-btn ${extra}`.trim());
  b.type = 'button';
  b.tabIndex = -1; // 与原生标题栏一致，不进入 Tab 序列（键盘用 Alt+F4 / Win 快捷键）
  b.dataset.labelKey = labelKey;
  setLabel(b, t(labelKey));
  b.innerHTML = icon;
  b.addEventListener('click', () => void executeCommand(command));
  return b;
}

export interface Layout {
  editorHost: HTMLElement;
  previewHost: HTMLElement;
  overlayHost: HTMLElement;
  /** 特殊标签页（设置）内容区 */
  specialHost: HTMLElement;
}

export function mountUI(root: HTMLElement): Layout {
  registerCommand({ id: 'palette.open', title: () => t('cmd.palette.open'), run: openCommandPalette });
  registerKeybinding({ key: 'Ctrl+Shift+P', command: 'palette.open' });
  registerKeybinding({ key: 'F1', command: 'palette.open' });

  registerWindowCommands();
  registerMenuCommands();

  // 标题栏 + 工具栏 + 标签栏合为一个表面；空白处为拖拽区（Tauri 原生处理双击最大化）
  const header = el('header', 'titlebar');
  const top = el('div', 'topbar');
  top.setAttribute('role', 'toolbar');
  top.dataset.tauriDragRegion = '';
  // 左上角：图标菜单按钮（非拖拽区）
  const menuBtn = createMenuButton();
  const minimapBtn = cmdButton('toolbar.minimap', 'view.toggleMinimap', 'cmd.view.toggleMinimap', true);
  const wordBtn = cmdButton('toolbar.wordCompletion', 'editor.toggleWordCompletion', 'cmd.editor.toggleWordCompletion', true);
  const previewBtn = cmdButton('toolbar.preview', 'markdown.togglePreview', 'cmd.markdown.togglePreview', true);
  const wrapBtn = cmdButton('toolbar.lineWrap', 'view.toggleLineWrap', 'cmd.view.toggleLineWrap', true);
  const spacer = el('span', 'tb-spacer');
  spacer.dataset.tauriDragRegion = '';
  const winCtl = el('div', 'win-controls');
  const maxBtn = winButton('window.toggleMaximize', 'window.maximize', ICON_MAX);
  winCtl.append(
    winButton('window.minimize', 'window.minimize', ICON_MIN),
    maxBtn,
    winButton('window.close', 'window.close', ICON_CLOSE, 'win-close'),
  );
  top.append(
    menuBtn,
    el('span', 'tb-sep'),
    cmdButton('toolbar.find', 'editor.find', 'toolbar.find'),
    cmdButton('toolbar.replace', 'editor.replace', 'toolbar.replace'),
    el('span', 'tb-sep'),
    minimapBtn, wordBtn, wrapBtn,
    el('span', 'tb-sep'),
    previewBtn,
    spacer,
    createUpdateButton(),
    cmdButton('toolbar.commands', 'palette.open', 'toolbar.commandsTip'),
  );
  let maximized = false;
  const renderMax = () => {
    const key: Key = maximized ? 'window.restore' : 'window.maximize';
    maxBtn.dataset.labelKey = key;
    setLabel(maxBtn, t(key));
    maxBtn.innerHTML = maximized ? ICON_RESTORE : ICON_MAX;
  };
  bindWindowState((max) => { maximized = max; renderMax(); });

  const tabBar = el('nav', 'tabbar');
  tabBar.setAttribute('role', 'tablist');
  tabBar.dataset.tauriDragRegion = '';
  bindTabDragging(tabBar);
  /** 静态文案（aria-label / 按钮文字 / 提示）；首次挂载与切换语言时调用 */
  const applyLabels = () => {
    top.setAttribute('aria-label', t('toolbar.label'));
    tabBar.setAttribute('aria-label', t('tab.listLabel'));
    for (const b of header.querySelectorAll<HTMLElement>('[data-label-key]')) {
      const key = b.dataset.labelKey as Key;
      if (b.classList.contains('win-btn')) setLabel(b, t(key));
      else b.textContent = t(key);
    }
  };
  const topRow = el('div', 'title-row');
  topRow.append(top, winCtl);
  header.append(topRow, tabBar);
  const work = el('main', 'work');
  const editorHost = el('div', 'editor-host');
  const previewHost = el('div', 'preview-host');
  previewHost.hidden = true;
  // 特殊标签页（设置）的内容区；激活时盖住编辑区，编辑器 DOM 保留不重建
  const specialHost = el('div', 'special-host');
  specialHost.hidden = true;
  work.append(editorHost, previewHost, specialHost);
  const overlayHost = el('div', 'overlay-host');
  const status = mountStatusBar();

  root.append(header, work, overlayHost, status);

  const renderTabs = () => {
    const nodes = new Map<string, HTMLElement>();
    const active = activeTab();
    for (const ft of listTabs()) {
      const tab = el('div', `tab${ft === active ? ' active' : ''}`);
      tab.setAttribute('role', 'tab');
      tab.dataset.tabId = ft.id;
      tab.setAttribute('aria-selected', String(ft === active));
      tab.tabIndex = 0;
      tab.title = ft.doc.path ?? t('tab.untitled');
      const name = el('span', 'tab-name', baseName(ft.doc.path));
      if (ft.doc.dirty) tab.classList.add('dirty');
      const x = el('button', 'tab-close');
      x.innerHTML = ICON_TAB_CLOSE;
      x.type = 'button';
      x.disabled = isTransferring(ft.id);
      if (x.disabled) { tab.classList.add('moving'); tab.setAttribute('aria-busy', 'true'); }
      x.setAttribute('aria-label', t('tab.closeNamed', { name: baseName(ft.doc.path) }));
      x.addEventListener('click', (e) => { e.stopPropagation(); void executeCommand('tab.close', ft.id); });
      tab.append(name, x);
      tab.addEventListener('click', () => void executeCommand('tab.activate', ft.id));
      tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') void executeCommand('tab.activate', ft.id); });
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) void executeCommand('tab.close', ft.id); });
      nodes.set(ft.id, tab);
    }
    const sp = activeSpecial();
    for (const s of listSpecialTabs()) {
      const on = s === sp;
      const tab = el('div', `tab special${on ? ' active' : ''}`);
      tab.setAttribute('role', 'tab');
      tab.dataset.tabId = s.id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = 0;
      const title = s.title();
      tab.title = title;
      tab.innerHTML = ICON_GEAR;
      const name = el('span', 'tab-name', title);
      const x = el('button', 'tab-close');
      x.innerHTML = ICON_TAB_CLOSE;
      x.type = 'button';
      x.setAttribute('aria-label', t('tab.closeNamed', { name: title }));
      x.addEventListener('click', (e) => { e.stopPropagation(); void executeCommand('tab.close', s.id); });
      tab.append(name, x);
      tab.addEventListener('click', () => void executeCommand('tab.activate', s.id));
      tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') void executeCommand('tab.activate', s.id); });
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) void executeCommand('tab.close', s.id); });
      nodes.set(s.id, tab);
    }
    // 文件与设置标签页共用一份显示顺序；循环快捷键、拖拽和渲染不会各自排序。
    tabBar.replaceChildren(...allTabIds().map((id) => nodes.get(id)).filter((node): node is HTMLElement => !!node));
  };

  const renderStatus = () => {
    const at = activeTab();
    for (const b of top.querySelectorAll<HTMLButtonElement>('button[data-command]')) {
      const cmd = b.dataset.command ?? '';
      b.disabled = !isEnabled(cmd);
      if (b.dataset.titleKey) b.title = cmdTitle(t(b.dataset.titleKey as Key), cmd);
    }
    const sp = activeSpecial();
    specialHost.hidden = !sp;
    editorHost.hidden = !!sp;
    if (sp) previewHost.hidden = true;
    minimapBtn.setAttribute('aria-pressed', String(!!at?.flags.minimap));
    wordBtn.setAttribute('aria-pressed', String(!!at?.flags.wordCompletion));
    wrapBtn.setAttribute('aria-pressed', String(!!at && getSetting('editor.wordWrap')));
    previewBtn.hidden = at?.languageId !== 'markdown';
    previewBtn.setAttribute('aria-pressed', String(isPreviewOpen(at?.id)));
  };

  const renderAll = () => { renderTabs(); renderStatus(); };
  events.on('tabs.listChanged', renderAll);
  events.on('tab.activated', renderAll);
  events.on('tab.changed', renderAll);
  events.on('keybindings.changed', renderStatus);
  events.on('commands.executionChanged', renderStatus);
  events.on('locale.changed', () => { applyLabels(); renderMax(); renderAll(); });
  applyLabels();
  renderAll();

  return { editorHost, previewHost, overlayHost, specialHost };
}
