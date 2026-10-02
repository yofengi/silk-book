import { ipc, isIpcError, type ReleaseInfo, type UpdateCheckResult, type UpdateInfo, type UpdateLink, type UpdateMode, type UpdateReady, type UpdateTransferState } from '../ipc';
import { t } from '../i18n';
import { isCommandExecutionBlocked, registerCommand } from './commands';
import { events } from './events';
import { flushSettings, getSetting, setSetting } from './settings';
import { nextUpdateDelay, shouldNotifyUpdate, updateIntervalHours, UPDATE_START_DELAY_MS } from './update-policy';

export interface UpdateViewState {
  info: UpdateInfo | null;
  result: UpdateCheckResult | null;
  checking: boolean;
  errorKind: string | null;
  transfer: UpdateTransferState | null;
  transferErrorKind: string | null;
  startingDownload: boolean;
  requestingInstall: boolean;
}

const state: UpdateViewState = {
  info: null, result: null, checking: false, errorKind: null,
  transfer: null, transferErrorKind: null, startingDownload: false, requestingInstall: false,
};
// 30 天超过 setTimeout 的 32 位范围：最长只等待一天，然后重算到期时间。
const MAX_TIMER_MS = 24 * 3_600_000;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | null = null;
let initialized = false;
let started = false;
let readyAfter = 0;
let lastLocalAttempt = 0;
let subscriptions: Promise<unknown[]> | null = null;
let pendingReady: UpdateReady | null = null;
const deliveredReady = new Set<string>();

export function getUpdateState(): Readonly<UpdateViewState> { return state; }

export function getUpdateNotification(): UpdateCheckResult | null {
  if (state.transfer?.taskId && state.transfer.release && state.transfer.phase !== 'idle') {
    return { status: 'available', release: state.transfer.release, checkedAt: state.result?.checkedAt ?? 0 };
  }
  return shouldNotifyUpdate(state.result, getSetting('updates.ignoredVersion')) ? state.result : null;
}

export function getUpdateRelease(): ReleaseInfo | null {
  return state.transfer?.taskId && state.transfer.phase !== 'idle' ? state.transfer.release : state.result?.release ?? null;
}

export function isUpdateTransferBusy(transfer = state.transfer): boolean {
  return !!transfer && ['downloading', 'verifying', 'preparingInstall', 'installing'].includes(transfer.phase);
}

function changed(): void { events.emit('updates.changed', undefined); }

function deliverReady(): void {
  const transfer = state.transfer;
  if (!started || isCommandExecutionBlocked() || !pendingReady || !transfer) return;
  if (transfer.revision < pendingReady.revision) return;
  if (transfer.taskId !== pendingReady.taskId || transfer.phase !== 'ready') {
    pendingReady = null;
    return;
  }
  const taskId = pendingReady.taskId;
  pendingReady = null;
  if (deliveredReady.has(taskId)) return;
  deliveredReady.add(taskId);
  events.emit('updates.ready', { taskId });
}

function receiveTransfer(transfer: UpdateTransferState): void {
  if (!transfer || !Number.isSafeInteger(transfer.revision) || transfer.revision < 0
    || !['idle', 'downloading', 'verifying', 'ready', 'preparingInstall', 'installing', 'error'].includes(transfer.phase)
    || !Number.isSafeInteger(transfer.downloadedBytes) || transfer.downloadedBytes < 0
    || (transfer.totalBytes !== null && (!Number.isSafeInteger(transfer.totalBytes) || transfer.totalBytes < 0))
    || (state.transfer && transfer.revision <= state.transfer.revision)) return;
  state.transfer = transfer;
  state.transferErrorKind = null;
  changed();
  deliverReady();
}

function receiveReady(notice: UpdateReady): void {
  if (!notice || !notice.taskId || !Number.isSafeInteger(notice.revision) || notice.revision < 0
    || deliveredReady.has(notice.taskId)) return;
  if (state.transfer && state.transfer.revision >= notice.revision && state.transfer.taskId !== notice.taskId) return;
  pendingReady = notice;
  deliverReady();
  if (pendingReady) void ipc.updatesTransfer().then(receiveTransfer).catch(() => { /* 后续广播仍可完成通知。 */ });
}

