// 设置 · 常规：文本与编辑器、高级、启动偏好、语言。所有项写入 core/settings，由各模块监听后经 Compartment 实时生效。
import { events } from '../core/events';
import { flushSettings, getSetting, setSetting, type SettingKey } from '../core/settings';
import { encodingName, loadAnsi } from '../editor/encodings';
import { spellcheckUnsupported } from '../editor/spellcheck';
import { t, type Key } from '../i18n';
import { group, h, row, select, toggle, type SelectOption } from './dom';
import { renderLanguageRow } from './language';

type BoolKey = { [K in SettingKey]: ReturnType<typeof getSetting<K>> extends boolean ? K : never }[SettingKey];

export function renderGeneral(): { el: HTMLElement; dispose(): void } {
  const disposers: (() => void)[] = [];
  const refresh = new Map<string, () => void>();
  let disposed = false;
  function boolRow(key: BoolKey, label: Key, hint?: Key, extra?: HTMLElement): HTMLElement {
    const sw = toggle(getSetting(key), (v) => {
      setSetting(key, v);
      if (key === 'window.rememberSize') {
        void flushSettings().catch((error: unknown) => console.error('window preference save failed', error));
      }
    });
    refresh.set(key, () => sw.setAttribute('aria-checked', String(getSetting(key))));
    const r = row(t(label), sw, hint ? t(hint) : undefined);
    if (extra) r.querySelector('.st-row-label')?.append(extra);
    return r;
  }
  function choiceRow(key: SettingKey, label: Key, options: SelectOption[], hint?: Key): { el: HTMLElement; sel: ReturnType<typeof select> } {
    const sel = select(options, String(getSetting(key)), (v) => setSetting(key, v as never));
    refresh.set(key, () => sel.setValue(String(getSetting(key))));
    return { el: row(t(label), sel, hint ? t(hint) : undefined), sel };
  }
  disposers.push(events.on('settings.changed', ({ key }) => refresh.get(key)?.()));

  // 拼写检查不可用：一次性提示（在开关旁）
  const spellNote = h('div', { class: 'st-hint st-hint-warn', text: t('settings.general.spellcheckUnsupported'), attrs: { role: 'status' } });
  spellNote.hidden = !spellcheckUnsupported();
  disposers.push(events.on('spellcheck.unsupported', () => { spellNote.hidden = false; }));

  const wrapRow = boolRow('editor.wordWrap', 'settings.general.wordWrap');

  const eol = choiceRow('files.defaultEol', 'settings.general.defaultEol', [
    { value: 'CRLF', label: t('files.eol.CRLF') },
    { value: 'CR', label: t('files.eol.CR') },
    { value: 'LF', label: t('files.eol.LF') },
  ], 'settings.general.newFilesHint');

  const encOptions = (ansi: string): SelectOption[] => [
    { value: 'utf-8', label: 'UTF-8' },
    { value: 'utf-8-bom', label: 'UTF-8-BOM' },
    { value: 'utf-16le-bom', label: 'UTF-16 LE BOM' },
    { value: 'utf-16be-bom', label: 'UTF-16 BE BOM' },
    { value: 'ansi', label: ansi },
  ];
  const enc = choiceRow('files.defaultEncoding', 'settings.general.defaultEncoding', encOptions('ANSI'), 'settings.general.newFilesHint');
  const read = choiceRow('files.readEncoding', 'settings.general.readEncoding', [
    { value: 'auto', label: t('settings.general.readAuto') },
    { value: 'utf-8', label: 'UTF-8' },
    { value: 'ansi', label: 'ANSI' },
  ]);
  // ANSI 显示实际代码页，如 “ANSI (GBK)”
  void loadAnsi().then((a) => {
    if (!a || disposed) return;
    const name = encodingName('ansi');
    enc.sel.setOptions(encOptions(name));
    read.sel.setOptions([
      { value: 'auto', label: t('settings.general.readAuto') },
      { value: 'utf-8', label: 'UTF-8' },
      { value: 'ansi', label: name },
    ]);
  });

  const tab = choiceRow('editor.tabBehavior', 'settings.general.tabBehavior', (['tab', 'spaces2', 'spaces4', 'spaces8'] as const)
    .map((v) => ({ value: v, label: t(`settings.general.${v}`) })), 'settings.general.tabHint');

  const el = h('div', { class: 'st-general' },
    group(t('settings.general.textEditor'), null,
      wrapRow,
      boolRow('editor.spellcheck', 'settings.general.spellcheck', undefined, spellNote),
      boolRow('editor.highlightActiveLine', 'settings.general.highlightActiveLine'),
      boolRow('editor.lineNumbers', 'settings.general.lineNumbers'),
      eol.el, enc.el, read.el, tab.el,
    ),
    group(t('settings.general.advanced'), null,
      boolRow('workbench.statusBar', 'settings.general.statusBar'),
      boolRow('editor.smartCopy', 'settings.general.smartCopy', 'settings.general.smartCopyHint'),
    ),
    group(t('settings.general.startup'), null,
      boolRow('window.rememberSize', 'settings.general.rememberWindowSize', 'settings.general.rememberWindowSizeHint'),
      boolRow('window.openFilesInNewWindow', 'settings.general.openFilesInNewWindow'),
      boolRow('window.closeLastTabExits', 'settings.general.closeLastTabExits'),
    ),
    group(t('settings.general.languageGroup'), null, renderLanguageRow()),
  );
  return { el, dispose: () => { disposed = true; for (const d of disposers) d(); } };
}
