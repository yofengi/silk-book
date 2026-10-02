# 帛书（Boshu）架构设计

轻量级文本 / 代码 / Markdown 编辑器。目标平台：Windows 10/11（x64）。

## 1. 设计目标与约束

| 目标 | 指标 |
|---|---|
| 冷启动 | 窗口可交互 < 500ms |
| 空载内存 | < 80MB（含 WebView2） |
| 安装包 | < 15MB |
| 常规文件 | ≤ 10MB 全功能 |
| 大文件 | 10–100MB 流畅编辑（降级模式） |
| 超大文件 | > 100MB 分块加载 + 进度条，可取消 |

原则：
- **核心最小化**：启动只加载编辑器核心；语言包、Markdown 预览、KaTeX/Mermaid 等全部懒加载。
- **单一命令入口**：所有用户操作都是注册的命令（菜单、快捷键、命令面板、未来插件共用）。
- **边界清晰**：Rust 负责 I/O 与系统能力，前端负责编辑与渲染；两者只通过 `ipc` 层定义的接口通信。
- **不提前实现**：插件/LSP 在 v1 只定义接口与目录位置，不实现加载器。

## 2. 技术栈

- 外壳：Tauri 2（Rust stable，WebView2）
- 前端：Vite + TypeScript（strict），**不使用 UI 框架**
- 编辑器：CodeMirror 6
- Markdown：markdown-it（+ 懒加载 KaTeX、Mermaid；代码块高亮复用 CodeMirror 的 Lezer 解析器，避免引入第二套高亮引擎）
- 编码检测：Rust `chardetng` + `encoding_rs`
- 包管理：pnpm；Tauri CLI 作为 npm devDependency（`@tauri-apps/cli`）

## 3. 目录结构

```
帛书/
├─ docs/                     # 本文档、计划
├─ src-tauri/                # Rust 后端
│  ├─ src/
│  │  ├─ main.rs             # 入口，仅调用 lib::run
│  │  ├─ lib.rs              # Builder、插件注册、命令注册
│  │  ├─ commands/           # #[tauri::command]，薄层，只做参数转换
│  │  │  ├─ file.rs
│  │  │  └─ settings.rs
│  │  ├─ fs/                 # 文件读写核心逻辑（可单测，不依赖 tauri）
│  │  │  ├─ read.rs          # 分块读取、进度
│  │  │  ├─ write.rs         # 原子写入
│  │  │  └─ encoding.rs      # 编码/BOM/换行符检测与转换
│  │  ├─ settings.rs         # 配置加载/保存（JSON）
│  │  └─ error.rs            # 统一错误类型 AppError（serde 序列化给前端）
│  └─ tauri.conf.json
├─ src/                      # 前端
│  ├─ main.ts                # 启动：最少量初始化
│  ├─ core/
│  │  ├─ commands.ts         # 命令注册表
│  │  ├─ keybindings.ts      # 快捷键 → 命令
│  │  ├─ events.ts           # 类型化事件总线
│  │  └─ settings.ts         # 前端配置访问（带默认值与 schema）
│  ├─ ipc/                   # 对 Rust 调用的唯一封装层（类型与 Rust 对齐）
│  ├─ editor/
│  │  ├─ document.ts         # Document 模型：路径、编码、EOL、dirty、大小档位
│  │  ├─ tabs.ts             # 标签页管理
│  │  ├─ view.ts             # CodeMirror 实例创建、Compartment 管理
│  │  ├─ languages.ts        # 扩展名 → 语言包 的懒加载映射
│  │  └─ large-file.ts       # 大文件降级策略
│  ├─ markdown/
│  │  ├─ preview.ts          # 预览面板、增量/分段渲染
│  │  └─ scroll-sync.ts
│  ├─ ui/                    # 原生 DOM 组件：顶栏、标签栏、状态栏、命令面板、进度条
│  ├─ themes/                # CSS 变量主题（light.css / dark.css）
│  └─ extensions/            # v1 仅放接口定义 api.ts，不实现加载
└─ package.json
```

## 4. 关键设计

### 4.1 文件大小分档

由 Rust 在 `file_stat` 时返回大小，前端据此决定档位（阈值可配置）：

| 档位 | 大小 | 行为 |
|---|---|---|
| Normal | ≤ 10MB | 一次读取；全功能 |
| Large | 10–100MB | 一次读取；视口高亮 + 预渲染；小地图、单词补全默认关闭 |
| Huge | > 100MB | 分块流式读取 + 进度条（可取消），完成后按 Large 处理 |

