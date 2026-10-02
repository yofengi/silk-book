// 标签迁移：原始字节传输 + 后端接收凭据。原标签只在目标完整装载后移除。
import { events } from '../core/events';
import { isCommandExecutionBlocked } from '../core/commands';
import { getSetting } from '../core/settings';
import { t } from '../i18n';
import { errorMessage, ipc } from '../ipc';
import type { TransferOffer, TransferPlacement } from '../ipc';
import type { DocumentInfo } from './document';
import type { FeatureFlags } from './view';
import {
  activateTab, allTabIds, applyLanguage, closeTab, listTabs, markTransferredDirty, moveTab, openTab,
  restoreViewSnapshot, tabText, viewSnapshot, type Tab,
} from './tabs';

const TRANSFER_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_MS = 150;
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;

interface TransferHeader {
  version: 1;
  doc: DocumentInfo;
  flags: FeatureFlags;
  languageId: string;
  view: { anchor: number; head: number; scrollPos: number };
}

interface Outgoing { cancelled: boolean; token?: string }
const outgoing = new Map<string, Outgoing>();
const incoming = new Set<Promise<Tab | undefined>>();
const receiving = new Set<string>();
let closing = false;
let incomingListener: Promise<void> | undefined;

export function isTransferring(id: string): boolean { return outgoing.has(id) || receiving.has(id); }
export function setTransferClosing(value: boolean): void { closing = value; }

/** 在 windowInit 之前安装，后端仅向已初始化窗口投递现有窗口移入请求。 */
export function installIncomingTransferListener(): Promise<void> {
  return incomingListener ??= ipc.bus.on<TransferOffer>('tab-transfer-offered', (offer) => {
    if (!offer || typeof offer.token !== 'string' || typeof offer.source !== 'string') return;
    void receiveTransferredTab(offer.token, offer.placement);
  }).catch((error: unknown) => { incomingListener = undefined; throw error; });
}

export async function cancelOutgoingTransfers(): Promise<void> {
  const tokens: string[] = [];
  for (const transfer of outgoing.values()) {
    transfer.cancelled = true;
    if (transfer.token) tokens.push(transfer.token);
  }
  await Promise.all(tokens.map((token) => ipc.transferCancel(token)));
  // 已开始装载的移入任务必须完成，关闭确认才能看见移入的未保存文档。
  await Promise.all([...incoming]);
}

function encode(header: TransferHeader, text: string): Uint8Array {
  const encoder = new TextEncoder();
  const metadata = encoder.encode(JSON.stringify(header));
  const content = encoder.encode(text);
  if (metadata.length + content.length + 4 > MAX_TRANSFER_BYTES) {
    throw new Error('tab transfer exceeds 256 MiB');
  }
  const bytes = new Uint8Array(4 + metadata.length + content.length);
  new DataView(bytes.buffer).setUint32(0, metadata.length, true);
  bytes.set(metadata, 4);
  bytes.set(content, 4 + metadata.length);
  return bytes;
}

function decode(bytes: Uint8Array): { header: TransferHeader; text: string } {
  if (bytes.length < 4 || bytes.length > MAX_TRANSFER_BYTES) throw new Error('invalid tab transfer');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (4 + length > bytes.length) throw new Error('invalid tab transfer header');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const value: unknown = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length)));
  if (!value || typeof value !== 'object') throw new Error('invalid tab transfer metadata');
  const header = value as TransferHeader;
  if (header.version !== 1 || !header.doc || !header.flags || !header.view
    || (header.doc.path !== null && typeof header.doc.path !== 'string')
    || typeof header.doc.encoding !== 'string' || typeof header.doc.hasBom !== 'boolean'
    || typeof header.doc.dirty !== 'boolean' || !['CRLF', 'LF', 'CR', 'MIXED'].includes(header.doc.eol)
    || typeof header.languageId !== 'string'
    || typeof header.flags.minimap !== 'boolean' || typeof header.flags.wordCompletion !== 'boolean'
    || !Object.values(header.view).every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('invalid tab transfer metadata');
  }
  return { header, text: decoder.decode(bytes.subarray(4 + length)) };
}

/** 命令入口调用；失败、取消、目标先关闭或源再次编辑均保留原文档。 */
export function moveTabToNewWindow(id: string, position?: { x: number; y: number }): Promise<boolean> {
  return moveToDestination(id, (token) => ipc.windowOpen({ transferToken: token, ...position }));
}

/** 合并到现有窗口；独立新建标签，即使相同路径也不覆盖目标的文档。 */
export function moveTabToExistingWindow(id: string, target: string, placement?: TransferPlacement): Promise<boolean> {
  if (!target || target === ipc.bus.label) return Promise.resolve(false);
  return moveToDestination(id, async (token) => { await ipc.transferSend(token, target, placement); return target; });
}

