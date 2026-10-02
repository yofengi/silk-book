// 设置 · 外观：内置主题（带色板预览）、毛玻璃材质、用户主题导入 / 删除
import { getSetting, setSetting } from '../core/settings';
import { errorMessage, ipc } from '../ipc';
import { listUserThemes, reloadUserThemes, THEME_SETTINGS, themeSettingRaw, type ThemeSetting } from '../themes';
import { themeLabel } from '../themes/commands';
import { USER_THEME_PREFIX, type UserTheme } from '../themes/user';
import { t } from '../i18n';
import { button, group, h, row, statusLine } from './dom';

/** 色板：[背景, 编辑区, 强调色, 文字]；毛玻璃用渐变底模拟材质 */
const SWATCH: Record<ThemeSetting, [string, string, string, string]> = {
  'glass-system': ['linear-gradient(135deg,#e8eef6 0 50%,#1d2430 50% 100%)', 'rgba(128,128,128,.25)', '#4c9bff', '#888'],
  'glass-dark': ['linear-gradient(135deg,#1d2430,#231d2b)', 'rgba(20,22,28,.6)', '#4c9bff', '#e2e4e8'],
  'glass-light': ['linear-gradient(135deg,#e8eef6,#eef3ef)', 'rgba(255,255,255,.6)', '#0b64c0', '#1a1d21'],
  system: ['linear-gradient(135deg,#f3f3f3 0 50%,#1f1f1f 50% 100%)', 'rgba(128,128,128,.3)', '#3b8eea', '#888'],
  light: ['#f3f3f3', '#ffffff', '#0b64c0', '#1f2328'],
  dark: ['#1f1f1f', '#1e1e1e', '#3b8eea', '#d4d4d4'],
};

function swatch(bg: string, editor: string, accent: string, fg: string): HTMLElement {
  const s = h('span', { class: 'st-swatch', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'st-sw-bar' }),
    h('span', { class: 'st-sw-editor' }, h('span', { class: 'st-sw-line' }), h('span', { class: 'st-sw-line short' })),
  );
  s.style.setProperty('--sw-bg', bg);
  s.style.setProperty('--sw-editor', editor);
  s.style.setProperty('--sw-accent', accent);
  s.style.setProperty('--sw-fg', fg);
  return s;
}

function userSwatch(th: UserTheme): HTMLElement {
  const c = th.colors;
  const dark = th.kind === 'dark';
  return swatch(
    c['--bg'] ?? (dark ? '#1f1f1f' : '#f3f3f3'),
    c['--editor-bg'] ?? (dark ? '#1e1e1e' : '#ffffff'),
    c['--accent'] ?? (dark ? '#3b8eea' : '#0b64c0'),
    c['--fg'] ?? (dark ? '#d4d4d4' : '#1f2328'),
  );
}

/** 单选卡片（role=radio，方向键在组内移动） */
function card(value: string, label: string, sw: HTMLElement, current: string, extra?: HTMLElement): HTMLElement {
  const b = h('button', { class: 'st-theme-card', attrs: { role: 'radio', 'aria-checked': String(value === current), 'data-value': value } }, sw, h('span', { class: 'st-theme-name', text: label }));
  b.type = 'button';
  b.tabIndex = value === current ? 0 : -1;
  b.addEventListener('click', () => setSetting('workbench.theme', value));
  return extra ? h('div', { class: 'st-theme-cell' }, b, extra) : h('div', { class: 'st-theme-cell' }, b);
}

function radioGroup(label: string, cards: HTMLElement[]): HTMLElement {
  const g = h('div', { class: 'st-theme-grid', attrs: { role: 'radiogroup', 'aria-label': label } }, ...cards);
  g.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    const items = [...g.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next = items[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next.focus();
    next.click();
  });
  return g;
}

export function renderAppearance(): HTMLElement {
  const current = themeSettingRaw();
  const builtIn = radioGroup(t('settings.appearance.builtinThemes'), THEME_SETTINGS.map((s) => card(s, themeLabel(s), swatch(...SWATCH[s]), current)));

  // 毛玻璃材质
  const mat = h('select', { class: 'st-input st-select' },
    h('option', { text: t('settings.appearance.acrylic'), attrs: { value: 'acrylic' } }),
    h('option', { text: t('settings.appearance.mica'), attrs: { value: 'mica' } }),
  );
  mat.value = getSetting('workbench.glassMaterial') === 'mica' ? 'mica' : 'acrylic';
  mat.addEventListener('change', () => setSetting('workbench.glassMaterial', mat.value));

  // 用户主题
  const status = statusLine();
  const users = listUserThemes();
  const userCards = users.map((th) => {
    const del = button(t('common.delete'), () => void removeTheme(th, status), 'st-btn st-btn-small st-btn-danger');
    del.setAttribute('aria-label', t('settings.appearance.deleteNamed', { name: th.name }));
    const kind = t(th.kind === 'dark' ? 'common.dark' : 'common.light');
    const label = t('settings.appearance.userThemeCard', { name: th.name, kind: th.glass ? t('settings.appearance.glassKind', { kind }) : kind });
    return card(`${USER_THEME_PREFIX}${th.id}`, label, userSwatch(th), current, del);
  });
  const userList = userCards.length
    ? radioGroup(t('settings.appearance.userThemes'), userCards)
    : h('p', { class: 'st-empty', text: t('settings.appearance.noUserThemes') });

  return h('div', {},
    group(t('settings.appearance.theme'), t('settings.appearance.themeDesc'), builtIn),
    group(t('settings.appearance.material'), null, row(t('settings.appearance.windowMaterial'), mat, t('settings.appearance.materialHint'))),
    group(t('settings.appearance.userThemes'), t('settings.appearance.userThemesDesc'),
      userList,
      h('div', { class: 'st-actions' }, button(t('settings.appearance.import'), () => void importTheme(status), 'st-btn st-btn-primary')),
      status.el,
    ),
  );
}

async function importTheme(status: ReturnType<typeof statusLine>): Promise<void> {
  const [path] = await ipc.openDialog({ multiple: false, filters: [{ name: t('settings.appearance.importFilter'), extensions: ['json'] }] });
  if (!path) return;
  try {
    const r = await ipc.themeImport(path);
    await reloadUserThemes();
    const ok = listUserThemes().some((th) => th.id === r.id);
    if (ok) {
      setSetting('workbench.theme', `${USER_THEME_PREFIX}${r.id}`);
      status.set(t('settings.appearance.imported'), 'ok');
    } else {
      status.set(t('settings.appearance.importInvalid'), 'error');
    }
  } catch (e) {
    status.set(t('settings.appearance.importFailed', { error: errorMessage(e) }), 'error');
  }
}

async function removeTheme(th: UserTheme, status: ReturnType<typeof statusLine>): Promise<void> {
  if (!(await ipc.confirm(t('settings.appearance.deleteConfirm', { name: th.name }), t('settings.appearance.deleteTitle')))) return;
  try {
    await ipc.themeDelete(th.id);
    if (getSetting('workbench.theme') === `${USER_THEME_PREFIX}${th.id}`) setSetting('workbench.theme', th.glass ? `glass-${th.kind}` : th.kind);
    await reloadUserThemes();
    status.set(t('settings.appearance.deleted', { name: th.name }), 'ok');
  } catch (e) {
    status.set(t('settings.appearance.deleteFailed', { error: errorMessage(e) }), 'error');
  }
}
