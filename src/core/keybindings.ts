// 快捷键 → 命令。按键格式：'Ctrl+Shift+P'（修饰键顺序 Ctrl, Alt, Shift）；'Alt' 表示单独轻按 Alt。
// 默认绑定由各模块 registerKeybinding 注册；用户覆盖存于设置 `keybindings`：{ [commandId]: key | null }，
// 覆盖某命令即替换该命令的全部默认按键（null = 无绑定）。覆盖在同一按键上优先于默认绑定。
import { executeCommand, isCommandExecutionBlocked, isEnabled } from './commands';
import { events } from './events';
import { getSetting, setSetting } from './settings';

export interface Keybinding {
  key: string;
  command: string;
  args?: unknown;
}

/** 单独轻按 Alt 的按键名 */
export const BARE_ALT = 'Alt';

const defaults: Keybinding[] = [];
let effective = new Map<string, Keybinding>();

/** release 构建中始终拦截的 WebView 默认行为：刷新、强制刷新、打印 */
const RESERVED = new Set(['F5', 'Ctrl+F5', 'Shift+F5', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+P', 'Ctrl+Shift+P']);

export function normalizeKey(e: KeyboardEvent): string {
  let k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Process', 'Unidentified'].includes(k)) return '';
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (k === ' ') k = 'Space';
  if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

function rebuild(): void {
  const overrides = getSetting('keybindings');
  const next = new Map<string, Keybinding>();
  for (const kb of defaults) if (!(kb.command in overrides)) next.set(kb.key, kb);
  for (const [command, key] of Object.entries(overrides)) if (key) next.set(key, { key, command });
  effective = next;
  events.emit('keybindings.changed', undefined);
}

export function registerKeybinding(kb: Keybinding): void {
  defaults.push(kb);
  rebuild();
}

/** 当前生效的按键（按注册顺序），可能为空 */
export function keybindingsFor(command: string): string[] {
  const out: string[] = [];
  for (const kb of effective.values()) if (kb.command === command) out.push(kb.key);
  return out;
}

/** 主快捷键（用于菜单、命令面板显示）；优先非单独 Alt 的按键 */
export function keybindingFor(command: string): string | undefined {
  const all = keybindingsFor(command);
  return all.find((k) => k !== BARE_ALT) ?? all[0];
}

export function defaultKeybindingsFor(command: string): string[] {
  return defaults.filter((kb) => kb.command === command).map((kb) => kb.key);
}

/** 按键当前绑定的命令 */
export function commandForKey(key: string): string | undefined {
  return effective.get(key)?.command;
}

export function isOverridden(command: string): boolean {
  return command in getSetting('keybindings');
}

/** 设置覆盖：key 为 null 表示移除绑定；undefined 表示恢复默认 */
export function setKeybindingOverride(command: string, key: string | null | undefined): void {
  const o = getSetting('keybindings');
  if (key === undefined) delete o[command];
  else o[command] = key;
  setSetting('keybindings', o);
}

export function resetAllKeybindings(): void {
  setSetting('keybindings', {});
}

let capture: ((e: KeyboardEvent) => void) | null = null;
/** 录制快捷键时接管全部 keydown（全局绑定暂停）；传 null 结束 */
export function setKeyCapture(fn: ((e: KeyboardEvent) => void) | null): void {
  capture = fn;
}

function run(kb: Keybinding, e: Event): boolean {
  if (!isEnabled(kb.command)) return false;
  e.preventDefault();
  e.stopPropagation();
  void executeCommand(kb.command, kb.args);
  return true;
}

/** 在捕获阶段拦截全局快捷键，优先于 CodeMirror 的 keymap */
export function installKeybindings(target: Window = window): void {
  rebuild();
  events.on('settings.changed', ({ key }) => { if (key === 'keybindings') rebuild(); });
  // 单独轻按 Alt：keydown 时布防，期间任何其他按键/鼠标按下都会撤防，keyup 时触发
  let altArmed = false;
  target.addEventListener(
    'keydown',
    (e) => {
      if (isCommandExecutionBlocked()) {
        altArmed = false;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (capture) {
        e.preventDefault();
        e.stopPropagation();
        capture(e);
        return;
      }
      altArmed = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.repeat;
      if (e.isComposing) return; // 输入法组字中不响应快捷键
      const key = normalizeKey(e);
      if (!key) return;
      const kb = effective.get(key);
      if (kb && run(kb, e)) return;
      if (import.meta.env.PROD && RESERVED.has(key)) e.preventDefault();
    },
    true,
  );
  target.addEventListener(
    'keyup',
    (e) => {
      if (isCommandExecutionBlocked()) {
        altArmed = false;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.key !== 'Alt' || !altArmed || capture) return;
      altArmed = false;
      const kb = effective.get(BARE_ALT);
      if (kb) run(kb, e);
    },
    true,
  );
  const disarm = () => { altArmed = false; };
  target.addEventListener('mousedown', disarm, true);
  target.addEventListener('blur', disarm);
}

/** 显示用：'Ctrl+Shift+S' → 'Ctrl+Shift+S'；方向键等转为符号 */
export function formatKey(key: string): string {
  return key
    .replace(/ArrowUp$/, '↑').replace(/ArrowDown$/, '↓').replace(/ArrowLeft$/, '←').replace(/ArrowRight$/, '→');
}
