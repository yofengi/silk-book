// i18n 类型：Key 由 zh-CN（唯一来源）推导，t('...') 在编译期校验键名；
// 其他语言必须完整覆盖 zh-CN 的结构（值放宽为任意字符串），运行时仍保留中文回退。
import type { zhCN } from './locales/zh-CN';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** 全部合法键，如 'menu.file.open'、'cmd.file.save' */
export type Key = Leaves<typeof zhCN>;

type Loose<T> = { [K in keyof T]: T[K] extends string ? string : Loose<T[K]> };
/** 非默认语言包的类型：新增键时必须同时补齐全部翻译 */
export type LocaleMessages = Loose<typeof zhCN>;

export type Locale = 'zh-CN' | 'en' | 'zh-TW' | 'ja';
/** workbench.language 的取值 */
export type LanguageSetting = 'system' | Locale;
export type Params = Record<string, string | number>;
