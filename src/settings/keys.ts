// 设置 · 快捷键：全部命令表格（标题 / id / 当前绑定），搜索过滤，点击录制新绑定，冲突提示，单项 / 全部恢复默认
import { commandTitle, getCommand, listCommands } from '../core/commands';
import { events } from '../core/events';
import {
  BARE_ALT, commandForKey, defaultKeybindingsFor, formatKey, isOverridden, keybindingsFor, normalizeKey,
  resetAllKeybindings, setKeybindingOverride, setKeyCapture,
} from '../core/keybindings';
import { getLocale, t } from '../i18n';
import { button, group, h, statusLine } from './dom';

/** 录制时只接受带修饰键的组合或功能键，避免把普通字符绑成全局快捷键 */
function acceptable(key: string): boolean {
  if (/^F\d{1,2}$/.test(key.split('+').pop() ?? '')) return true;
  return /^(Ctrl|Alt)\+/.test(key);
}

let recording: { command: string; cell: HTMLElement; restore: () => void } | null = null;

function stopRecording(): void {
  if (!recording) return;
  setKeyCapture(null);
  recording.restore();
  recording = null;
}

/** 命令 id → 当前语言标题（未注册的 id 原样返回） */
function titleOf(id: string): string {
  const c = getCommand(id);
  return c ? commandTitle(c) : id;
}

export function renderKeys(): { el: HTMLElement; dispose(): void } {
  const status = statusLine();
  const search = h('input', {
    class: 'st-input st-search',
    attrs: { type: 'search', placeholder: t('settings.keys.searchPlaceholder'), 'aria-label': t('settings.keys.searchLabel') },
  });
  const tbody = h('tbody');
  const table = h('table', { class: 'st-keys' },
    h('thead', {}, h('tr', {},
      h('th', { text: t('settings.keys.colCommand'), attrs: { scope: 'col' } }),
      h('th', { text: 'ID', attrs: { scope: 'col' } }),
      h('th', { text: t('settings.keys.colKey'), attrs: { scope: 'col' } }),
      h('th', { text: '', attrs: { scope: 'col', 'aria-label': t('settings.keys.colActions') } }),
    )),
    tbody,
  );

  const startRecording = (command: string, keyBtn: HTMLButtonElement) => {
    stopRecording();
    const prev = keyBtn.textContent ?? '';
    keyBtn.textContent = t('settings.keys.recording');
    keyBtn.classList.add('recording');
    keyBtn.setAttribute('aria-pressed', 'true');
    recording = {
      command,
      cell: keyBtn,
      restore: () => {
        keyBtn.textContent = prev;
        keyBtn.classList.remove('recording');
        keyBtn.setAttribute('aria-pressed', 'false');
      },
    };
    setKeyCapture((e) => {
      if (e.key === 'Escape') { stopRecording(); status.set(t('settings.keys.cancelled')); keyBtn.focus(); return; }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        stopRecording();
        setKeybindingOverride(command, null);
        status.set(t('settings.keys.cleared', { title: titleOf(command) }), 'ok');
        return;
      }
      const key = normalizeKey(e);
      if (!key) return; // 仅按下修饰键，继续等待
      if (!acceptable(key)) { status.set(t('settings.keys.needsModifier', { key: formatKey(key) }), 'error'); return; }
      stopRecording();
      const other = commandForKey(key);
      setKeybindingOverride(command, key);
      if (other && other !== command) {
        status.set(t('settings.keys.setWithConflict', { key: formatKey(key), other: titleOf(other) }), 'error');
      } else {
        status.set(t('settings.keys.set', { key: formatKey(key) }), 'ok');
      }
    });
  };

  const render = () => {
    const q = search.value.trim().toLowerCase();
    // 冲突：同一按键被多条命令的“有效绑定”共同声明（用户覆盖与默认并存时出现）
    const claims = new Map<string, string[]>();
    const locale = getLocale();
    const cmds = listCommands().map((c) => ({ c, title: commandTitle(c) }))
      .sort((a, b) => a.title.localeCompare(b.title, locale));
    for (const { c } of cmds) for (const k of keybindingsFor(c.id)) claims.set(k, [...(claims.get(k) ?? []), c.id]);
    const rows = cmds.filter(({ c, title }) => {
      if (!q) return true;
      const keys = keybindingsFor(c.id).map(formatKey).join(' ').toLowerCase();
      return title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || keys.includes(q);
    }).map(({ c, title }) => {
      const keys = keybindingsFor(c.id);
      const overridden = isOverridden(c.id);
      const conflict = keys.some((k) => (claims.get(k)?.length ?? 0) > 1 || commandForKey(k) !== c.id);
      const label = keys.length ? keys.map((k) => (k === BARE_ALT ? t('settings.keys.bareAlt') : formatKey(k))).join('  /  ') : '—';
      const keyBtn = h('button', {
        class: `st-keycap${conflict ? ' conflict' : ''}`,
        text: label,
        attrs: { type: 'button', 'aria-pressed': 'false', 'aria-label': t('settings.keys.keyCellLabel', { title, keys: label }) },
      });
      keyBtn.addEventListener('click', () => startRecording(c.id, keyBtn));
      const reset = button(t('common.resetDefault'), () => {
        setKeybindingOverride(c.id, undefined);
        const d = defaultKeybindingsFor(c.id);
        const keysText = d.length ? d.map(formatKey).join(' / ') : t('settings.keys.noKey');
        status.set(t('settings.keys.restored', { title, keys: keysText }), 'ok');
      }, 'st-btn st-btn-small');
      reset.disabled = !overridden;
      const tr = h('tr', { class: overridden ? 'overridden' : '' },
        h('td', { class: 'st-key-title' }, title, overridden ? h('span', { class: 'st-badge on', text: t('settings.keys.modified') }) : null),
        h('td', { class: 'st-key-id', text: c.id }),
        h('td', {}, keyBtn, conflict ? h('span', { class: 'st-warn', text: t('settings.keys.conflict'), attrs: { title: t('settings.keys.conflictTip') } }) : null),
        h('td', {}, reset),
      );
      return tr;
    });
    tbody.replaceChildren(...rows);
    if (!rows.length) tbody.append(h('tr', {}, h('td', { class: 'st-empty', text: t('settings.keys.noMatch'), attrs: { colspan: '4' } })));
  };

  search.addEventListener('input', render);
  const off = events.on('keybindings.changed', render);
  render();

  const resetAll = button(t('settings.keys.resetAll'), () => {
    stopRecording();
    resetAllKeybindings();
    status.set(t('settings.keys.resetAllDone'), 'ok');
  });

  const el = h('div', {},
    group(t('settings.section.keys'), t('settings.keys.desc'),
      h('div', { class: 'st-keys-bar' }, search, resetAll),
      status.el,
      h('div', { class: 'st-table-wrap' }, table),
    ),
  );
  return { el, dispose: () => { stopRecording(); off(); } };
}
