// 真实 Tauri 实现：命令名/参数/消息格式严格按 docs/IPC.md。
import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Effect, EffectState, Window, cursorPosition, getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { emitTo } from '@tauri-apps/api/event';
import { confirm as dlgConfirm, open, save } from '@tauri-apps/plugin-dialog';
import { productName } from '../i18n';
import {
  validExts, type AnsiEncoding, type BundledFont, type EncodingInfo, type FileAssocStatus, type FileStat, type ImportedTheme, type IpcApi, type ReadDone, type ReadResult,
  type QuitRequest, type SettingsChanged, type SettingsSnapshot, type ThemeEntry, type TransferStatus, type WindowInit, type WriteResult,
  type UpdateCheckResult, type UpdateInfo, type UpdateReady, type UpdateTransferState,
} from './types';

// 注意：全局 listen() 的 target 为 Any，会收到 emit_to 发给其他窗口的事件；
// 只收本窗口事件须用 WebviewWindow.listen（target = WebviewWindow{label}）。
const self = () => getCurrentWebviewWindow();
async function listenSelf<T>(event: string, fn: (payload: T) => void): Promise<void> {
  await self().listen<T>(event, (e) => fn(e.payload));
}

interface Progress {
  kind: 'progress';
  requestId: string;
  bytesRead: number;
  totalBytes: number;
}
type ReadMessage = ArrayBuffer | Progress | ReadDone;