function canDownload(): boolean {
  const available = state.transfer?.phase === 'error' || state.result?.status === 'available' || state.result?.status === 'noAsset';
  return available && !state.startingDownload && !isUpdateTransferBusy() && state.transfer?.phase !== 'ready' && !!getUpdateRelease()?.asset;
}

function receiveResult(result: UpdateCheckResult): void {
  if (!result || !['noReleases', 'current', 'available', 'noAsset'].includes(result.status)
    || !Number.isSafeInteger(result.checkedAt) || result.checkedAt <= 0) return;
  // checkedAt 仅用于展示和调度；系统时钟回拨不能丢弃成功的新检查。
  if (result.revision !== undefined && state.result?.revision !== undefined
    && result.revision < state.result.revision) return;
  state.result = result;
  changed();
}

function schedule(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!started || inFlight || isCommandExecutionBlocked()) return;
  const now = Date.now();
  const persisted = getSetting('updates.lastCheckedAt');
  const validPersisted = Number.isSafeInteger(persisted) && persisted <= now ? persisted : 0;
  const last = Math.max(validPersisted, lastLocalAttempt <= now ? lastLocalAttempt : 0);
  const delay = Math.max(readyAfter - now, nextUpdateDelay(last, getSetting('updates.intervalHours'), now), 0);
  timer = setTimeout(() => {
    timer = undefined;
    // A bounded timer can fire before the actual due time; recalculate before any IPC.
    const current = Date.now();
    const saved = getSetting('updates.lastCheckedAt');
    const last = Math.max(Number.isSafeInteger(saved) && saved <= current ? saved : 0,
      lastLocalAttempt <= current ? lastLocalAttempt : 0);
    if (current < readyAfter || nextUpdateDelay(last, getSetting('updates.intervalHours'), current) > 0) schedule();
    else void checkForUpdates(false);
  }, Math.min(delay, MAX_TIMER_MS));
}

/** 不阻塞编辑器初始化；首次后台请求延迟 12 秒，网络由 Rust 进程跨窗口去重。 */
export function startUpdateService(): void {
  if (started) return;
  started = true;
  readyAfter = Date.now() + UPDATE_START_DELAY_MS;
  if (!initialized) {
    initialized = true;
    registerCommand({ id: 'updates.check', title: () => t('updates.check'), run: () => checkForUpdates(true), when: () => !state.checking });
    registerCommand({ id: 'updates.repository', title: () => t('about.github'), run: () => openUpdateLink('repository') });
    registerCommand({ id: 'updates.download', title: () => t('updates.download'), run: downloadUpdate, when: canDownload });
    registerCommand({ id: 'updates.install', title: () => t(state.transfer?.mode === 'download-and-install' ? 'updates.installRestart' : 'updates.install'), run: installUpdate,
      when: () => state.transfer?.phase === 'ready' && !!state.transfer.taskId && !state.requestingInstall });
    registerCommand({ id: 'updates.release', title: () => t('updates.releasePage'), run: () => openUpdateLink('release'), when: () => !!getUpdateRelease() });
    registerCommand({ id: 'updates.ignore', title: () => t('updates.ignore'), run: ignoreUpdate,
      when: () => !!state.result?.release && (!state.transfer?.taskId || state.transfer.phase === 'idle') });
    events.on('settings.changed', ({ key }) => {
      if (key.startsWith('updates.')) { changed(); schedule(); }
    });
    events.on('commands.executionChanged', () => { schedule(); deliverReady(); });
    subscriptions = Promise.allSettled([
      ipc.onUpdatesChecked((result) => { if (started) receiveResult(result); }),
      ipc.onUpdateTransfer((transfer) => { if (started) receiveTransfer(transfer); }),
      ipc.onUpdateReady((notice) => { if (started) receiveReady(notice); }),
    ]);
  }
  // 先挂好监听再读取快照；期间到达的广播由 revision 防止旧快照回退进度。
  void subscriptions?.then(() => Promise.allSettled([
    ipc.updateInfo().then((info) => {
      state.info = info;
      if (info.cachedResult) receiveResult(info.cachedResult);
      receiveTransfer(info.transfer);
      changed();
    }),
    ipc.updatesTransfer().then(receiveTransfer),
  ]));
  deliverReady();
  schedule();
}

