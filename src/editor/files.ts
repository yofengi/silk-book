// 文件打开/保存/最近文件的业务逻辑（由命令调用，UI 不直接调用）
import { events } from '../core/events';
import { isCommandExecutionBlocked } from '../core/commands';
import { getSetting, setSetting } from '../core/settings';
import { t } from '../i18n';
import { errorMessage, ipc, isIpcError } from '../ipc';
import { showProgress, type ProgressHandle } from '../ui/progress';
import { baseName, pathKey, sizeTier, type DocumentInfo } from './document';
import { defaultEncoding, defaultEol, encodingName } from './encodings';
import type { Text } from '@codemirror/state';
import { LineCollector, tierFlagsOverride } from './large-file';
import { activateTab, findTabByPath, markSaved, openTab, replaceTabContent, type Tab } from './tabs';

let requestSeq = 0;

export function nextRequestId(): string {
  return `r${++requestSeq}-${Date.now()}`;
}

export function addRecent(path: string): void {
  const list = getSetting('files.recent').filter((p) => p !== path);
  list.unshift(path);
  setSetting('files.recent', list.slice(0, getSetting('files.recentMax')));
  events.emit('recent.changed', undefined);
}

export function removeRecent(path: string): void {
  setSetting('files.recent', getSetting('files.recent').filter((p) => p !== path));
  events.emit('recent.changed', undefined);
}

export function clearRecent(): void {
  setSetting('files.recent', []);
  events.emit('recent.changed', undefined);
}

let progressHost: HTMLElement | null = null;

/** 由 main 注入进度条挂载点（Huge 档读取时显示） */
export function setProgressHost(el: HTMLElement): void {
  progressHost = el;
}

interface Loaded { text: Text; info: Partial<DocumentInfo> }
type FileDefaults = Pick<DocumentInfo, 'encoding' | 'hasBom' | 'eol'>;
const operations = new WeakMap<Tab, Promise<boolean>>();
const pendingOperations = new Map<Promise<boolean>, boolean>();
const opening = new Map<string, Promise<Tab | undefined>>();

/** 同一文档的磁盘操作按请求顺序完成，避免后发保存/重读被较慢的旧请求覆盖。 */
function sequenceOperation(tab: Tab, run: () => Promise<boolean>, saving = false): Promise<boolean> {
  // An earlier asynchronous command (for example encoding discovery) may reach
  // this entry after the lifecycle gate closed. Already queued operations finish.
  if (isCommandExecutionBlocked()) return Promise.resolve(false);
  const previous = operations.get(tab);
  const current = previous ? previous.catch(() => false).then(run) : run();
  operations.set(tab, current);
  pendingOperations.set(current, saving);
  void current.finally(() => {
    if (operations.get(tab) === current) operations.delete(tab);
    pendingOperations.delete(current);
  }).catch(() => {});
  return current;
}

/** Wait for queued disk work before inspecting dirty tabs or exiting the process. */
export async function drainFileOperations(): Promise<boolean> {
  let saved = true;
  // Reloads can replace a document and opens can add tabs; include them so the
  // dirty snapshot cannot be invalidated after confirmation. A queued save also
  // waits for the reload ahead of it. Only a failed/cancelled save vetoes exit.
  while (pendingOperations.size || opening.size) {
    const work = [...pendingOperations].map(async ([operation, saving]) => {
      try {
        const completed = await operation;
        return !saving || completed;
      }
      catch { return !saving; }
    });
    work.push(...[...opening.values()].map(operation => operation.then(() => true, () => true)));
    if ((await Promise.all(work)).some(result => !result)) saved = false;
  }
  return saved;
}

/**
 * 读取文件为文档（不开标签）。encoding 缺省取 files.readEncoding；BOM 始终优先（后端负责）。
 * 无换行的文件用 files.defaultEol；0 字节文件用 files.defaultEncoding。取消返回 undefined。
 */
async function loadPath(path: string, encoding?: string, fallback?: FileDefaults): Promise<Loaded | undefined> {
  let progress: ProgressHandle | null = null;
  let cancelled = false;
  // 捕获本次打开使用的默认值；设置变化不会改写已经打开（或正在读取）的文档。
  const readEncoding = encoding ?? getSetting('files.readEncoding');
  const emptyEncoding = fallback ? { encoding: fallback.encoding, hasBom: fallback.hasBom } : defaultEncoding();
  const noEol = fallback && fallback.eol !== 'MIXED' ? fallback.eol : defaultEol();
  try {
    const stat = await ipc.fileStat(path);
    const tier = sizeTier(stat.size);
    const requestId = nextRequestId();
    if (tier === 'Huge' && progressHost) {
      progress = showProgress(progressHost, t('files.reading', { name: baseName(path) }), () => {
        cancelled = true;
        void ipc.cancelRead(requestId);
      });
      progress.update(0, stat.size);
    }
    const decoder = new TextDecoder('utf-8');
    const lines = new LineCollector();
    const res = await ipc.readFile(path, requestId, {
      onChunk: (b) => { if (!cancelled) lines.push(decoder.decode(b, { stream: true })); },
      onProgress: progress ? (p) => progress?.update(p.read, p.total) : undefined,
    }, readEncoding);
    if (cancelled) return undefined; // 取消后即使读取已完成也不开标签
    lines.push(decoder.decode());
    progress?.setLabel(t('files.building'));
    // 后端已将 CRLF 归一为 \n；原 EOL 记录在 Document
    const text = lines.finish();
    // 检测不出换行（后端报告 LF 且文档只有一行）→ 默认换行符
    const eol = res.eol === 'LF' && text.lines <= 1 ? noEol : res.eol;
    const enc = res.size === 0 ? emptyEncoding : { encoding: res.encoding, hasBom: res.hasBom };
    return {
      text,
      info: {
        path, encoding: enc.encoding, hasBom: enc.hasBom, eol, eolMap: res.eolMap,
        readEncoding, malformed: !!res.malformed, size: res.size, tier: sizeTier(res.size),
      },
    };
  } catch (e) {
    if (cancelled || (isIpcError(e) && e.kind === 'cancelled')) return undefined;
    throw e;
  } finally {
    progress?.close();
  }
}

