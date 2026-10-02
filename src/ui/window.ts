// 无边框窗口：窗口命令、关闭协议（dirty 确认）、最大化/焦点状态同步。窗口 API 只经 src/ipc/。
import { isCommandExecutionBlocked, registerCommand, setCommandExecutionBlocked } from '../core/commands';
import { flushSettings } from '../core/settings';
import { baseName } from '../editor/document';
import { listTabs } from '../editor/tabs';
import { cancelOutgoingTransfers, setTransferClosing } from '../editor/transfer';
import { t } from '../i18n';
import { errorMessage, ipc } from '../ipc';

interface QuitSession { requestId: string; accepted: boolean }
interface CloseAttempt { cancelled: boolean; result: Promise<boolean> }
let lifecycleReady: Promise<void> | null = null;
let nativeClose: Promise<void> | null = null;
let attempt: CloseAttempt | null = null;
let quitSession: QuitSession | null = null;
let destroyed = false;
let frozen = false;
let previousInert = false;
let previousBodyInert = false;
let previousCommandBlock = false;

function freeze(): void {
  const root = document.getElementById('app');
  if (!frozen) {
    previousInert = root?.inert ?? false;
    previousBodyInert = document.body?.inert ?? false;
    previousCommandBlock = isCommandExecutionBlocked();
  }
  frozen = true;
  if (root) root.inert = true;
  // 命令面板/菜单等浮层位于 #app 外；原生确认对话框由 IPC 打开，不受 body inert 影响。
  if (document.body) document.body.inert = true;
  setCommandExecutionBlocked(true);
  setTransferClosing(true);
}

function release(): void {
  if (destroyed || nativeClose || quitSession) return;
  const root = document.getElementById('app');
  if (root) root.inert = previousInert;
  if (document.body) document.body.inert = previousBodyInert;
  frozen = false;
  setTransferClosing(false);
  setCommandExecutionBlocked(previousCommandBlock);
}

function reportCloseError(error: unknown): void {
  alert(t('window.closeFailed', { error: errorMessage(error) }));
}

function prepareClose(): Promise<boolean> {
  if (attempt && !attempt.cancelled) return attempt.result;
  if (attempt) return attempt.result.then(() => prepareClose());
  const current: CloseAttempt = { cancelled: false, result: Promise.resolve(false) };
  attempt = current;
  current.result = (async () => {
    try {
      freeze();
      await cancelOutgoingTransfers();
      if (current.cancelled) return false;
      const dirty = listTabs().filter((tab) => tab.doc.dirty);
      if (dirty.length) {
        const names = dirty.slice(0, 5).map((tab) => t('common.quoted', { name: baseName(tab.doc.path) })).join(t('common.listSep'));
        const more = dirty.length > 5 ? t('window.quitDirtyMore', { count: dirty.length }) : '';
        if (!(await ipc.confirm(t('window.quitDirtyConfirm', { names, more })))) return false;
      }
      if (current.cancelled) return false;
      await flushSettings();
      return !current.cancelled;
    } catch (error) {
      reportCloseError(error);
      return false;
    }
  })().finally(() => { if (attempt === current) attempt = null; });
  return current.result;
}

function closeCurrentWindow(): void {
  if (nativeClose || quitSession || destroyed) return;
  nativeClose = (async () => {
    const allowed = await prepareClose();
    // 本地关闭与全应用退出合并确认；投票开始后须等全体窗口同意。
    if (!allowed || quitSession) return;
    await ipc.window.destroy();
    destroyed = true;
  })().catch(reportCloseError).finally(() => { nativeClose = null; release(); });
}

async function voteForQuit(requestId: string): Promise<void> {
  if (!requestId || destroyed || quitSession?.requestId === requestId) return;
  const session: QuitSession = { requestId, accepted: false };
  quitSession = session;
  freeze();
  const allowed = await prepareClose();
  if (quitSession !== session || destroyed) return;
  // 事件可能先于 reply promise 返回，必须在投票前记录本窗口已经同意。
  session.accepted = allowed;
  try {
    await ipc.replyQuit(requestId, allowed);
    if (!allowed && quitSession === session) { quitSession = null; release(); }
  } catch (error) {
    if (quitSession === session) { quitSession = null; release(); }
    reportCloseError(error);
    void ipc.replyQuit(requestId, false).catch((failure: unknown) => console.warn('quit refusal failed', failure));
  }
}

async function approveQuit(requestId: string): Promise<void> {
  if (destroyed || quitSession?.requestId !== requestId || !quitSession.accepted) return;
  try {
    await ipc.window.destroy();
    destroyed = true;
  } catch (error) {
    quitSession = null;
    release();
    reportCloseError(error);
  }
}

/** 所有关闭/退出订阅就绪后，main 才可接收窗口初始化与移入文档。 */
export function windowLifecycleReady(): Promise<void> {
  lifecycleReady ??= Promise.all([
    ipc.window.onCloseRequested((event) => {
      event.preventDefault(); // 始终同步阻止默认销毁，包含没有脏文档的窗口。
      closeCurrentWindow();
    }),
    ipc.onQuitRequested(({ requestId }) => { void voteForQuit(requestId); }),
    ipc.onQuitApproved(({ requestId }) => { void approveQuit(requestId); }),
    ipc.onQuitCancelled(({ requestId }) => {
      if (quitSession?.requestId !== requestId) return;
      quitSession = null;
      if (attempt && !nativeClose) attempt.cancelled = true;
      release();
    }),
  ]).then(() => {});
  return lifecycleReady;
}

export function registerWindowCommands(): void {
  registerCommand({ id: 'window.minimize', title: () => t('cmd.window.minimize'), run: () => ipc.window.minimize() });
  registerCommand({ id: 'window.toggleMaximize', title: () => t('cmd.window.toggleMaximize'), run: () => ipc.window.toggleMaximize() });
  // 关闭按钮也走 onCloseRequested，不绕过确认
  registerCommand({ id: 'window.close', title: () => t('cmd.window.close'), run: () => ipc.window.close() });
  registerCommand({ id: 'app.quit', title: () => t('cmd.app.quit'), run: () => ipc.requestQuit() });
  void windowLifecycleReady().catch(reportCloseError);
}

/** 同步最大化图标与窗口焦点态（dim 标题栏） */
export function bindWindowState(onMax: (max: boolean) => void): void {
  const root = document.documentElement;
  const sync = () => void ipc.window.isMaximized().then((m) => {
    root.classList.toggle('win-max', m);
    onMax(m);
  });
  sync();
  void ipc.window.onResized(sync);
  void ipc.window.onFocusChanged((f) => root.classList.toggle('win-inactive', !f));
}
