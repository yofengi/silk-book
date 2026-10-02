// Mock IPC：内存文件系统 + 浏览器文件选择器。用于后端未就绪时的开发与浏览器调试。
import { t } from '../i18n';
import { validExts, type Eol, type FileStat, type IpcApi, type IpcError, type QuitRequest, type ReadResult, type SettingsChanged, type UpdateTransferState } from './types';

interface MockFile {
  bytes: Uint8Array;
  mtime: number;
}

const files = new Map<string, MockFile>();
const mockAssoc = new Set<string>();
const mockThemes = new Map<string, Record<string, unknown>>();
const cancelled = new Set<string>();
const SETTINGS_KEY = 'boshu.settings';
const CHUNK = 4 * 1024 * 1024;
// 多窗口 mock：浏览器中只有一个窗口（label 'main'）；transfer 为内存一次性 token
const mockTransfers = new Map<string, Uint8Array>();
let transferSeq = 0;
const settingsListeners: ((e: SettingsChanged) => void)[] = [];
let settingsRevision = 0;
const quitListeners: ((e: QuitRequest) => void)[] = [];
const quitApprovedListeners: ((e: QuitRequest) => void)[] = [];
const quitCancelledListeners: ((e: QuitRequest) => void)[] = [];
const busListeners = new Map<string, ((payload: unknown) => void)[]>();
const idleUpdateTransfer = (): UpdateTransferState => ({
  revision: 0, taskId: null, phase: 'idle', release: null, source: 'manual', mode: 'download-only',
  downloadedBytes: 0, totalBytes: null, error: null,
});

function err(kind: string, message: string): IpcError {
  return { kind, message };
}

function detectEol(bytes: Uint8Array): Eol {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13) {
      if (bytes[i + 1] === 10) { crlf++; i++; } else cr++;
    } else if (bytes[i] === 10) lf++;
  }
  if ((lf ? 1 : 0) + (crlf ? 1 : 0) + (cr ? 1 : 0) > 1) return 'MIXED';
  return crlf ? 'CRLF' : cr ? 'CR' : 'LF';
}

