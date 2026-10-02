// IPC 类型：与 Rust 端对齐（以 docs/IPC.md 为准）

export type Eol = 'LF' | 'CRLF' | 'CR' | 'MIXED';

export interface IpcError {
  kind: string;
  message: string;
}

export interface FileStat {
  size: number;
  mtime: number;
  readonly: boolean;
}

export interface ReadResult {
  encoding: string;
  eol: Eol;
  hasBom: boolean;
  size: number;
  /** 仅 MIXED：每个原始换行一个字符，'C'=CRLF，'L'=LF，'R'=CR */
  eolMap?: string;
  /** 解码时出现非法字节（已被替换） */
  malformed?: boolean;
}

/** list_encodings 条目；group 如 Unicode / System / Chinese / Western */
export interface EncodingInfo {
  id: string;
  label: string;
  group: string;
  bom: boolean;
}

export interface AnsiEncoding {
  codePage: number;
  id: string;
}

export interface WriteResult {
  /** 实际写入磁盘的编码后字节数（含 BOM） */
  bytesWritten: number;
}

export interface ReadProgress {
  read: number;
  total: number;
}

export interface ReadDone {
  kind: 'done';
  requestId: string;
}

export interface ReadHandlers {
  /** 已解码为 UTF-8 的原始字节块 */
  onChunk(bytes: Uint8Array): void;
  onProgress?(p: ReadProgress): void;
}