export function stopUpdateService(): void {
  started = false;
  clearTimeout(timer);
  timer = undefined;
}

export function checkForUpdates(manual = true): Promise<void> {
  if (isCommandExecutionBlocked()) return Promise.resolve();
  if (inFlight) return inFlight;
  clearTimeout(timer);
  state.checking = true;
  if (manual) state.errorKind = null;
  changed();
  lastLocalAttempt = Date.now();
  inFlight = (async () => {
    try {
      // 先提交用户刚选的间隔；后台不等待前端设置写入，仍由后端持久化决策。
      if (manual) await flushSettings();
      if (isCommandExecutionBlocked()) return;
      const result = await ipc.checkUpdates(manual);
      if (result) receiveResult(result);
      if (manual) state.errorKind = null;
    } catch (error) {
      if (manual) state.errorKind = isIpcError(error) ? error.kind : 'updateUnknown';
      // 自动检查失败不会弹窗或覆盖手动检查的错误状态。
    }
  })().finally(() => {
    state.checking = false;
    inFlight = null;
    changed();
    schedule();
  });
  return inFlight;
}

export function setUpdateInterval(hours: number): void {
  if (isCommandExecutionBlocked() || updateIntervalHours(hours) !== hours) return;
  setSetting('updates.intervalHours', hours);
}

export function setAutoDownload(enabled: boolean): void {
  if (!isCommandExecutionBlocked()) setSetting('updates.autoDownload', enabled);
}

export function setManualUpdateMode(mode: string): void {
  if (!isCommandExecutionBlocked() && (mode === 'download-only' || mode === 'download-and-install')) setSetting('updates.manualMode', mode);
}

export async function downloadUpdate(): Promise<void> {
  if (isCommandExecutionBlocked() || !canDownload()) return;
  const release = getUpdateRelease();
  if (!release?.asset) return;
  state.startingDownload = true;
  state.transferErrorKind = null;
  changed();
  try {
    await flushSettings();
    if (isCommandExecutionBlocked()) return;
    receiveTransfer(await ipc.downloadUpdate(release.version, getSetting('updates.manualMode') as UpdateMode));
  } catch (error) {
    state.transferErrorKind = isIpcError(error) ? error.kind : 'updateDownload';
  } finally {
    state.startingDownload = false;
    changed();
  }
}

export async function installUpdate(): Promise<void> {
  const transfer = state.transfer;
  if (isCommandExecutionBlocked() || state.requestingInstall || transfer?.phase !== 'ready' || !transfer.taskId) return;
  state.requestingInstall = true;
  state.transferErrorKind = null;
  changed();
  try { await ipc.installUpdate(transfer.taskId); }
  catch (error) { state.transferErrorKind = isIpcError(error) ? error.kind : 'updateInstall'; }
  finally { state.requestingInstall = false; changed(); }
}

export async function ignoreUpdate(): Promise<void> {
  if (isCommandExecutionBlocked() || !state.result?.release || (state.transfer?.taskId && state.transfer.phase !== 'idle')) return;
  setSetting('updates.ignoredVersion', state.result.release.version);
  changed();
  try { await flushSettings(); }
  catch { state.errorKind = 'updateSettings'; changed(); }
}

export async function openUpdateLink(target: UpdateLink): Promise<boolean> {
  if (isCommandExecutionBlocked()) return false;
  const version = getUpdateRelease()?.version;
  if (target !== 'repository' && !version) return false;
  try {
    await ipc.openUpdateLink(target, version);
    return true;
  } catch {
    state.errorKind = 'updateOpen';
    changed();
    return false;
  }
}
