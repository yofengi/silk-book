// 编辑器相关命令注册
import { openSearchPanel, replaceNext, findNext } from '@codemirror/search';
import { registerCommand } from '../core/commands';
import { registerKeybinding } from '../core/keybindings';
import { getSetting, setSetting } from '../core/settings';
import { t } from '../i18n';
import { ipc } from '../ipc';
import { baseName } from './document';
import { clearRecent, newUntitled, openPath, reloadTab, saveTab } from './files';
import type { Eol, TransferPlacement } from '../ipc';
import { loadEncodings, resolveAnsi } from './encodings';
import { languages } from './languages';
import { openPicker, openRecentPicker } from '../ui/palette';
import { isTransferring, moveTabToExistingWindow, moveTabToNewWindow } from './transfer';
import {
  activateTab, activeSpecial, activeTab, allTabIds, applyLanguage, closeTab, getView, listSpecialTabs, listTabs, moveTab, setFlag, updateDocInfo,
} from './tabs';

const hasTab = () => !!activeTab();

async function confirmClose(id: string): Promise<boolean> {
  const tab = listTabs().find((x) => x.id === id);
  if (!tab || isTransferring(id)) return false;
  if (tab.doc.dirty) {
    const ok = await ipc.confirm(t('files.closeDirtyConfirm', { name: baseName(tab.doc.path) }));
    if (!ok) return false;
  }
  closeTab(id);
  exitIfEmpty();
  return true;
}

/** window.closeLastTabExits：关掉最后一个标签后关闭窗口（走 window.close，仍经过关闭确认） */
function exitIfEmpty(): void {
  if (getSetting('window.closeLastTabExits') && allTabIds().length === 0) void ipc.window.close();
}

const EOLS: Eol[] = ['CRLF', 'LF', 'CR'];
const hasFile = () => !!activeTab()?.doc.path;

