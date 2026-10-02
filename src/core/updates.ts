import { ipc, isIpcError, type UpdateCheckResult, type UpdateInfo, type UpdateLink } from '../ipc';
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
}

const state: UpdateViewState = { info: null, result: null, checking: false, errorKind: null };
// 30 天超过 setTimeout 的 32 位范围：最长只等待一天，然后重算到期时间。
const MAX_TIMER_MS = 24 * 3_600_000;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | null = null;
let initialized = false;
let started = false;
let readyAfter = 0;
let lastLocalAttempt = 0;

export function getUpdateState(): Readonly<UpdateViewState> { return state; }

export function getUpdateNotification(): UpdateCheckResult | null {
  return shouldNotifyUpdate(state.result, getSetting('updates.ignoredVersion')) ? state.result : null;
}

function changed(): void { events.emit('updates.changed', undefined); }

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
    registerCommand({ id: 'updates.download', title: () => t('updates.download'), run: () => openUpdateLink('download'), when: () => !!state.result?.release?.asset });
    registerCommand({ id: 'updates.release', title: () => t('updates.releasePage'), run: () => openUpdateLink('release'), when: () => !!state.result?.release });
    registerCommand({ id: 'updates.ignore', title: () => t('updates.ignore'), run: ignoreUpdate, when: () => !!state.result?.release });
    events.on('settings.changed', ({ key }) => {
      if (key.startsWith('updates.')) { changed(); schedule(); }
    });
    events.on('commands.executionChanged', schedule);
    void ipc.onUpdatesChecked((result) => { if (started) receiveResult(result); }).catch(() => { /* IPC 返回仍可更新当前窗口。 */ });
  }
  void ipc.updateInfo().then((info) => {
    state.info = info;
    if (info.cachedResult) receiveResult(info.cachedResult);
    changed();
  }).catch(() => { /* 手动检查会显示具体失败。 */ });
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

export async function ignoreUpdate(): Promise<void> {
  if (isCommandExecutionBlocked() || !state.result?.release) return;
  setSetting('updates.ignoredVersion', state.result.release.version);
  changed();
  try { await flushSettings(); }
  catch { state.errorKind = 'updateSettings'; changed(); }
}

export async function openUpdateLink(target: UpdateLink): Promise<boolean> {
  if (isCommandExecutionBlocked()) return false;
  const version = state.result?.release?.version;
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
