// 设置 · 文件关联：分组列出常见扩展名，显示注册状态，批量注册 / 取消注册，跳转 Windows 默认应用设置
import { t, type Key } from '../i18n';
import { errorMessage, ipc, type FileAssocStatus } from '../ipc';
import { button, group, h, statusLine } from './dom';

const GROUPS: { title: Key; exts: string[] }[] = [
  { title: 'settings.assoc.groupText', exts: ['txt', 'log', 'md', 'markdown', 'ini', 'cfg', 'conf', 'csv'] },
  {
    title: 'settings.assoc.groupCode',
    exts: ['js', 'ts', 'jsx', 'tsx', 'json', 'py', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'go', 'html', 'css', 'xml', 'yaml', 'yml', 'sql', 'lua', 'toml', 'sh', 'bat', 'ps1'],
  },
];

function badge(s: FileAssocStatus | undefined): HTMLElement {
  if (!s) return h('span', { class: 'st-badge', text: '…' });
  if (s.isDefault) return h('span', { class: 'st-badge ok', text: t('settings.assoc.badgeDefault') });
  if (s.registered) return h('span', { class: 'st-badge on', text: t('settings.assoc.badgeRegistered') });
  return h('span', { class: 'st-badge', text: t('settings.assoc.badgeUnregistered') });
}

export function renderAssoc(): HTMLElement {
  const status = statusLine();
  const boxes = new Map<string, HTMLInputElement>();
  const badges = new Map<string, HTMLElement>();

  const groups = GROUPS.map((g) => {
    const title = t(g.title);
    const grid = h('div', { class: 'st-ext-grid', attrs: { role: 'group', 'aria-label': t('settings.assoc.extGroupLabel', { group: title }) } });
    for (const ext of g.exts) {
      const cb = h('input', { attrs: { type: 'checkbox', value: ext } });
      boxes.set(ext, cb);
      const b = badge(undefined);
      badges.set(ext, b);
      grid.append(h('label', { class: 'st-ext' }, cb, h('span', { class: 'st-ext-name', text: `.${ext}` }), b));
    }
    const all = button(t('settings.assoc.selectAll'), () => { for (const e of g.exts) boxes.get(e)!.checked = true; }, 'st-btn st-btn-small');
    const none = button(t('settings.assoc.selectNone'), () => { for (const e of g.exts) boxes.get(e)!.checked = false; }, 'st-btn st-btn-small');
    return h('div', { class: 'st-ext-group' },
      h('div', { class: 'st-ext-head' }, h('span', { class: 'st-ext-title', text: title }), all, none),
      grid,
    );
  });

  const refresh = async () => {
    try {
      const list = await ipc.fileAssocStatus([...boxes.keys()]);
      for (const s of list) {
        const old = badges.get(s.ext);
        if (!old) continue;
        const nb = badge(s);
        old.replaceWith(nb);
        badges.set(s.ext, nb);
      }
    } catch (e) {
      status.set(t('settings.assoc.readFailed', { error: errorMessage(e) }), 'error');
    }
  };

  const selected = () => [...boxes].filter(([, cb]) => cb.checked).map(([ext]) => ext);
  const act = async (register: boolean) => {
    const exts = selected();
    if (!exts.length) { status.set(t('settings.assoc.noneSelected'), 'error'); return; }
    try {
      await (register ? ipc.fileAssocRegister(exts) : ipc.fileAssocUnregister(exts));
      status.set(t(register ? 'settings.assoc.registered' : 'settings.assoc.unregistered', { count: exts.length }), 'ok');
    } catch (e) {
      status.set(t(register ? 'settings.assoc.registerFailed' : 'settings.assoc.unregisterFailed', { error: errorMessage(e) }), 'error');
    }
    await refresh();
  };

  void refresh();

  return h('div', { class: 'st-assoc' },
    group(t('settings.section.assoc'), null,
      h('p', { class: 'st-note' }, t('settings.assoc.desc1'), t('settings.assoc.desc2')),
      ...groups,
      h('div', { class: 'st-actions' },
        button(t('settings.assoc.register'), () => void act(true), 'st-btn st-btn-primary'),
        button(t('settings.assoc.unregister'), () => void act(false)),
        button(t('settings.assoc.openDefaultApps'), () => void ipc.openDefaultAppsSettings().catch((e: unknown) => status.set(errorMessage(e), 'error'))),
        button(t('settings.assoc.refresh'), () => void refresh()),
      ),
      status.el,
    ),
  );
}
