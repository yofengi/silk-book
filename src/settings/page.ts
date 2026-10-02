// 设置页（懒加载 chunk）：左侧分组导航 + 右侧内容。设置写入 core/settings，实时生效；未知键由 settings 模块原样保留。
import './settings.css';
import { renderAppearance } from './appearance';
import { renderAssoc } from './assoc';
import { h } from './dom';
import { renderFonts } from './fonts';
import { renderGeneral } from './general';
import { renderKeys } from './keys';
import { renderAbout } from './about';
import { t } from '../i18n';

type SectionId = 'general' | 'appearance' | 'fonts' | 'assoc' | 'keys' | 'about';
const sectionLabel = (id: SectionId) => t(`settings.section.${id}`);

const SECTIONS: { id: SectionId; icon: string }[] = [
  { id: 'general', icon: '<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="10" cy="4.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="11.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>' },
  { id: 'appearance', icon: '<path d="M8 2a6 6 0 1 0 0 12c.8 0 1.2-.5 1.2-1.1 0-.7-.5-.9-.5-1.5 0-.6.5-1 1.1-1H11a3 3 0 0 0 3-3C14 4.4 11.3 2 8 2Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="7" r=".9" fill="currentColor"/><circle cx="7.5" cy="4.8" r=".9" fill="currentColor"/><circle cx="10.5" cy="5.6" r=".9" fill="currentColor"/>' },
  { id: 'fonts', icon: '<path d="M3 13 7 3h2l4 10M4.6 9.5h6.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: 'assoc', icon: '<path d="M4 2h5l3 3v9H4z M9 2v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 9.5h4M6 11.5h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
  { id: 'keys', icon: '<rect x="1.8" y="4" width="12.4" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 6.5h1M7.5 6.5h1M11 6.5h1M4.5 9.5h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
  { id: 'about', icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 7v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="4.8" r=".7" fill="currentColor"/>' },
];

let root: HTMLElement | null = null;
let current: SectionId = 'general';
let disposeSection: (() => void) | null = null;

function renderSection(id: SectionId): HTMLElement {
  disposeSection?.();
  disposeSection = null;
  if (id === 'general') { const g = renderGeneral(); disposeSection = g.dispose; return g.el; }
  if (id === 'appearance') return renderAppearance();
  if (id === 'fonts') return renderFonts();
  if (id === 'assoc') return renderAssoc();
  if (id === 'about') { const a = renderAbout(); disposeSection = a.dispose; return a.el; }
  const k = renderKeys();
  disposeSection = k.dispose;
  return k.el;
}

function build(host: HTMLElement): void {
  const content = h('section', { class: 'st-content', attrs: { role: 'tabpanel', tabindex: '-1' } });
  const nav = h('nav', { class: 'st-nav', attrs: { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('settings.navLabel') } });
  const buttons = new Map<SectionId, HTMLButtonElement>();

  const select = (id: SectionId, focusContent = false) => {
    current = id;
    for (const [sid, b] of buttons) {
      const on = sid === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('active', on);
    }
    const label = sectionLabel(id);
    content.setAttribute('aria-label', label);
    content.replaceChildren(h('h1', { class: 'st-title', text: label }), renderSection(id));
    content.scrollTop = 0;
    if (focusContent) content.focus();
  };

  for (const s of SECTIONS) {
    const b = h('button', { class: 'st-nav-item', attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' } });
    b.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${s.icon}</svg>`;
    b.append(h('span', { text: sectionLabel(s.id) }));
    b.addEventListener('click', () => select(s.id));
    buttons.set(s.id, b);
    nav.append(b);
  }
  // 纵向 tablist：↑/↓/Home/End 切换并聚焦
  nav.addEventListener('keydown', (e) => {
    const ids = SECTIONS.map((s) => s.id);
    const i = ids.indexOf(current);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(ids[next]);
    buttons.get(ids[next])?.focus();
  });

  const side = h('aside', { class: 'st-side' }, h('div', { class: 'st-side-title', text: t('settings.title') }), nav);
  root = h('div', { class: 'settings-page' }, side, content);
  host.replaceChildren(root);
  select(current);
}

export function mountSettingsPage(host: HTMLElement): void {
  build(host);
}

/** 重新激活设置标签：按当前设置重建当前分组（外部可能已通过命令改了主题等） */
export function refreshSettingsPage(): void {
  const host = root?.parentElement;
  if (host) build(host);
}

export function unmountSettingsPage(): void {
  disposeSection?.();
  disposeSection = null;
  root = null;
}