export const tauriIpc: IpcApi = {
  updateInfo: () => invoke<UpdateInfo>('updates_info'),
  checkUpdates: (manual) => invoke<UpdateCheckResult | null>('updates_check', { manual }),
  onUpdatesChecked: (fn) => listenSelf<UpdateCheckResult>('updates-checked', fn),
  updatesTransfer: () => invoke<UpdateTransferState>('updates_transfer'),
  downloadUpdate: (version, mode) => invoke<UpdateTransferState>('updates_download', { version, mode }),
  installUpdate: (taskId) => invoke<void>('updates_install', { taskId }),
  onUpdateTransfer: (fn) => listenSelf<UpdateTransferState>('updates-state-changed', fn),
  onUpdateReady: (fn) => listenSelf<UpdateReady>('updates-ready', fn),
  openUpdateLink: (target, version) => invoke<void>('updates_open', { target, version: version ?? null }),
  // mtime：Unix 毫秒
  fileStat: (path) => invoke<FileStat>('file_stat', { path }),

  async readFile(path, requestId, handlers, encoding) {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const channel = new Channel<ReadMessage>((msg) => {
      if (msg instanceof ArrayBuffer) handlers.onChunk(new Uint8Array(msg));
      else if (msg && msg.kind === 'progress') handlers.onProgress?.({ read: msg.bytesRead, total: msg.totalBytes });
      else if (msg && msg.kind === 'done' && msg.requestId === requestId) resolveDone();
    });
    const res = await invoke<ReadResult>('read_file', { path, requestId, channel, encoding: encoding ?? 'auto' });
    await done;
    return res;
  },

  cancelRead: (requestId) => invoke<boolean>('cancel_read', { requestId }),

  writeFile(bytes, opts) {
    // 原始 body = [ASCII eolMap 前缀][UTF-8 文本]；非 MIXED 不带前缀
    const map = opts.eol === 'MIXED' ? (opts.eolMap ?? '') : '';
    if (!/^[CLR]*$/.test(map)) return Promise.reject({ kind: 'invalidArgument', message: 'invalid eolMap' });
    const body = new Uint8Array(map.length + bytes.length);
    for (let i = 0; i < map.length; i++) body[i] = map.charCodeAt(i);
    body.set(bytes, map.length);
    return invoke<WriteResult>('write_file', body, {
      headers: {
        'x-boshu-path': encodeURIComponent(opts.path),
        'x-boshu-encoding': opts.encoding,
        'x-boshu-eol': opts.eol,
        'x-boshu-bom': String(opts.bom),
        'x-boshu-eol-map-length': String(map.length),
        ...(opts.allowLossy ? { 'x-boshu-allow-lossy': 'true' } : {}),
      },
    });
  },

  listEncodings: () => invoke<EncodingInfo[]>('list_encodings'),
  ansiEncoding: () => invoke<AnsiEncoding>('ansi_encoding'),
  spellCheck: (words) => invoke<string[]>('spell_check', { words }),
  revealItemInDir: (path) => revealItemInDir(path),

  // 后端收发 JSON 值；前端接口保持字符串形式
  async settingsLoad() {
    return JSON.stringify(await invoke<unknown>('read_settings'));
  },
  settingsSave: (json) => invoke<void>('write_settings', { settingsValue: JSON.parse(json) as unknown }),

  async openDialog(opts) {
    const r = await open({ multiple: !!opts?.multiple, filters: opts?.filters, directory: false });
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  },

  saveDialog: (opts) => save({ defaultPath: opts?.defaultPath, filters: opts?.filters }),

  confirm: (message, title) => dlgConfirm(message, { title: title ?? productName(), kind: 'warning' }),

  allowAssetDir: (path) => invoke<void>('allow_asset_dir', { path }),
  assetUrl: (absPath) => convertFileSrc(absPath),
  openExternal: (url) => openUrl(url),
  osBuild: () => invoke<number>('os_build'),
  bundledFonts: () => invoke<BundledFont[]>('bundled_fonts'),
  listSystemFonts: () => invoke<string[]>('list_system_fonts'),
  fileAssocStatus: async (exts) => invoke<FileAssocStatus[]>('file_assoc_status', { exts: validExts(exts) }),
  fileAssocRegister: async (exts) => invoke<void>('file_assoc_register', { exts: validExts(exts) }),
  fileAssocUnregister: async (exts) => invoke<void>('file_assoc_unregister', { exts: validExts(exts) }),
  openDefaultAppsSettings: () => invoke<void>('open_default_apps_settings'),
  async onOpenFiles(fn) {
    // 后端 emit_to(webview_window(focused))；须按本窗口 target 监听，否则每个窗口都会收到
    await listenSelf<string[]>('open-files', (p) => { if (Array.isArray(p)) fn(p); });
  },
  themesList: () => invoke<ThemeEntry[]>('themes_list'),
  themeImport: (sourcePath) => invoke<ImportedTheme>('theme_import', { sourcePath }),
  themeDelete: (id) => invoke<void>('theme_delete', { id }),
  systemLocale: () => invoke<string>('system_locale'),
  windowInit: () => invoke<WindowInit>('window_init'),
  windowReady: () => invoke<void>('window_frontend_ready'),
  windowStartupFailed: (message) => invoke<void>('window_startup_failed', { message }),
  windowOpen: (opts) => invoke<string>('window_open', { opts }),
  windowDropTarget: (point) => invoke<string | null>('window_drop_target', point),
  transferPut: (bytes) => invoke<string>('tab_transfer_put', bytes),
  async transferTake(token) {
    return new Uint8Array(await invoke<ArrayBuffer>('tab_transfer_take', { token }));
  },
  transferSend: (token, target, placement) => invoke<void>('tab_transfer_send', { token, target, placement }),
  transferAccept: (token) => invoke<void>('tab_transfer_accept', { token }),
  transferStatus: (token) => invoke<TransferStatus>('tab_transfer_status', { token }),
  transferCancel: (token) => invoke<void>('tab_transfer_cancel', { token }),
  transferReject: (token) => invoke<void>('tab_transfer_reject', { token }),
  settingsPatch: (patch) => invoke<SettingsSnapshot>('settings_patch', { patch }),
  onSettingsChanged: (fn) => listenSelf<SettingsChanged>('settings-changed', (p) => { if (p && typeof p === 'object') fn(p); }),
  requestQuit: () => invoke<void>('app_request_quit'),
  replyQuit: (requestId, allow) => invoke<void>('app_quit_reply', { requestId, allow }),
  onQuitRequested: (fn) => listenSelf<QuitRequest>('quit-requested', fn),
  onQuitApproved: (fn) => listenSelf<QuitRequest>('quit-approved', fn),
  onQuitCancelled: (fn) => listenSelf<QuitRequest>('quit-cancelled', fn),

  bus: {
    // IPC 适配器在普通浏览器中也会被静态 import，不能在模块求值时读取 Tauri metadata。
    get label() { return self().label; },
    async otherLabels() {
      const me = self().label;
      return (await getAllWindows()).map((w) => w.label).filter((l) => l !== me);
    },
    send: (label, event, payload) => emitTo({ kind: 'WebviewWindow', label }, event, payload),
    on: (event, fn) => listenSelf(event, fn),
    async outerRect(label) {
      const w = await Window.getByLabel(label);
      if (!w) return null;
      try {
        if (!(await w.isVisible()) || (await w.isMinimized())) return null;
        const [p, s] = await Promise.all([w.outerPosition(), w.outerSize()]);
        return { x: p.x, y: p.y, width: s.width, height: s.height };
      } catch { return null; }
    },
    async innerOrigin() {
      const w = getCurrentWindow();
      const [p, scale] = await Promise.all([w.innerPosition(), w.scaleFactor()]);
      return { x: p.x, y: p.y, scale };
    },
    async cursor() {
      const p = await cursorPosition();
      return { x: p.x, y: p.y };
    },
  },

  window: {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    isMaximized: () => getCurrentWindow().isMaximized(),
    close: () => getCurrentWindow().close(),
    destroy: () => getCurrentWindow().destroy(),
    async onResized(fn) { await getCurrentWindow().onResized(() => fn()); },
    async onFocusChanged(fn) { await getCurrentWindow().onFocusChanged((e) => fn(e.payload)); },
    // Tauri 在 handler 同步返回前检查 preventDefault；handler 须同步调用它
    async setMaterial(material, theme) {
      const w = getCurrentWindow();
      try {
        // 窗口主题决定 Mica/Acrylic 的着色（DWMWA_USE_IMMERSIVE_DARK_MODE）；不设则跟随系统应用主题，
        // 系统为深色时浅色毛玻璃会变成深灰底。先设主题再设材质。
        await w.setTheme(theme);
        if (material === 'none') { await w.clearEffects(); return true; }
        // Mica 仅 Win11；Acrylic 在 Win10 上拖动卡顿，同样只在 Win11 启用（由调用方按 build 号判断）
        const effect = material === 'acrylic' ? Effect.Acrylic : Effect.Mica;
        await w.setEffects({ effects: [effect], state: EffectState.FollowsWindowActiveState });
        return true;
      } catch { return false; }
    },
    async onCloseRequested(fn) { await getCurrentWindow().onCloseRequested((e) => fn(e)); },
    async setTitle(title) {
      try { await getCurrentWindow().setTitle(title); } catch (e) { console.warn('[window] setTitle failed', e); }
    },
    async focus() {
      const w = getCurrentWindow();
      // 最小化的窗口 set_focus 无效（tao），须先还原（需 core:window:allow-unminimize）
      try { if (await w.isMinimized()) await w.unminimize(); } catch (e) { console.warn('[window] unminimize failed', e); }
      try { await w.setFocus(); } catch (e) { console.warn('[window] focus failed', e); }
    },
    startDragging: () => getCurrentWindow().startDragging(),
  },
};