**Large 档高亮策略**：CodeMirror 6 的 Lezer 解析本身是增量且按视口推进的。实现方式为：
- 限制解析工作时间片（`syntaxParserRunning` / 自定义 `ViewPlugin` 在空闲时 `forceParsing` 到视口下方 N 屏，N 默认 3），实现“可见区高亮 + 下方预渲染”；
- 不在主线程一次性全量解析。

**Large 档 Markdown 预览**：按顶层块（标题/段落分组）分段渲染，只把视口及下方 N 屏对应的段落插入 DOM，其余用占位高度；滚动时补渲染。

**顶栏开关**：“小地图”“单词补全”作为顶栏切换按钮，本质是命令 `view.toggleMinimap` / `editor.toggleWordCompletion`，通过 CodeMirror `Compartment` 热切换，状态为每标签页独立。

> 注：CodeMirror 6 官方无小地图，v1 使用社区包 `@replit/codemirror-minimap`；封装在 `editor/view.ts` 的单个 Compartment 内，便于日后替换。

### 4.2 IPC 与大文件传输

- 普通命令用 `invoke` + serde JSON。
- 文件内容**不走 JSON 字符串**：
  - 读取：Rust 端解码为 UTF-8 后，通过 `tauri::ipc::Channel<InvokeResponseBody::Raw>` 分块（默认 4MB）推送字节，同时推送进度事件；前端 `TextDecoder({stream:true})` 拼接。
  - 写入：前端 `TextEncoder` 编码后以 `Uint8Array` 作为原始请求体发送（Tauri 2 支持 raw body），Rust 按目标编码转换后写入。
- 取消：每次读取分配 `request_id`，`cancel_read(request_id)` 置位 `AtomicBool`。

### 4.3 编码与换行符

- 检测：BOM 优先 → `chardetng` 抽样前 64KB → 默认 UTF-8。
- 前端统一使用 `\n`，Document 记录原 EOL（LF/CRLF/混合），保存时还原。
- 状态栏可点击切换编码（重新解码 / 另存编码）与 EOL。

### 4.4 原子保存

写入同目录临时文件 → `fsync` → `ReplaceFileW`（保留原文件属性/ACL，经 `windows` crate）失败时回退 `rename`。

### 4.5 命令系统（扩展性核心）

```ts
interface Command {
  id: string;                    // 'file.open'、'view.toggleMinimap'
  title: string;
  run(ctx: CommandContext, args?: unknown): unknown | Promise<unknown>;
  when?(ctx: CommandContext): boolean;   // 可用条件
}
```
菜单、快捷键、命令面板只引用命令 id。未来插件通过同一注册表贡献命令。

### 4.6 主题

- 主题 = 一组 CSS 变量（UI）+ CodeMirror `HighlightStyle`（由同一份变量生成）。
- 内置：`glass-system`（默认）/ `glass-dark` / `glass-light` / `system` / `light` / `dark`，存于设置 `workbench.theme`。
- 预留：VS Code 主题导入（未实现）。

#### 用户主题 JSON

