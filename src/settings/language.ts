// 设置 · 语言选择器（workbench.language）。放在「常规」分组的「语言设置」中。
import { setSetting } from '../core/settings';
import { LOCALE_NAMES, LOCALES, t } from '../i18n';
import { languageSetting, resolveLanguage } from '../i18n/boot';
import { row, select, type SelectOption } from './dom';

/** 一行「语言」下拉框：跟随系统 + 各语言（语言名用其自身书写）。修改后由 i18n/boot 监听设置并实时切换 */
export function renderLanguageRow(): HTMLElement {
  const options = (systemLabel: string): SelectOption[] => [
    { value: 'system', label: systemLabel },
    ...LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] })),
  ];
  // 与「常规」其余下拉栏使用同一套毛玻璃下拉组件
  const dd = select(options(t('settings.language.system')), languageSetting(), (v) => setSetting('workbench.language', v));
  // “跟随系统”附带实际解析出的语言，便于确认
  void resolveLanguage('system').then((l) => {
    dd.setOptions(options(t('settings.language.systemResolved', { name: LOCALE_NAMES[l] })));
  });
  return row(t('settings.language.label'), dd, t('settings.language.hint'));
}
