// 主题相关命令：循环切换 / 选择主题。只写 setting，实际应用由 installThemeWatcher 响应 settings.changed。
import { registerCommand } from '../core/commands';
import { setSetting } from '../core/settings';
import { t } from '../i18n';
import { openPicker } from '../ui/palette';
import { THEME_SETTINGS, themeSetting, type ThemeSetting } from '.';

/** 主题显示名（按当前界面语言解析） */
export const themeLabel = (s: ThemeSetting): string => t(`theme.name.${s}`);

const isTheme = (v: unknown): v is ThemeSetting => typeof v === 'string' && (THEME_SETTINGS as readonly string[]).includes(v);

export function registerThemeCommands(): void {
  registerCommand({
    id: 'view.cycleTheme', title: () => t('cmd.view.cycleTheme'),
    run: () => {
      const i = THEME_SETTINGS.indexOf(themeSetting());
      setSetting('workbench.theme', THEME_SETTINGS[(i + 1) % THEME_SETTINGS.length]);
    },
  });
  registerCommand({
    id: 'view.selectTheme', title: () => t('cmd.view.selectTheme'),
    run: (_c, args) => {
      if (isTheme(args)) return setSetting('workbench.theme', args);
      const cur = themeSetting();
      openPicker(
        THEME_SETTINGS.map((s) => ({ label: s === cur ? t('theme.current', { name: themeLabel(s) }) : themeLabel(s), value: s })),
        (v) => { if (isTheme(v)) setSetting('workbench.theme', v); },
        t('theme.selectPlaceholder'),
      );
    },
  });
  for (const s of THEME_SETTINGS) {
    registerCommand({ id: `view.theme.${s}`, title: () => t('cmd.view.theme', { name: themeLabel(s) }), run: () => setSetting('workbench.theme', s) });
  }
}