export function registerEditorCommands(): void {
  registerCommand({ id: 'file.new', title: () => t('cmd.file.new'), run: () => void newUntitled() });
  registerCommand({
    id: 'file.open', title: () => t('cmd.file.open'),
    run: async (_c, args) => {
      const opts = args && typeof args === 'object' ? args as { paths?: string[]; here?: boolean } : undefined;
      const paths = typeof args === 'string' ? [args] : opts?.paths ?? await ipc.openDialog({ multiple: true });
      if (!paths.length) return;
      for (const p of paths) {
        if (!opts?.here && getSetting('window.openFilesInNewWindow')) {
          try { await ipc.windowOpen({ files: [p] }); continue; }
          catch (e) { console.warn('new-window open failed, opening here', e); }
        }
        await openPath(p);
      }
    },
  });
  registerCommand({ id: 'file.openRecent', title: () => t('cmd.file.openRecent'), run: openRecentPicker });
  registerCommand({ id: 'file.save', title: () => t('cmd.file.save'), when: hasTab, run: () => { const t = activeTab(); return t && saveTab(t); } });
  registerCommand({ id: 'file.saveAs', title: () => t('cmd.file.saveAs'), when: hasTab, run: () => { const t = activeTab(); return t && saveTab(t, true); } });
  // 文件标签页与特殊标签页（设置）都可关闭 / 循环；特殊标签页无未保存状态，直接关闭
  const anyTab = () => hasTab() || !!activeSpecial();
  registerCommand({
    id: 'tab.close', title: () => t('cmd.tab.close'),
    when: anyTab,
    run: (_c, args) => {
      const id = typeof args === 'string' ? args : (activeTab()?.id ?? activeSpecial()?.id ?? '');
      if (listSpecialTabs().some((s) => s.id === id)) { closeTab(id); exitIfEmpty(); return true; }
      return confirmClose(id);
    },
  });
  registerCommand({ id: 'tab.activate', title: () => t('cmd.tab.activate'), run: (_c, args) => typeof args === 'string' && activateTab(args) });
  registerCommand({
    id: 'tab.reorder', title: () => t('cmd.tab.reorder'),
    run: (_c, args) => {
      if (!args || typeof args !== 'object') {
        const current = activeTab()?.id ?? activeSpecial()?.id;
        if (!current) return;
        const items = allTabIds().map((id, index) => {
          const file = listTabs().find((tab) => tab.id === id);
          const special = listSpecialTabs().find((tab) => tab.id === id);
          return { label: `${index + 1}. ${file ? baseName(file.doc.path) : special?.title() ?? id}`, value: String(index) };
        });
        openPicker(items, (value) => moveTab(current, Number(value)), t('cmd.tab.reorder'));
        return;
      }
      const { id, index } = args as { id: string; index: number };
      if (typeof id === 'string' && Number.isInteger(index)) moveTab(id, index);
    },
  });
  registerCommand({
    id: 'tab.moveToNewWindow', title: () => t('cmd.tab.moveToNewWindow'), when: hasTab,
    run: (_c, args) => {
      const opts = args && typeof args === 'object' ? args as { id?: string; x?: number; y?: number; target?: string; placement?: TransferPlacement } : undefined;
      const id = typeof args === 'string' ? args : opts?.id ?? activeTab()?.id;
      const position = typeof opts?.x === 'number' && typeof opts.y === 'number' ? { x: opts.x, y: opts.y } : undefined;
      return id ? typeof opts?.target === 'string'
        ? moveTabToExistingWindow(id, opts.target, opts.placement)
        : moveTabToNewWindow(id, position) : false;
    },
  });
  const cycle = (d: number) => () => {
    const ids = allTabIds();
    const cur = activeTab()?.id ?? activeSpecial()?.id;
    const i = ids.findIndex((id) => id === cur);
    if (ids.length) activateTab(ids[(i + d + ids.length) % ids.length]);
  };
  registerCommand({ id: 'tab.next', title: () => t('cmd.tab.next'), when: anyTab, run: cycle(1) });
  registerCommand({ id: 'tab.prev', title: () => t('cmd.tab.prev'), when: anyTab, run: cycle(-1) });

  registerCommand({ id: 'view.toggleMinimap', title: () => t('cmd.view.toggleMinimap'), when: hasTab, run: () => { const t = activeTab(); if (t) setFlag(t, 'minimap', !t.flags.minimap); } });
  registerCommand({ id: 'editor.toggleWordCompletion', title: () => t('cmd.editor.toggleWordCompletion'), when: hasTab, run: () => { const t = activeTab(); if (t) setFlag(t, 'wordCompletion', !t.flags.wordCompletion); } });
  registerCommand({ id: 'view.toggleLineWrap', title: () => t('cmd.view.toggleLineWrap'), when: hasTab, run: () => setSetting('editor.wordWrap', !getSetting('editor.wordWrap')) });

  const withView = (fn: (v: NonNullable<ReturnType<typeof getView>>) => unknown) => () => { const v = getView(); if (v) fn(v); };
  registerCommand({ id: 'editor.find', title: () => t('cmd.editor.find'), when: hasTab, run: withView(openSearchPanel) });
  registerCommand({ id: 'editor.replace', title: () => t('cmd.editor.replace'), when: hasTab, run: withView((v) => { openSearchPanel(v); v.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]')?.focus(); }) });
  registerCommand({ id: 'editor.findNext', title: () => t('cmd.editor.findNext'), when: hasTab, run: withView(findNext) });
  registerCommand({ id: 'editor.replaceNext', title: () => t('cmd.editor.replaceNext'), when: hasTab, run: withView(replaceNext) });

  registerCommand({
    id: 'editor.setLanguage', title: () => t('cmd.editor.setLanguage'), when: hasTab,
    run: async (_c, args) => {
      const tab = activeTab();
      if (!tab) return;
      if (typeof args === 'string') return applyLanguage(tab, args);

      openPicker(
        [{ label: t('lang.plaintext'), value: 'plaintext' }, ...languages.map((l) => ({ label: l.name, value: l.id }))],
        (id) => void applyLanguage(tab, id),
        t('editor.selectLanguageMode'),
      );
    },
  });

  registerCommand({ id: 'file.reload', title: () => t('cmd.file.reload'), when: hasFile, run: () => { const tb = activeTab(); return tb && reloadTab(tb); } });
  registerCommand({
    id: 'file.copyPath', title: () => t('cmd.file.copyPath'), when: hasFile,
    run: () => { const p = activeTab()?.doc.path; if (p) return navigator.clipboard.writeText(p); },
  });
  registerCommand({
    id: 'file.revealInFolder', title: () => t('cmd.file.revealInFolder'), when: hasFile,
    run: () => { const p = activeTab()?.doc.path; if (p) return ipc.revealItemInDir(p); },
  });
  // 编码选择：args 为 list_encodings 的 id；无参数时弹出选择器
  const pickEncoding = async (placeholder: string, onPick: (id: string) => unknown) => {
    const list = await loadEncodings();
    openPicker(list.map((e) => ({
      label: e.label + (e.bom ? ' BOM' : ''), value: e.id,
      detail: t(e.group === 'Unicode' ? 'statusbar.group.Unicode' : e.group === 'System' ? 'statusbar.group.System' : 'statusbar.group.other'),
    })), (id) => void onPick(id), placeholder);
  };
  registerCommand({
    id: 'file.reopenWithEncoding', title: () => t('cmd.file.reopenWithEncoding'), when: hasFile,
    run: async (_c, args) => {
      const tb = activeTab();
      if (!tb) return;
      if (typeof args === 'string') return reloadTab(tb, args.replace(/-bom$/i, ''));
      return pickEncoding(t('statusbar.selectEncoding'), (id) => reloadTab(tb, id.replace(/-bom$/i, '')));
    },
  });
  registerCommand({
    id: 'file.saveWithEncoding', title: () => t('cmd.file.saveWithEncoding'), when: hasTab,
    run: async (_c, args) => {
      const tb = activeTab();
      if (!tb) return;
      const save = async (id: string) => {
            const info = (await loadEncodings()).find((e) => e.id === id);
        return saveTab(tb, false, { encoding: resolveAnsi(id.replace(/-bom$/i, '')), hasBom: info ? info.bom : /-bom$/i.test(id) });
      };
      if (typeof args === 'string') return save(args);
      return pickEncoding(t('statusbar.selectEncoding'), save);
    },
  });
  registerCommand({
    id: 'editor.setEol', title: () => t('cmd.editor.setEol'), when: hasTab,
    run: (_c, args) => {
      const tb = activeTab();
      if (!tb) return;
      const apply = (v: string) => {
        if (!EOLS.includes(v as Eol) || v === tb.doc.eol) return;
        updateDocInfo(tb, { eol: v as Eol, eolMap: undefined }, true);
      };
      if (typeof args === 'string') return apply(args);
      openPicker(EOLS.map((e) => ({ label: t(`files.eol.${e}`), value: e })), apply, t('statusbar.selectEol'));
    },
  });

  registerCommand({ id: 'file.clearRecent', title: () => t('cmd.file.clearRecent'), when: () => getSetting('files.recent').length > 0, run: clearRecent });

  for (const [key, command] of [
    ['Ctrl+N', 'file.new'], ['Ctrl+O', 'file.open'], ['Ctrl+S', 'file.save'], ['Ctrl+Shift+S', 'file.saveAs'],
    ['Ctrl+R', 'file.openRecent'], ['Ctrl+W', 'tab.close'], ['Ctrl+Tab', 'tab.next'], ['Ctrl+Shift+Tab', 'tab.prev'],
    ['Ctrl+F', 'editor.find'], ['Ctrl+H', 'editor.replace'], ['Alt+Z', 'view.toggleLineWrap'],
  ] as const) registerKeybinding({ key, command });
}