用户主题通过「设置 → 外观 → 导入主题」（`theme_import`）复制到 `%APPDATA%\Boshu\themes\`，设置中存为 `workbench.theme = "user:<id>"`。示例见 `docs/theme-sample.json`。

```json
{
  "name": "Solarized Night",
  "kind": "dark",
  "glass": false,
  "colors": { "--bg": "#002b36", "--accent": "#268bd2", "--tok-keyword": "#859900" }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 显示名，截断到 60 字符；缺省用文件 id |
| `kind` | `"light"` \| `"dark"` | 必填。决定基底主题（`data-theme`）与 CodeMirror dark 标志 |
| `glass` | boolean? | 为 `true` 时叠加在 `glass-<kind>` 上并启用窗口材质，否则叠加在 `<kind>` 上 |
| `colors` | object | 必填。键 = CSS 变量名，值 = CSS 值 |

应用规则（`src/themes/user.ts` 校验，`src/themes/index.ts` 应用）：

- 分层：先应用基底主题的 CSS，再把 `colors` 以 inline style 写到 `<html>`，只覆盖列出的变量；切换主题时清除上一层。
- 键白名单：只接受 themes/*.css 中定义的颜色类变量（`THEME_VARS`：`--bg`、`--fg`、`--accent`、`--editor-bg`、`--float-*`、`--tok-*` 等）。字体/字号变量（`--ui-font`、`--mono-font`、`--*-font-size`）不在此列，由字体设置负责。未知键忽略并在导入时提示。
- 值校验（任一不满足即丢弃该键）：字符集限定为 `#`、字母、数字、空白、`. , % ( ) + - / *`，因此 `;` `{` `}` `:` `!` `@` `\` 引号 `<` `>` 均被拒绝；长度 ≤ 240；括号必须配对；出现的每个函数必须在白名单内（`rgb/rgba/hsl/hsla/hwb/lab/lch/oklab/oklch/color/color-mix`、`*-gradient`、`calc`），所以 `url()`、`image()`、`element()`、`attr()`、`expression()` 等都会被拒绝。
- 损坏或不合法的主题文件在列表中跳过；当前选中的用户主题被删除或失效时回退到对应的内置主题。
- `index.html` 的首帧脚本不理解 `user:`：`localStorage` 缓存写入基底主题 id（`glass-<kind>` 或 `<kind>`），首帧不闪烁，用户层在设置加载后应用。

### 4.7 配置

- 位置：`%APPDATA%\Boshu\settings.json`。
- 前端 `core/settings.ts` 维护 schema + 默认值；Rust 只负责读写文件，不理解字段。
- 未知字段保留，保证向前兼容。

### 4.8 预留扩展点（v1 只写接口，不实现）

- `extensions/api.ts`：`activate(ctx)` 生命周期、贡献点（commands / languages / themes / previewRenderers）。
- LSP：未来在 Rust 端管理语言服务器子进程，前端通过 ipc 桥接；v1 不涉及。

### 4.9 i18n

- 实现：`src/i18n/`，无第三方库。`locales/zh-CN.ts`（`as const`）是唯一来源，静态打包进主 chunk；`Key` 类型由其派生，`t('不存在的键')` 编译报错。`en` / `zh-TW` / `ja` 类型为 `LocaleMessages`（深度可选），首次切换时 `import()` 懒加载为独立 chunk；缺失的键逐条回退 zh-CN，再缺失显示键名。
- 语言选择：设置 `workbench.language` = `'system' | 'zh-CN' | 'en' | 'zh-TW' | 'ja'`。`system` 经 `ipc.systemLocale()` 映射：`zh-TW` / `zh-HK` / `zh-MO` / `zh-Hant*` → zh-TW，其余 `zh*` → zh-CN，`ja*` → ja，否则 en。`main.ts` 在 `loadSettings()` 之后、`mountUI()` 之前 `await initLanguage()`，首屏不闪烁。
- 切换：`setLocale()` 设置 `<html lang>`、`document.title`，广播 `locale.changed`；顶栏 / 标签栏 / 状态栏、设置页、窗口标题监听后重绘，菜单与命令面板在下次打开时按新语言生成（切换时关闭已打开的）。
- 命令标题：`Command.title` 可为函数，内置命令一律 `() => t('cmd.<id>')`；读取统一用 `commandTitle(cmd)`。
- 产品名：`productName()`（帛书 / Silk Book / 帛書 / 帛書）不属于可翻译文案；文案里写 `{app}` 自动替换。
- 键名：`<命名空间>.<位置>.<含义>`，小驼峰。命名空间：`common`（通用词）、`lang`、`tab`、`toolbar`、`window`、`menu`、`palette`、`statusbar`、`files`、`editor`、`cmd.<命令 id>`、`theme`、`preview`、`dev`（仅 mock）、`settings.<分组>.<控件>`（分组 = `appearance` / `fonts` / `assoc` / `keys` / `language`）。按含义复用，不按中文字面复用。
- 插值：`{name}`；复数用 ICU 子集 `{count, plural, =0 {…} one {# x} other {# xs}}`（`Intl.PluralRules`，分支内可含 `{name}`，不支持更深嵌套）。
- 新增语言：在 `types.ts` 的 `Locale`、`index.ts` 的 `LOCALES` / `LOCALE_NAMES` / `PRODUCT_NAMES` / `loaders` 各加一项，新建 `locales/<tag>.ts`（`const x: LocaleMessages = {...}; export default x;`），并在 `resolveLocale()` 补映射。
- 规则：`src/` 中用户可见文案一律走 `t()`；中文代码注释保留。

## 5. 技术债控制规则

1. 前端任何 Rust 调用必须经过 `src/ipc/`，禁止在业务代码直接 `invoke`。
2. `commands/*.rs` 只做参数转换；逻辑在 `fs/`，需有单元测试。
3. 所有用户操作必须是注册的命令；UI 不直接调用业务函数。
4. CodeMirror 的可切换功能一律用 Compartment，禁止重建 EditorView 来切功能。
5. 懒加载模块用动态 `import()`，并在 `vite` 构建中确认已拆分 chunk。
6. 阈值、分块大小、预渲染屏数等全部走配置常量，不写死在逻辑中。
7. 不引入 UI 框架、状态管理库；新增依赖需在 PR/任务说明中写明理由。
