// 设置 · 字体：界面字体 / 代码字体（带系统字体自动补全的组合框）、字号、行高、实时预览
import { getSetting, resetSetting, setSetting } from '../core/settings';
import { t } from '../i18n';
import { ipc } from '../ipc';
import { BUNDLED_MONO, bundledFamilies } from '../themes/fonts';
import { button, group, h, numberInput, row } from './dom';

let systemFonts: Promise<string[]> | null = null;
function loadSystemFonts(): Promise<string[]> {
  systemFonts ??= ipc.listSystemFonts().catch((e: unknown) => {
    console.error('list_system_fonts failed', e);
    return [];
  });
  return systemFonts;
}

const MAX_OPTIONS = 80;
let comboSeq = 0;

/**
 * 可自由输入的字体组合框（ARIA 1.2 combobox + listbox）。
 * 上下键在候选中移动，Enter 选中，Esc 关闭候选；失焦或 Enter 时提交。
 */
function fontCombo(opts: { label: string; value: string; placeholder: string; pinned: () => Promise<string[]>; onCommit: (v: string) => void }): HTMLElement {
  const id = `st-combo-${++comboSeq}`;
  const input = h('input', {
    class: 'st-input st-combo-input',
    attrs: {
      type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
      'aria-controls': `${id}-list`, 'aria-label': opts.label, placeholder: opts.placeholder, spellcheck: 'false', autocomplete: 'off',
    },
  });
  input.value = opts.value;
  const list = h('ul', { class: 'st-combo-list', attrs: { id: `${id}-list`, role: 'listbox', 'aria-label': t('settings.fonts.candidates', { label: opts.label }) } });
  list.hidden = true;
  let items: string[] = [];
  let active = -1;
  let committed = opts.value;

  const commit = () => {
    const v = input.value.trim();
    if (v === committed) return;
    committed = v;
    opts.onCommit(v);
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const setActive = (i: number) => {
    active = i;
    for (const [j, li] of [...list.children].entries()) li.setAttribute('aria-selected', String(j === i));
    const li = list.children[i] as HTMLElement | undefined;
    if (li) {
      input.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    }
  };
  const pick = (name: string) => {
    input.value = name;
    close();
    commit();
  };
  const render = async () => {
    const [all, bundled] = await Promise.all([loadSystemFonts(), opts.pinned()]);
    const q = input.value.trim().toLowerCase();
    const pinned = bundled.filter((p) => !q || p.toLowerCase().includes(q));
    const rest = all.filter((f) => !bundled.includes(f) && (!q || f.toLowerCase().includes(q)));
    items = [...pinned, ...rest].slice(0, MAX_OPTIONS);
    list.replaceChildren(...items.map((name, i) => {
      const li = h('li', { class: 'st-combo-opt', attrs: { id: `${id}-opt-${i}`, role: 'option', 'aria-selected': 'false' } },
        h('span', { class: 'st-combo-name', text: name }),
        bundled.includes(name) ? h('span', { class: 'st-combo-tag', text: t('common.builtin') }) : null,
      );
      li.style.fontFamily = `"${name.replace(/["\\]/g, '')}", var(--ui-font)`;
      // mousedown 而非 click：避免 input 先失焦触发提交旧值
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(name); });
      return li;
    }));
    if (document.activeElement !== input) return;
    list.hidden = items.length === 0;
    input.setAttribute('aria-expanded', String(items.length > 0));
    active = -1;
  };

  input.addEventListener('focus', () => void render());
  input.addEventListener('input', () => void render());
  input.addEventListener('blur', () => { close(); commit(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { void render(); return; }
      const n = items.length;
      if (n) setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!list.hidden && active >= 0) pick(items[active]);
      else { close(); commit(); }
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  return h('div', { class: 'st-combo' }, input, list);
}

/** 预览代码；注释行随界面语言与产品名变化 */
const previewCode = (): string => [
  'function greet(name: string) {',
  `  // ${t('settings.fonts.codePreviewComment')} — 0O 1lI {} [] => != ===`,
  '  return `Hello, ${name}!`;',
  '}',
].join('\n');

export function renderFonts(): HTMLElement {
  const preview = h('pre', { class: 'st-font-preview', attrs: { 'aria-label': t('settings.fonts.codePreviewLabel') } }, previewCode());
  const uiPreview = h('p', { class: 'st-ui-preview', text: t('settings.fonts.uiPreview') });

  const codeFont = fontCombo({
    label: t('settings.fonts.codeFont'),
    value: getSetting('editor.fontFamily'),
    placeholder: BUNDLED_MONO,
    // 随包代码字体置顶；后端未返回（如浏览器 mock）时仍显示默认的 Maple Mono
    pinned: () => bundledFamilies('mono').then((f) => (f.length ? f : [BUNDLED_MONO])),
    onCommit: (v) => (v ? setSetting('editor.fontFamily', v) : resetSetting('editor.fontFamily')),
  });
  const uiFont = fontCombo({
    label: t('settings.fonts.uiFont'),
    value: getSetting('workbench.fontFamily'),
    placeholder: t('settings.fonts.uiFontPlaceholder'),
    // 随包界面字体（目前后端不返回任何 UI 字体，Maple Hand 待许可证确认）
    pinned: () => bundledFamilies('ui'),
    onCommit: (v) => (v ? setSetting('workbench.fontFamily', v) : resetSetting('workbench.fontFamily')),
  });

  const codeSize = numberInput(getSetting('editor.fontSize'), 8, 40, 1, (v) => setSetting('editor.fontSize', v));
  const lineHeight = numberInput(getSetting('editor.lineHeight'), 1, 3, 0.1, (v) => setSetting('editor.lineHeight', Math.round(v * 10) / 10));
  const uiSize = numberInput(getSetting('workbench.fontSize'), 10, 20, 1, (v) => setSetting('workbench.fontSize', v));

  const reset = button(t('settings.fonts.reset'), () => {
    for (const k of ['editor.fontFamily', 'editor.fontSize', 'editor.lineHeight', 'workbench.fontFamily', 'workbench.fontSize'] as const) resetSetting(k);
    const again = renderFonts();
    reset.closest('.st-section-body')?.replaceChildren(again);
  });

  return h('div', {},
    group(t('settings.fonts.codeFont'), t('settings.fonts.codeFontDesc', { font: BUNDLED_MONO }),
      row(t('settings.fonts.font'), codeFont),
      row(t('settings.fonts.size'), codeSize, 'px'),
      row(t('settings.fonts.lineHeight'), lineHeight, t('settings.fonts.lineHeightUnit')),
      preview,
    ),
    group(t('settings.fonts.uiFont'), t('settings.fonts.uiFontDesc'),
      row(t('settings.fonts.font'), uiFont),
      row(t('settings.fonts.size'), uiSize, 'px'),
      uiPreview,
    ),
    h('div', { class: 'st-actions' }, reset),
  );
}
