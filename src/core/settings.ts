// 前端配置：schema + 默认值；Rust 只读写 JSON，不理解字段。未知字段原样保留。
import { ipc, type SettingsSnapshot } from '../ipc';
import { events } from './events';

const MB = 1024 * 1024;

export const settingsSchema = {
  'updates.intervalHours': { type: 'number', default: 24, values: [1, 24, 168, 720] },
  'updates.lastCheckedAt': { type: 'number', default: 0 },
  'updates.ignoredVersion': { type: 'string', default: '' as string },
  'files.largeFileThreshold': { type: 'number', default: 10 * MB },
  'files.hugeFileThreshold': { type: 'number', default: 100 * MB },
  'files.readChunkSize': { type: 'number', default: 4 * MB },
  'files.recentMax': { type: 'number', default: 20 },
  'files.recent': { type: 'string[]', default: [] as readonly string[] },
  'editor.prerenderScreens': { type: 'number', default: 3 },
  'editor.minimap': { type: 'boolean', default: true },
  'editor.wordCompletion': { type: 'boolean', default: true },
  /** 自动换行（全局）；旧键 editor.lineWrap 在加载时迁移 */
  'editor.wordWrap': { type: 'boolean', default: false },
  'editor.tabSize': { type: 'number', default: 4 },
  'editor.spellcheck': { type: 'boolean', default: false },
  'editor.highlightActiveLine': { type: 'boolean', default: true },
  'editor.lineNumbers': { type: 'boolean', default: true },
  /** 'tab' | 'spaces2' | 'spaces4' | 'spaces8'；同时决定缩进单位 */
  'editor.tabBehavior': { type: 'string', default: 'tab' as string, values: ['tab', 'spaces2', 'spaces4', 'spaces8'] },
  /** 复制时裁剪首尾空白与空行（不影响剪切） */
  'editor.smartCopy': { type: 'boolean', default: false },
  /** 'CRLF' | 'LF' | 'CR' */
  'files.defaultEol': { type: 'string', default: 'CRLF' as string, values: ['CRLF', 'CR', 'LF'] },
  /** 'utf-8' | 'utf-8-bom' | 'utf-16le-bom' | 'utf-16be-bom' | 'ansi' */
  'files.defaultEncoding': { type: 'string', default: 'utf-8' as string, values: ['utf-8', 'utf-8-bom', 'utf-16le-bom', 'utf-16be-bom', 'ansi'] },
  /** 'auto' | 'utf-8' | 'ansi'；BOM 始终优先 */
  'files.readEncoding': { type: 'string', default: 'auto' as string, values: ['auto', 'utf-8', 'ansi'] },
  'workbench.statusBar': { type: 'boolean', default: true },
  'window.rememberSize': { type: 'boolean', default: true },
  'window.openFilesInNewWindow': { type: 'boolean', default: false },
  'window.closeLastTabExits': { type: 'boolean', default: false },
  'workbench.theme': { type: 'string', default: 'glass-system' as string },
  'workbench.glassMaterial': { type: 'string', default: 'acrylic' as string },
  /** 界面语言：'system' | 'zh-CN' | 'en' | 'zh-TW' | 'ja'；'system' 经 ipc.systemLocale() 映射 */
  'workbench.language': { type: 'string', default: 'system' as string, values: ['system', 'zh-CN', 'en', 'zh-TW', 'ja'] },
  'markdown.previewDebounce': { type: 'number', default: 150 },
  /** 代码字体族（单个族名或 CSS font-family 列表）；回退栈由 themes/fonts.ts 追加 */
  'editor.fontFamily': { type: 'string', default: 'Maple Mono NF CN' as string },
  'editor.fontSize': { type: 'number', default: 14 },
  'editor.lineHeight': { type: 'number', default: 1.5 },
  /** 界面字体；空字符串 = 默认（Segoe UI Variable / Microsoft YaHei UI） */
  'workbench.fontFamily': { type: 'string', default: '' as string },
  'workbench.fontSize': { type: 'number', default: 13 },
  /** 快捷键覆盖：{ [commandId]: 'Ctrl+K' | null }；null = 移除默认绑定 */
  keybindings: { type: 'record', default: {} as Readonly<Record<string, string | null>> },
} as const;

type Schema = typeof settingsSchema;
export type SettingKey = keyof Schema;
type Widen<T> = T extends number ? number : T extends boolean ? boolean : T extends readonly string[] ? string[]
  : T extends Readonly<Record<string, string | null>> ? Record<string, string | null> : T;
export type SettingValue<K extends SettingKey> = Widen<Schema[K]['default']>;

let raw: Record<string, unknown> = {};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let flushPromise: Promise<void> | null = null;
let watchPromise: Promise<void> | null = null;
let latestSnapshot: SettingsSnapshot | null = null;
const SAVE_DEBOUNCE_MS = 300;
const SAVE_RETRY_MS = 1000;

function valid(key: SettingKey, v: unknown): boolean {
  const schema = settingsSchema[key];
  const t = schema.type;
  if ('values' in schema && !(schema.values as readonly unknown[]).includes(v)) return false;
  if (t === 'string[]') return Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (t === 'record') {
    return !!v && typeof v === 'object' && !Array.isArray(v)
      && Object.values(v).every((x) => x === null || typeof x === 'string');
  }
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === t;
}