async function moveToDestination(id: string, send: (token: string) => Promise<string>): Promise<boolean> {
  const tab = listTabs().find((entry) => entry.id === id);
  if (!tab || closing || isCommandExecutionBlocked() || isTransferring(id)) return false;
  const transfer: Outgoing = { cancelled: false };
  outgoing.set(id, transfer);
  events.emit('tab.changed', { id });
  try {
    const text = tabText(tab); // 同步当前活动 EditorView 的 state
    const snapshot = tab.state.doc;
    const descriptor = JSON.stringify({ doc: tab.doc, flags: tab.flags, languageId: tab.languageId });
    const bytes = encode({ version: 1, doc: { ...tab.doc }, flags: { ...tab.flags }, languageId: tab.languageId, view: viewSnapshot(tab) }, text);
    transfer.token = await ipc.transferPut(bytes);
    if (transfer.cancelled) return false;
    const target = await send(transfer.token);
    const deadline = Date.now() + TRANSFER_TIMEOUT_MS;
    while (!transfer.cancelled && Date.now() < deadline) {
      const receipt = await ipc.transferStatus(transfer.token);
      if (transfer.cancelled) return false;
      if (receipt.state === 'missing') throw new Error('destination closed or transfer expired');
      if (receipt.state === 'accepted' && receipt.target === target) {
        // 传输期间允许继续编辑；只有原文档完全未变时才交出所有权。
        if (listTabs().includes(tab)) {
          tabText(tab);
          if (tab.state.doc.eq(snapshot) && descriptor === JSON.stringify({ doc: tab.doc, flags: tab.flags, languageId: tab.languageId })) {
            closeTab(id);
            if (!allTabIds().length && getSetting('window.closeLastTabExits')) await ipc.window.close();
          }
        }
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
    }
    if (!transfer.cancelled) throw new Error('tab transfer timed out');
    return false;
  } catch (error) {
    if (!transfer.cancelled) alert(t('tab.moveFailed', { error: errorMessage(error) }));
    return false;
  } finally {
    if (transfer.token) await ipc.transferCancel(transfer.token).catch((error: unknown) => console.warn('transfer cleanup failed', error));
    outgoing.delete(id);
    events.emit('tab.changed', { id });
  }
}

/** 初始化窗口调用；接收完成前不产生“已接收”凭据。撤销历史按计划不跨窗口迁移。 */
export function receiveTransferredTab(token: string, placement?: TransferPlacement): Promise<Tab | undefined> {
  if (closing || isCommandExecutionBlocked()) {
    return ipc.transferReject(token).catch((error: unknown) => console.warn('transfer reject failed', error)).then(() => undefined);
  }
  const task = (async () => {
    let tab: Tab | undefined;
    try {
      const { header, text } = decode(await ipc.transferTake(token));
      if (closing || isCommandExecutionBlocked()) throw new Error('destination is closing');
      tab = openTab(text, header.doc, header.flags);
      receiving.add(tab.id);
      events.emit('tab.changed', { id: tab.id });
      if (header.doc.dirty) markTransferredDirty(tab);
      await applyLanguage(tab, header.languageId);
      if (closing || isCommandExecutionBlocked() || !listTabs().includes(tab)) throw new Error('destination closed before receiving the tab');
      if (placement && Number.isInteger(placement.index) && placement.index >= 0) {
        const ids = allTabIds().filter((id) => id !== tab!.id);
        const neighbour = typeof placement.beforeId === 'string' ? ids.indexOf(placement.beforeId) : -1;
        moveTab(tab.id, neighbour >= 0 ? neighbour : placement.index);
      }
      // 用户可能在语言包装载期间切换标签，恢复前重新激活迁入的文档。
      activateTab(tab.id);
      restoreViewSnapshot(tab, header.view);
      await ipc.transferAccept(token);
      void ipc.window.focus().catch((error: unknown) => console.warn('transfer focus failed', error));
      return tab;
    } catch (error) {
      // 源窗口会查到 missing/未确认状态并保留文本；已打开的目标文本也继续保留。
      console.error('tab receive failed', error);
      await ipc.transferReject(token).catch((rejectError: unknown) => console.warn('transfer reject failed', rejectError));
      return undefined;
    } finally {
      if (tab) {
        receiving.delete(tab.id);
        events.emit('tab.changed', { id: tab.id });
      }
    }
  })();
  incoming.add(task);
  void task.finally(() => incoming.delete(task));
  return task;
}
