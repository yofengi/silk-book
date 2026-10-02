// 设置页控制器（主 chunk，保持轻量）：注册 settings.open 命令与快捷键；
// 首次打开时动态 import() 设置 UI 模块（./page），渲染进特殊标签页 special:settings 的内容区。
import { registerCommand } from '../core/commands';
import { events } from '../core/events';
import { registerKeybinding } from '../core/keybindings';
import { activeSpecial, listSpecialTabs, openSpecialTab, SPECIAL_PREFIX } from '../editor/tabs';
import { t } from '../i18n';

export const SETTINGS_TAB_ID = `${SPECIAL_PREFIX}settings`;

type PageModule = typeof import('./page');
let page: PageModule | null = null;
let loading: Promise<PageModule | null> | null = null;
let mounted = false;

function ensurePage(): Promise<PageModule | null> {
  loading ??= import('./page')
    .then((m) => (page = m))
    .catch((e: unknown) => {
      console.error('settings page load failed', e);
      loading = null;
      return null;
    });
  return loading;
}

async function show(host: HTMLElement): Promise<void> {
  const m = await ensurePage();
  // 加载期间可能已切走
  if (!m || activeSpecial()?.id !== SETTINGS_TAB_ID) return;
  if (!mounted) {
    m.mountSettingsPage(host);
    mounted = true;
  } else {
    m.refreshSettingsPage();
  }
}

export function registerSettingsCommands(host: HTMLElement): void {
  registerCommand({
    id: 'settings.open', title: () => t('cmd.settings.open'),
    run: () => {
      openSpecialTab(SETTINGS_TAB_ID, () => t('settings.title'));
      void show(host);
    },
  });
  registerKeybinding({ key: 'Ctrl+,', command: 'settings.open' });

  events.on('tab.activated', ({ id }) => {
    if (id === SETTINGS_TAB_ID) void show(host);
  });
  // 切换界面语言：已挂载的设置页按新语言重建（保留当前分组）
  events.on('locale.changed', () => {
    if (mounted) page?.refreshSettingsPage();
  });
  events.on('tabs.listChanged', () => {
    // 标签关闭后卸载设置页 DOM，下次打开重新构建（状态以设置为准，不缓存）
    if (mounted && !listSpecialTabs().some((s) => s.id === SETTINGS_TAB_ID)) {
      page?.unmountSettingsPage();
      host.replaceChildren();
      mounted = false;
    }
  });
}
