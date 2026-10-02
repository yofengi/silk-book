// 预览控制器（主 chunk，保持轻量）：命令注册、分屏显隐、首次使用时动态 import() 整个渲染模块。
import { registerCommand } from '../core/commands';
import { events } from '../core/events';
import { registerKeybinding } from '../core/keybindings';
import { activeTab, getView } from '../editor/tabs';
import { t } from '../i18n';
import { ipc } from '../ipc';
import type { Preview } from './preview';
import { isPreviewOpen, setPreviewHost, setPreviewOpen } from './state';

let preview: Preview | null = null;
let loading: Promise<Preview | null> | null = null;
let host: HTMLElement;

const isMarkdownTab = () => activeTab()?.languageId === 'markdown';

function ensurePreview(): Promise<Preview | null> {
  if (preview) return Promise.resolve(preview);
  loading ??= import('./preview').then((m) => {
    const view = getView();
    if (!view) return null;
    preview = m.createPreview(host, view);
    return preview;
  }).finally(() => { loading = null; });
  return loading;
}

const allowed = new Set<string>();
/** 预览打开时为文档目录授权 asset 协议（每个路径一次）；未命名文档跳过，图片保持占位 */
async function allowAssets(path: string | null | undefined): Promise<void> {
  if (!path || allowed.has(path)) return;
  try {
    await ipc.allowAssetDir(path);
    allowed.add(path);
  } catch (e) {
    console.warn('[allow_asset_dir]', e);
  }
}

const EXTERNAL = /^(https?:\/\/|mailto:)/i;

/** 根据活动标签页决定是否显示预览 */
async function refresh(): Promise<void> {
  const t = activeTab();
  const show = !!t && t.languageId === 'markdown' && isPreviewOpen(t.id);
  host.hidden = !show;
  host.parentElement?.classList.toggle('split', show);
  if (!show || !t) return;
  const p = await ensurePreview();
  // 等待加载期间标签页可能已切换
  if (!p || activeTab() !== t || !isPreviewOpen(t.id)) return;
  await allowAssets(t.doc.path);
  if (activeTab() === t && isPreviewOpen(t.id)) p.show(t);
}

export function registerMarkdownCommands(previewHost: HTMLElement): void {
  host = previewHost;
  setPreviewHost(previewHost);
  registerCommand({
    id: 'markdown.togglePreview', title: () => t('cmd.markdown.togglePreview'), when: isMarkdownTab,
    run: async () => {
      const t = activeTab();
      if (!t) return;
      setPreviewOpen(t.id, !isPreviewOpen(t.id));
      await refresh();
    },
  });
  registerCommand({
    id: 'markdown.openLink', title: () => t('cmd.markdown.openLink'),
    run: (_c, args) => {
      const url = typeof args === 'string' ? args.trim() : '';
      if (!EXTERNAL.test(url)) return;
      return ipc.openExternal(url);
    },
  });
  registerKeybinding({ key: 'Ctrl+Shift+V', command: 'markdown.togglePreview' });

  events.on('tab.activated', () => void refresh());
  events.on('tabs.listChanged', () => void refresh());
  events.on('tab.changed', ({ id }) => {
    // 语言切换可能使预览失效
    if (id === activeTab()?.id && !host.hidden !== (isMarkdownTab() && isPreviewOpen(id))) void refresh();
  });
  events.on('doc.changed', ({ id }) => {
    if (preview && !host.hidden && id === activeTab()?.id) preview.scheduleRender();
  });
}