/** 按档位读取：Normal/Large 一次读取；Huge 显示进度条且可取消。均按行累积后 Text.of 构建文档 */
export function openPath(path: string): Promise<Tab | undefined> {
  const existing = findTabByPath(path);
  if (existing) {
    activateTab(existing.id);
    return Promise.resolve(existing);
  }
  const key = pathKey(path);
  const pending = opening.get(key);
  if (pending) return pending;
  const request = openLoaded(path).finally(() => opening.delete(key));
  opening.set(key, request);
  return request;
}

async function openLoaded(path: string): Promise<Tab | undefined> {
  try {
    const r = await loadPath(path);
    if (!r) return undefined;
    // 读取期间可能通过移窗/另存为出现同路径文档，完成前再次去重。
    const existing = findTabByPath(path);
    if (existing) { activateTab(existing.id); return existing; }
    const tab = openTab(r.text, r.info, tierFlagsOverride(r.info.tier ?? 'Normal'));
    addRecent(path);
    return tab;
  } catch (e) {
    if (isIpcError(e) && e.kind === 'io') removeRecent(path);
    alert(t('files.openFailed', { error: errorMessage(e) }));
    return undefined;
  }
}

/** 新建未命名文件：换行符与编码取默认设置 */
export function newUntitled(): Tab {
  return openTab('', { ...defaultEncoding(), eol: defaultEol() });
}

/** 从磁盘重新读取（可指定编码）；未保存修改需确认 */
export function reloadTab(tab: Tab, encoding?: string): Promise<boolean> {
  return sequenceOperation(tab, () => reloadNow(tab, encoding));
}

async function reloadNow(tab: Tab, encoding?: string): Promise<boolean> {
  if (!tab.doc.path) return false;
  if (tab.doc.dirty && !(await ipc.confirm(t('files.reloadDirtyConfirm', { name: baseName(tab.doc.path) })))) return false;
  try {
    const forced = encoding ?? tab.doc.readEncoding;
    const startDoc = tab.state.doc;
    const startMeta = { ...tab.doc };
    const r = await loadPath(tab.doc.path, forced, startMeta);
    if (!r) return false;
    // 原先的确认只覆盖读取开始前的修改；异步读取期间产生的新修改须再次确认。
    if ((!tab.state.doc.eq(startDoc) || tab.doc.eol !== startMeta.eol || tab.doc.encoding !== startMeta.encoding
      || tab.doc.hasBom !== startMeta.hasBom || tab.doc.eolMap !== startMeta.eolMap)
      && !(await ipc.confirm(t('files.reloadDirtyConfirm', { name: baseName(tab.doc.path) })))) return false;
    // r.info 始终含 eolMap 键（非 MIXED 为 undefined），会清掉旧的映射
    replaceTabContent(tab, r.text, r.info);
    return true;
  } catch (e) {
    alert(t('files.openFailed', { error: errorMessage(e) }));
    return false;
  }
}

export function saveTab(tab: Tab, saveAs = false, override?: { encoding: string; hasBom: boolean }): Promise<boolean> {
  return sequenceOperation(tab, () => saveNow(tab, saveAs, override), true);
}

async function saveNow(tab: Tab, saveAs: boolean, override?: { encoding: string; hasBom: boolean }): Promise<boolean> {
  let path = tab.doc.path;
  if (!path || saveAs) {
    path = await ipc.saveDialog({ defaultPath: path ?? undefined });
    if (!path) return false;
  }
  if (tab.doc.malformed && !(await ipc.confirm(t('files.malformedConfirm', { name: baseName(path) })))) return false;
  // MIXED：原样传回读取时的 eolMap（IPC.md 规则：新增的多余换行按 LF 保存，删除行留下的多余条目被忽略）
  const snapshotDoc = tab.state.doc;
  const snapshotMeta = { encoding: tab.doc.encoding, hasBom: tab.doc.hasBom, eol: tab.doc.eol, eolMap: tab.doc.eolMap };
  const { eol, eolMap } = snapshotMeta;
  const encoding = override?.encoding ?? tab.doc.encoding;
  const bom = override?.hasBom ?? tab.doc.hasBom;
  const bytes = new TextEncoder().encode(snapshotDoc.toString());
  const opts = { path, encoding, eol, bom, eolMap: eol === 'MIXED' ? (eolMap ?? '') : undefined };
  try {
    let res;
    try {
      res = await ipc.writeFile(bytes, opts);
    } catch (e) {
      if (!isIpcError(e) || e.kind !== 'unmappable') throw e;
      // 后端消息：unmappable characters: N, first: X
      const count = Number(/(\d+)/.exec(e.message)?.[1] ?? 0);
      const ok = await ipc.confirm(t('files.unmappableConfirm', { count, encoding: encodingName(encoding) }));
      if (!ok) return false;
      res = await ipc.writeFile(bytes, { ...opts, allowLossy: true });
    }
    markSaved(tab, { path, size: res.bytesWritten, encoding, hasBom: bom, readEncoding: encoding, malformed: false }, snapshotDoc, snapshotMeta);
    addRecent(path);
    return true;
  } catch (e) {
    alert(t('files.saveFailed', { error: errorMessage(e) }));
    return false;
  }
}