export interface WriteOptions {
  path: string;
  encoding: string;
  eol: Eol;
  bom: boolean;
  /** eol 为 MIXED 时传回 read 得到的 eolMap */
  eolMap?: string;
  /** true：无法表示的字符用 ? 替换；默认以 kind 'unmappable' 拒绝 */
  allowLossy?: boolean;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface UpdateInfo {
  currentVersion: string;
  platform: string;
  repositoryUrl: string;
  /** 新窗口可读取进程缓存，不另发网络请求。 */
  cachedResult?: UpdateCheckResult | null;
  /** 进程共享下载快照；其中 release 固定为正在下载或已下载的版本。 */
  transfer: UpdateTransferState;
}

export interface ReleaseInfo {
  version: string;
  /** 显示为纯文本；不执行 Release Markdown/HTML 中的内容。 */
  notes: string;
  url: string;
  asset: { name: string; url: string } | null;
}

export interface UpdateCheckResult {
  status: 'noReleases' | 'current' | 'available' | 'noAsset';
  checkedAt: number;
  /** 进程内递增序号，用于多窗口排序；浏览器测试可省略。 */
  revision?: number;
  release: ReleaseInfo | null;
}

export type UpdateLink = 'repository' | 'release' | 'download';

export type UpdateMode = 'download-only' | 'download-and-install';

export interface UpdateTransferState {
  revision: number;
  taskId: string | null;
  phase: 'idle' | 'downloading' | 'verifying' | 'ready' | 'preparingInstall' | 'installing' | 'error';
  release: ReleaseInfo | null;
  source: 'manual' | 'automatic';
  mode: UpdateMode;
  downloadedBytes: number;
  totalBytes: number | null;
  error: IpcError | null;
}

/** 仅发送给一个窗口；广播或缓存快照不会自动打开完成弹窗。 */
export interface UpdateReady { taskId: string; revision: number }

export interface IpcApi {
  updateInfo(): Promise<UpdateInfo>;
  /** 后端跨窗口去重并记录检查时间；未到期且无会话缓存时返回 null。 */
  checkUpdates(manual: boolean): Promise<UpdateCheckResult | null>;
  onUpdatesChecked(fn: (result: UpdateCheckResult) => void): Promise<void>;
  updatesTransfer(): Promise<UpdateTransferState>;
  downloadUpdate(version: string, mode: UpdateMode): Promise<UpdateTransferState>;
  /** 用户明确点击后才请求安装投票，下载完成不会调用此命令。 */
  installUpdate(taskId: string): Promise<void>;
  onUpdateTransfer(fn: (state: UpdateTransferState) => void): Promise<void>;
  onUpdateReady(fn: (notice: UpdateReady) => void): Promise<void>;
  /** 后端仅打开固定仓库 / 最近已验证版本页面和对应安装包。 */
  openUpdateLink(target: UpdateLink, version?: string): Promise<void>;
  fileStat(path: string): Promise<FileStat>;
  /** requestId 由调用方分配，用于 cancelRead */
  /** encoding：'auto'（默认）| 'utf-8' | 'ansi' | listEncodings 的 id；BOM 始终优先 */
  readFile(path: string, requestId: string, handlers: ReadHandlers, encoding?: string): Promise<ReadResult>;
  cancelRead(requestId: string): Promise<boolean>;
  /** bytes 为 UTF-8、换行为 \n 的内容；由后端转换 EOL/编码/BOM */
  writeFile(bytes: Uint8Array, opts: WriteOptions): Promise<WriteResult>;
  listEncodings(): Promise<EncodingInfo[]>;
  /** 系统 ANSI 代码页；非 Windows 以 unsupported 拒绝 */
  ansiEncoding(): Promise<AnsiEncoding>;
  /** 返回拼错的词（≤2000 词/次）；API 不可用时以 kind 'unsupported' 拒绝 */
  spellCheck(words: string[]): Promise<string[]>;
  /** 在资源管理器中定位文件 */
  revealItemInDir(path: string): Promise<void>;
  settingsLoad(): Promise<string | null>;
  settingsSave(json: string): Promise<void>;
  openDialog(opts?: { multiple?: boolean; filters?: FileFilter[] }): Promise<string[]>;
  saveDialog(opts?: { defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
  confirm(message: string, title?: string): Promise<boolean>;
  /** 为已打开文档所在目录授予 asset 协议访问（path 为文档文件本身） */
  allowAssetDir(documentPath: string): Promise<void>;
  /** 本地绝对路径 -> 可用于 <img src> 的 asset URL；mock 返回 null */
  assetUrl(absPath: string): string | null;
  /** 仅 http/https/mailto，调用方需先校验 */
  openExternal(url: string): Promise<void>;
  /** Windows build 号（如 22631）；非 Windows / 读取失败 / mock 为 0 */
  osBuild(): Promise<number>;
  /** 随安装包附带的字体文件（WOFF2，绝对资源路径）；目前为 Maple Mono NF CN 四个字面 */
  bundledFonts(): Promise<BundledFont[]>;
  /** 系统字体族名（已排序去重） */
  listSystemFonts(): Promise<string[]>;
  /** 扩展名不带点，须匹配 ^[a-z0-9_+-]{1,16}$ */
  fileAssocStatus(exts: string[]): Promise<FileAssocStatus[]>;
  fileAssocRegister(exts: string[]): Promise<void>;
  fileAssocUnregister(exts: string[]): Promise<void>;
  openDefaultAppsSettings(): Promise<void>;
  /** 第二实例传入文件时触发；须在 windowInit 之前订阅 */
  onOpenFiles(fn: (paths: string[]) => void): Promise<void>;
  themesList(): Promise<ThemeEntry[]>;
  themeImport(sourcePath: string): Promise<ImportedTheme>;
  themeDelete(id: string): Promise<void>;
  /** 系统 UI 语言（BCP-47，如 'zh-CN'）。见 PLAN-v0.2 §2 system_locale */
  systemLocale(): Promise<string>;
  /** 本窗口初始化数据（每窗口调用一次）：main 拿命令行文件；新窗口拿 window_open 传入的 files / transferToken */
  windowInit(): Promise<WindowInit>;
  /** 当前窗口的 UI 和关闭监听就绪后显示；后端幂等，不能指定别的窗口。 */
  windowReady(): Promise<void>;
  /** 显式显示当前窗口的启动错误；失败窗口不能接受草稿转移。 */
  windowStartupFailed(message: string): Promise<void>;
  /** 新建窗口，返回窗口 label；x/y 为逻辑像素的左上角 */
  windowOpen(opts: WindowOpenOptions): Promise<string>;
  /** 屏幕物理坐标处最上层的帛书窗口；被其他应用遮挡时返回 null */
  windowDropTarget(point: { x: number; y: number }): Promise<string | null>;
  /** 暂存标签页迁移数据（一次性 token，60 秒过期，≤256 MiB） */
  transferPut(bytes: Uint8Array): Promise<string>;
  transferTake(token: string): Promise<Uint8Array>;
  /** 将本窗口的 token 绑定到一个已初始化窗口，并定向投递移入请求 */
  transferSend(token: string, target: string, placement?: TransferPlacement): Promise<void>;
  /** 目标窗口在文档及光标恢复完成后确认；仅已绑定的接收窗口可以调用 */
  transferAccept(token: string): Promise<void>;
  /** 仅发起窗口可查；目标关闭或超时均返回 missing，源文档必须保留 */
  transferStatus(token: string): Promise<TransferStatus>;
  transferCancel(token: string): Promise<void>;
  /** 仅绑定的目标窗口可拒绝；拒绝后源会立即收到 missing 并保留原文档 */
  transferReject(token: string): Promise<void>;
  /** 按键合并写入 settings.json，返回写入后的完整对象；后端向所有窗口广播 settings-changed */
  settingsPatch(patch: SettingsPatch): Promise<SettingsSnapshot>;
  onSettingsChanged(fn: (e: SettingsChanged) => void): Promise<void>;
  /** 菜单"退出"：先收集所有窗口的确认，任一取消都会中止整体退出 */
  requestQuit(): Promise<void>;
  replyQuit(requestId: string, allow: boolean): Promise<void>;
  onQuitRequested(fn: (request: QuitRequest) => void): Promise<void>;
  onQuitApproved(fn: (request: QuitRequest) => void): Promise<void>;
  onQuitCancelled(fn: (request: QuitRequest) => void): Promise<void>;
  window: WindowApi;
  /** 窗口间消息（仅投递到目标窗口；监听只收发给本窗口的消息） */
  bus: WindowBus;
}

export interface WindowInit {
  files: string[];
  transferToken?: string;
}

export interface WindowOpenOptions {
  files?: string[];
  transferToken?: string;
  x?: number;
  y?: number;
}

export interface SettingsPatch {
  set?: Record<string, unknown>;
  remove?: string[];
}

export interface SettingsChanged {
  value: Record<string, unknown>;
  /** 发起写入的窗口 label */
  source: string;
  revision: number;
}

export interface SettingsSnapshot {
  value: Record<string, unknown>;
  revision: number;
}

export interface QuitRequest { requestId: string; purpose?: 'quit' | 'installUpdate' }

export interface TransferStatus {
  state: 'pending' | 'taken' | 'accepted' | 'missing';
  target?: string;
}

/** 标签栏插入槽；beforeId 使异步装载期间标签栏重排后仍跟随原落点的邻居。 */
export interface TransferPlacement {
  index: number;
  beforeId?: string;
}

export interface TransferOffer {
  token: string;
  source: string;
  placement?: TransferPlacement;
}

/** 物理像素（屏幕坐标） */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowBus {
  /** 本窗口 label（'main' / 'win-N'；mock 为 'main'） */
  label: string;
  /** 其他窗口 label 列表 */
  otherLabels(): Promise<string[]>;
  send(label: string, event: string, payload: unknown): Promise<void>;
  /** 只接收发往本窗口的消息 */
  on<T>(event: string, fn: (payload: T) => void): Promise<void>;
  /** 某窗口外框的屏幕矩形（物理像素）；窗口不存在或不可见时 null */
  outerRect(label: string): Promise<ScreenRect | null>;
  /** 本窗口客户区左上角的屏幕坐标（物理像素）与缩放 */
  innerOrigin(): Promise<{ x: number; y: number; scale: number }>;
  /** 鼠标屏幕坐标（物理像素） */
  cursor(): Promise<{ x: number; y: number }>;
}

export interface BundledFont {
  family: string;
  weight: 400 | 700;
  style: 'normal' | 'italic';
  format: 'woff2';
  path: string;
  /**
   * 用途提示（IPC.md 目前未定义，后端暂不返回）。缺省时前端按 themes/fonts.ts 的已知 UI 字体表判断，
   * 其余一律视为代码字体。
   */
  role?: 'mono' | 'ui';
}

export interface FileAssocStatus {
  ext: string;
  registered: boolean;
  /** null = UserChoice 缺失或不可读 */
  isDefault: boolean | null;
}

export interface ThemeEntry {
  id: string;
  fileName: string;
  json: Record<string, unknown>;
}

export interface ImportedTheme {
  id: string;
  json: Record<string, unknown>;
}

const EXT_RE = /^[a-z0-9_+-]{1,16}$/;
/** 文件关联扩展名校验（IPC.md）：非法输入直接拒绝 */
export function validExts(exts: string[]): string[] {
  const bad = exts.find((e) => !EXT_RE.test(e));
  if (bad !== undefined) throw { kind: 'invalidArgument', message: `invalid extension: ${bad}` } satisfies IpcError;
  return exts;
}

export interface CloseRequest {
  preventDefault(): void;
}

export interface WindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
  /** 强制关闭，不触发 onCloseRequested */
  destroy(): Promise<void>;
  onResized(fn: () => void): Promise<void>;
  onFocusChanged(fn: (focused: boolean) => void): Promise<void>;
  onCloseRequested(fn: (e: CloseRequest) => void | Promise<void>): Promise<void>;
  /**
   * 设置窗口材质（Win11 Mica / Acrylic）；'none' 清除。返回 false 表示不支持或失败。
   * theme 为材质着色的明暗（null = 跟随系统）；DWM 材质按窗口主题着色，而非系统应用主题。
   */
  setMaterial(material: WindowMaterial, theme: 'light' | 'dark' | null): Promise<boolean>;
  /** 设置原生窗口标题（任务栏 / Alt+Tab 显示）；失败时静默（需 core:window:allow-set-title 权限） */
  setTitle(title: string): Promise<void>;
  /** 把本窗口带到前台；失败时静默 */
  focus(): Promise<void>;
  /** 从当前按下的鼠标开始系统级窗口拖动（须在 pointerdown/move 期间调用） */
  startDragging(): Promise<void>;
}

export type WindowMaterial = 'mica' | 'acrylic' | 'none';

export function isIpcError(e: unknown): e is IpcError {
  return !!e && typeof e === 'object' && 'kind' in e && 'message' in e;
}

export function errorMessage(e: unknown): string {
  if (isIpcError(e)) return `${e.kind}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