export function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
  const v = raw[key];
  const def: unknown = settingsSchema[key].default;
  const out = valid(key, v) ? v : def;
  if (Array.isArray(out)) return [...(out as string[])] as SettingValue<K>;
  if (out && typeof out === 'object') return { ...(out as Record<string, string | null>) } as SettingValue<K>;
  return out as SettingValue<K>;
}

/** 恢复默认：删除该键（保存时不写入），并广播变更 */
export function resetSetting(key: SettingKey): void {
  delete raw[key];
  pending.set(key, { op: 'remove' });
  events.emit('settings.changed', { key });
  scheduleSave();
}

// 多窗口：只按键写入（settings_patch），避免整文件覆盖其他窗口的修改。
// pending = 本窗口尚未发出的修改；inflight = 已发出、尚未返回的修改。
// 收到其他窗口的 settings-changed 时，这两类键保留本地值，其余键以文件为准。
type Op = { op: 'set'; value: unknown } | { op: 'remove' };
const pending = new Map<string, Op>();
const inflight = new Set<string>();

function scheduleSave(delay = SAVE_DEBOUNCE_MS): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushSettings().catch((e: unknown) => console.error('settings save failed', e));
  }, delay);
}

/** 立即写出未保存的设置修改；等待同一窗口的全部待写键，失败保留修改并向调用方报告。 */
export function flushSettings(): Promise<void> {
  clearTimeout(saveTimer);
  if (!flushPromise) {
    flushPromise = (async () => {
      while (pending.size) await writePending();
    })().finally(() => { flushPromise = null; });
  }
  return flushPromise;
}

async function writePending(): Promise<void> {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  const batch = new Map(pending);
  for (const [k, o] of batch) {
    if (o.op === 'set') set[k] = o.value; else remove.push(k);
    inflight.add(k);
  }
  pending.clear();
  try {
    const snapshot = await ipc.settingsPatch({ set, remove });
    inflight.clear();
    receiveSnapshot(snapshot);
    // 已发出的本地键释放后，应重新应用最新远端值（远端可能比本次响应更晚提交）。
    if (latestSnapshot) applyRemote(latestSnapshot.value);
  } catch (e) {
    for (const [key, op] of batch) if (!pending.has(key)) pending.set(key, op);
    inflight.clear();
    scheduleSave(SAVE_RETRY_MS);
    throw e;
  }
}

function receiveSnapshot(snapshot: SettingsSnapshot): void {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || !snapshot.value || typeof snapshot.value !== 'object' || Array.isArray(snapshot.value)) return;
  if (latestSnapshot && snapshot.revision < latestSnapshot.revision) return;
  latestSnapshot = { value: { ...snapshot.value }, revision: snapshot.revision };
  applyRemote(snapshot.value);
}

/** 以文件内容为准合并（跳过本窗口未落盘的键），逐键广播变化 */
function applyRemote(value: Record<string, unknown>): void {
  const next = normalize({ ...value });
  for (const k of new Set([...pending.keys(), ...inflight])) {
    if (k in raw) next[k] = raw[k]; else delete next[k];
  }
  const changed: string[] = [];
  for (const k of new Set([...Object.keys(raw), ...Object.keys(next)])) {
    if (JSON.stringify(raw[k]) !== JSON.stringify(next[k])) changed.push(k);
  }
  raw = next;
  for (const key of changed) events.emit('settings.changed', { key });
  if (changed.includes('files.recent')) events.emit('recent.changed', undefined);
}

function normalize(obj: Record<string, unknown>): Record<string, unknown> {
  // editor.wordWrap 沿用旧键 editor.lineWrap 的值
  if (!('editor.wordWrap' in obj) && typeof obj['editor.lineWrap'] === 'boolean') obj['editor.wordWrap'] = obj['editor.lineWrap'];
  return obj;
}

/** 先订阅再读取；自身广播也参与版本排序，重复调用不会重复注册。 */
export function watchSettings(): Promise<void> {
  watchPromise ??= ipc.onSettingsChanged(receiveSnapshot).catch((e: unknown) => {
    watchPromise = null;
    throw e;
  });
  return watchPromise;
}

export function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>): void {
  raw[key] = value;
  pending.set(key, { op: 'set', value });
  events.emit('settings.changed', { key });
  scheduleSave();
}

export async function loadSettings(): Promise<void> {
  try {
    await watchSettings();
    const text = await ipc.settingsLoad();
    const parsed: unknown = text ? JSON.parse(text) : {};
    const loaded = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const value = latestSnapshot?.value ?? loaded;
    applyRemote(value);
    // 一次性移除旧键，避免重置 wordWrap 时又被旧键值“复活”。
    if ('editor.lineWrap' in value) {
      if (typeof raw['editor.wordWrap'] === 'boolean' && !pending.has('editor.wordWrap')) {
        pending.set('editor.wordWrap', { op: 'set', value: raw['editor.wordWrap'] });
      }
      delete raw['editor.lineWrap'];
      pending.set('editor.lineWrap', { op: 'remove' });
      scheduleSave();
    }
  } catch (e) {
    console.error('settings load failed, using defaults', e);
    applyRemote(latestSnapshot?.value ?? {});
  }
}