function pickFiles(multiple: boolean, accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export const mockIpc: IpcApi = {
  updateInfo: async () => ({ currentVersion: '0.1.0', platform: 'Browser preview', repositoryUrl: 'https://github.com/yofengi/silk-book', transfer: idleUpdateTransfer() }),
  async checkUpdates() { throw err('unsupported', 'update checking requires the desktop application'); },
  async onUpdatesChecked() { /* 浏览器无后端共享更新事件 */ },
  updatesTransfer: async () => idleUpdateTransfer(),
  async downloadUpdate() { throw err('unsupported', 'update downloading requires the desktop application'); },
  async installUpdate() { throw err('unsupported', 'update installation requires the desktop application'); },
  async onUpdateTransfer() { /* 浏览器无原生下载进度 */ },
  async onUpdateReady() { /* 浏览器不自动弹出安装提示 */ },
  async openUpdateLink(target) {
    if (target !== 'repository') throw err('unsupported', 'no release was checked in the browser preview');
    window.open('https://github.com/yofengi/silk-book', '_blank', 'noopener,noreferrer');
  },
  async fileStat(path): Promise<FileStat> {
    const f = files.get(path);
    if (!f) throw err('io', `not found: ${path}`);
    return { size: f.bytes.length, mtime: f.mtime, readonly: false };
  },

  async readFile(path, requestId, handlers): Promise<ReadResult> {
    const f = files.get(path);
    if (!f) throw err('io', `not found: ${path}`);
    const b = f.bytes;
    const hasBom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    const body = hasBom ? b.subarray(3) : b;
    for (let off = 0; off < body.length; off += CHUNK) {
      if (cancelled.delete(requestId)) throw err('cancelled', 'read cancelled');
      handlers.onChunk(body.subarray(off, off + CHUNK));
      handlers.onProgress?.({ read: Math.min(off + CHUNK, body.length), total: body.length });
      await new Promise((r) => setTimeout(r, 0));
    }
    return { encoding: 'UTF-8', eol: detectEol(body), hasBom, size: b.length, malformed: false };
  },

  async listEncodings() {
    return [
      { id: 'utf-8', label: 'UTF-8', group: 'Unicode', bom: false },
      { id: 'utf-8-bom', label: 'UTF-8', group: 'Unicode', bom: true },
      { id: 'utf-16le', label: 'UTF-16 LE', group: 'Unicode', bom: false },
      { id: 'utf-16le-bom', label: 'UTF-16 LE', group: 'Unicode', bom: true },
      { id: 'utf-16be', label: 'UTF-16 BE', group: 'Unicode', bom: false },
      { id: 'utf-16be-bom', label: 'UTF-16 BE', group: 'Unicode', bom: true },
      { id: 'gbk', label: 'GBK', group: 'Chinese', bom: false },
      { id: 'ansi', label: 'ANSI (CP936, GBK)', group: 'System', bom: false },
      { id: 'gb18030', label: 'GB18030', group: 'Chinese', bom: false },
      { id: 'big5', label: 'Big5', group: 'Chinese', bom: false },
      { id: 'shift_jis', label: 'Shift_JIS', group: 'Japanese', bom: false },
      { id: 'windows-1252', label: 'Windows-1252', group: 'Western', bom: false },
    ];
  },
  async ansiEncoding() { return { codePage: 936, id: 'gbk' }; },
  async spellCheck() { throw err('unsupported', 'spell check unavailable in mock'); },
  async revealItemInDir(path) { console.info('[mock] reveal', path); },

  async cancelRead(requestId) {
    cancelled.add(requestId);
    return true;
  },

  async writeFile(bytes, opts) {
    // mock 仅支持 UTF-8，按 EOL/BOM 还原
    let text = new TextDecoder().decode(bytes);
    if (opts.eol !== 'LF') text = text.replace(/\n/g, '\r\n');
    const body = new TextEncoder().encode(text);
    const out = opts.bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...body]) : body;
    files.set(opts.path, { bytes: out, mtime: Date.now() });
    return { bytesWritten: out.length };
  },

  async settingsLoad() {
    return localStorage.getItem(SETTINGS_KEY);
  },

  async settingsSave(json) {
    localStorage.setItem(SETTINGS_KEY, json);
  },

  async openDialog(opts) {
    const accept = (opts?.filters ?? []).flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    const picked = await pickFiles(!!opts?.multiple, accept);
    const paths: string[] = [];
    for (const file of picked) {
      const path = `mock://${file.name}`;
      files.set(path, { bytes: new Uint8Array(await file.arrayBuffer()), mtime: file.lastModified });
      paths.push(path);
    }
    return paths;
  },

  async saveDialog(opts) {
    const name = window.prompt(t('dev.mockSaveAs'), opts?.defaultPath?.replace(/^mock:\/\//, '') ?? 'untitled.txt');
    return name ? `mock://${name}` : null;
  },

  async confirm(message) {
    return window.confirm(message);
  },

  async allowAssetDir() { /* 浏览器无 asset 协议 */ },
  assetUrl: () => null,
  async openExternal(url) { window.open(url, '_blank', 'noopener,noreferrer'); },
  osBuild: async () => 0,
  bundledFonts: async () => [],
  listSystemFonts: async () => ['Arial', 'Cascadia Code', 'Consolas', 'Microsoft YaHei UI', 'Segoe UI', 'Segoe UI Variable Text'],
  async fileAssocStatus(exts) {
    return validExts(exts).map((ext) => ({ ext, registered: mockAssoc.has(ext), isDefault: null }));
  },
  async fileAssocRegister(exts) { for (const e of validExts(exts)) mockAssoc.add(e); },
  async fileAssocUnregister(exts) { for (const e of validExts(exts)) mockAssoc.delete(e); },
  async openDefaultAppsSettings() { /* 浏览器无系统设置 */ },
  async onOpenFiles() { /* 无第二实例 */ },
  async themesList() {
    return [...mockThemes].map(([id, json]) => ({ id, fileName: `${id}.json`, json }));
  },
  async themeImport(sourcePath) {
    const f = files.get(sourcePath);
    if (!f) throw err('io', `not found: ${sourcePath}`);
    const json: unknown = JSON.parse(new TextDecoder().decode(f.bytes));
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw err('invalidArgument', 'theme must be a JSON object');
    const stem = sourcePath.replace(/^mock:\/\//, '').replace(/\.json$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'theme';
    let id = stem;
    for (let n = 2; mockThemes.has(id); n++) id = `${stem}-${n}`;
    mockThemes.set(id, json as Record<string, unknown>);
    return { id, json: json as Record<string, unknown> };
  },
  async themeDelete(id) { mockThemes.delete(id); },
  systemLocale: async () => navigator.language,
  windowInit: async () => ({ files: [] }),
  async windowReady() { /* 浏览器页面已经可见；保持相同就绪协议 */ },
  async windowStartupFailed() { /* 错误页面由前端渲染 */ },
  async windowOpen() {
    // 浏览器中无法新建原生窗口；调用方据此回退（保留在当前窗口）
    throw { kind: 'unsupported', message: 'window_open is not available in the browser mock' } satisfies IpcError;
  },
  windowDropTarget: async () => null,
  async transferPut(bytes) {
    const token = `mock-${++transferSeq}`;
    mockTransfers.set(token, bytes);
    return token;
  },
  async transferTake(token) {
    const b = mockTransfers.get(token);
    mockTransfers.delete(token);
    if (!b) throw { kind: 'notFound', message: 'transfer token expired' } satisfies IpcError;
    return b;
  },
  async transferSend() { throw err('unsupported', 'no recipient window in browser mock'); },
  async transferAccept() { throw err('unsupported', 'no recipient window in browser mock'); },
  transferStatus: async (token) => ({ state: mockTransfers.has(token) ? 'pending' : 'missing' }),
  async transferCancel(token) { mockTransfers.delete(token); },
  async transferReject(token) { mockTransfers.delete(token); },
  async settingsPatch(patch) {
    let value: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
    } catch { /* 损坏时视为空 */ }
    Object.assign(value, patch.set ?? {});
    for (const k of patch.remove ?? []) delete value[k];
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value, null, 2));
    const revision = ++settingsRevision;
    const e: SettingsChanged = { value: { ...value }, source: 'main', revision };
    queueMicrotask(() => { for (const fn of settingsListeners) fn(e); });
    return { value, revision };
  },
  async onSettingsChanged(fn) { settingsListeners.push(fn); },
  async requestQuit() {
    const e = { requestId: `mock-quit-${Date.now()}` };
    queueMicrotask(() => { for (const fn of quitListeners) fn(e); });
  },
  async replyQuit(requestId, allow) {
    const listeners = allow ? quitApprovedListeners : quitCancelledListeners;
    queueMicrotask(() => { for (const fn of listeners) fn({ requestId }); });
  },
  async onQuitRequested(fn) { quitListeners.push(fn); },
  async onQuitApproved(fn) { quitApprovedListeners.push(fn); },
  async onQuitCancelled(fn) { quitCancelledListeners.push(fn); },
  bus: {
    label: 'main',
    otherLabels: async () => [],
    async send() { /* 单窗口：无其他窗口 */ },
    async on(event, fn) {
      const list = busListeners.get(event) ?? [];
      list.push(fn as (payload: unknown) => void);
      busListeners.set(event, list);
    },
    outerRect: async () => null,
    innerOrigin: async () => ({ x: window.screenX, y: window.screenY, scale: window.devicePixelRatio || 1 }),
    cursor: async () => ({ x: 0, y: 0 }),
  },

  window: {
    async minimize() { /* no-op */ },
    async toggleMaximize() { /* no-op */ },
    isMaximized: async () => false,
    async close() { /* 浏览器中不关闭 */ },
    async destroy() { /* 浏览器中不关闭 */ },
    async onResized(fn) { window.addEventListener('resize', fn); },
    async onFocusChanged(fn) {
      window.addEventListener('focus', () => fn(true));
      window.addEventListener('blur', () => fn(false));
    },
    async onCloseRequested() { /* 浏览器无关闭协议 */ },
    setMaterial: async () => false,
    async setTitle(title) { document.title = title; },
    async focus() { window.focus(); },
    async startDragging() { /* 浏览器无原生窗口拖动 */ },
  },
};
