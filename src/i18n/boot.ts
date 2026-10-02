// 界面语言设置：启动时（首次挂载 UI 之前）解析 workbench.language 并加载语言包；设置变更时实时切换。
import { events } from '../core/events';
import { getSetting } from '../core/settings';
import { ipc } from '../ipc';
import { LOCALES, resolveLocale, setLocale } from './index';
import type { LanguageSetting, Locale } from './types';

let systemTag: Promise<string> | null = null;
let switchSeq = 0;
let unbindSettings: (() => void) | undefined;

/** 系统 UI 语言（BCP-47，如 'zh-CN'）；后端不可用时回退 navigator.language。结果缓存 */
export function systemLocaleTag(): Promise<string> {
  systemTag ??= ipc.systemLocale().catch((e: unknown) => {
    console.warn('[i18n] system_locale failed, using navigator.language', e);
    return navigator.language;
  });
  return systemTag;
}

/** 当前设置值；非法值按 'system' 处理 */
export function languageSetting(): LanguageSetting {
  const v = getSetting('workbench.language');
  return (LOCALES as readonly string[]).includes(v) ? (v as Locale) : 'system';
}

/** 设置值 → 实际语言（'system' 经系统语言映射） */
export async function resolveLanguage(v: LanguageSetting = languageSetting()): Promise<Locale> {
  return v === 'system' ? resolveLocale(await systemLocaleTag()) : v;
}

/** 在 loadSettings() 之后、mountUI() 之前调用，避免首屏先显示中文再切换 */
export async function initLanguage(): Promise<void> {
  // 在等待系统语言前监听设置：较早的 system 解析不可覆盖较新的显式选择。
  unbindSettings?.();
  const apply = async () => {
    const seq = ++switchSeq;
    const next = await resolveLanguage();
    if (seq === switchSeq) await setLocale(next);
  };
  unbindSettings = events.on('settings.changed', ({ key }) => {
    if (key === 'workbench.language') void apply();
  });
  await apply();
}
