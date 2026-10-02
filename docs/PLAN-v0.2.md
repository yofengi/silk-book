# 帛书 v0.2 计划

> 历史实施计划。2026-10-02 接续后的实现与验收见 [COMPLETION-2026-10-02.md](COMPLETION-2026-10-02.md)，最终 IPC 契约见 [IPC.md](IPC.md)。英文显示名称按用户要求使用 `silk book`；移窗已升级为接收确认后移除源标签，全局退出使用全窗口投票。

在 v1 的基础上增加：常规设置、状态栏菜单、智能复制、标签拖拽/多窗口、多语言、关联文件图标。安装包先取消美化（保留文件关联页）。

## 1. 设置键（前端 `core/settings.ts` 是唯一 schema 来源）

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `editor.wordWrap` | boolean | 沿用现值 | 全局；顶栏换行按钮改写同一个键 |
| `editor.spellcheck` | boolean | false | 英文拼写错误波浪线 |
| `editor.highlightActiveLine` | boolean | true | 行 + 行号槽 |
| `editor.lineNumbers` | boolean | true | |
| `files.defaultEol` | `'CRLF'\|'LF'\|'CR'` | `'CRLF'` | 用于新建文件，以及打开时检测不出换行的文件 |
| `files.defaultEncoding` | `'utf-8'\|'utf-8-bom'\|'utf-16le-bom'\|'utf-16be-bom'\|'ansi'` | `'utf-8'` | 用于新建文件，以及空文件；已打开的文件保留检测出的编码 |
| `files.readEncoding` | `'auto'\|'utf-8'\|'ansi'` | `'auto'` | BOM 始终优先 |
| `editor.tabBehavior` | `'tab'\|'spaces2'\|'spaces4'\|'spaces8'` | `'tab'` | 同时决定自动缩进单位 |
| `workbench.statusBar` | boolean | true | |
| `editor.smartCopy` | boolean | false | 仅影响复制，不影响剪切 |
| `window.openFilesInNewWindow` | boolean | false | |
| `window.closeLastTabExits` | boolean | false | 关闭窗口内最后一个标签时关闭该窗口；最后一个窗口关闭即退出 |
| `workbench.language` | `'system'\|'zh-CN'\|'en'\|'zh-TW'\|'ja'` | `'system'` | 英文产品名 Silk Book |

内部标识（exe 名、`%APPDATA%\Boshu`、注册表 `Boshu.*`）保持 `Boshu` 不变，避免破坏已有配置和关联。

## 2. 新增/变更 IPC 契约（A1 实现，写入 `docs/IPC.md`，前端按此封装在 `src/ipc/`）

编码与换行
- `Eol` 增加 `'CR'`；混合换行映射字符增加 `R`（`C`=CRLF，`L`=LF，`R`=CR）。
- `read_file(path, requestId, channel, encoding?: string)`：`encoding` 为 `'auto'`（默认）、`'utf-8'`、`'ansi'` 或 `list_encodings` 里的 id。返回元数据增加 `malformed: boolean`（解码时出现了非法字节）。
- 写入 encoding 可为 `'ansi'`（后端解析为系统代码页）。遇到目标编码无法表示的字符时，返回错误 `{kind:'unmappable', message}`；请求头带 `x-boshu-allow-lossy: true` 时改用 `?` 替换后写入。**不允许写出 `&#NNNN;` 这种 HTML 实体。**
- `list_encodings() -> { id, label, group, bom }[]`：Unicode 系、ANSI（带系统代码页名）、GBK、GB18030、Big5、Shift_JIS、EUC-JP、EUC-KR、windows-125x 等常用编码。
- `ansi_encoding() -> { codePage: number, id: string }`

拼写与语言
- `spell_check(words: string[]) -> string[]`：返回拼错的词，使用 Windows 拼写检查 API（en-US），不内置词典。
- `system_locale() -> string`：取系统 UI 语言，如 `'zh-CN'`。

设置（多窗口下防止写丢）
- `settings_patch({ set?: Record<string, unknown>, remove?: string[] }) -> Settings`：后端加锁合并后写盘，再广播事件 `settings-changed { value, source: windowLabel }` 给所有窗口。

多窗口
- 窗口标签：`main`、`win-<n>`；capabilities 的 `windows` 为 `["main","win-*"]`。
- `window_open({ files?, transferToken?, x?, y? }) -> label`：新窗口配置与 main 相同（无边框、透明、阴影）。
- `window_init() -> { files: string[], transferToken?: string }`：每个窗口启动时调用一次。main 窗口拿到的是命令行文件。取代 `initial_open_files`，前端迁移后删除后者。
- `tab_transfer_put(raw body) -> token`、`tab_transfer_take(token) -> ArrayBuffer`：一次性取出，取后即删。body 格式由前端定义，后端不解析。
- `open-files` 事件只发给最近获得焦点的窗口。
- `app_request_quit()`：向所有窗口广播 `quit-requested`，每个窗口各自走未保存确认后自行销毁。
- 打开所在文件夹：使用 opener 插件的 `revealItemInDir`，权限只加 `opener:allow-reveal-item-in-dir`。

## 3. 任务与文件归属

| 阶段 | 代理 | 内容 | 可改文件 |
|---|---|---|---|
| 1 | A1 后端 | 第 2 节全部 | `src-tauri/src/**`（`associations.rs` 除外）、`Cargo.toml`、`capabilities/`、`docs/IPC.md` |
| 1 | A1 安装/图标 | 关联文件图标（代码类用代码图标，文本类和 Markdown 用文本图标）；安装包恢复默认外观，只保留文件关联页 | `src-tauri/icons/`、`installer/`、`nsis-hooks.nsh`、`tauri.conf.json`、`associations.rs`、`docs/INSTALLER.md` |
| 1 | A2 i18n | 语言基础设施，现有中文文案全部抽到 zh-CN | `src/**` |
| 2 | A2 常规 | 设置页"常规"分区、编辑器选项、状态栏菜单、智能复制、编码与换行 | `src/**` |
| 3 | A2 多窗口 | 标签拖拽排序、拖出建窗、启动偏好、设置同步、退出流程 | `src/**` |
| 4 | A2 翻译 | 翻译 en（Silk Book）、zh-TW、ja | `src/i18n/locales/**` |

## 4. 约束
- 继续遵守 ARCHITECTURE.md 第 5 节。
- 所有新增 UI 文案都走 `t()`。
- 开关用滑块，选择用下拉栏（与字体下拉栏同一套组件，毛玻璃风格）。
- 撤销历史不跨窗口传递（已知限制）。
- 每个窗口是一个新的 WebView2 渲染进程，会增加约 30–50MB 内存（已知代价）。
