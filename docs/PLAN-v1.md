# 帛书 v1 开发计划

范围以 `ARCHITECTURE.md` 为准。v1 **不做**：插件加载器、LSP、跨平台、VS Code 主题导入、文件树/工作区、自动更新、多窗口。

## 任务划分

后端任务由 A1 负责，前端任务由 A2 负责，主代理负责集成和验收。每个任务完成时都必须能通过 `pnpm build`，以及 `cargo test`（在 src-tauri 下运行）。

### M0 项目骨架（A1）
- 创建 Tauri 2 + Vite + TS 项目，包管理器用 pnpm，`@tauri-apps/cli` 装为 devDependency。
- 按架构文档建好目录结构，放空模块。开启 TS strict 和 ESLint 基础配置。
- 在 `tauri.conf.json` 中设置 capabilities，只开放需要的权限，包括 dialog 插件。
- 验收：`pnpm tauri dev` 能打开一个空窗口。

### M1 Rust 文件 I/O（A1）
- 实现 `fs/encoding.rs`：检测 BOM、用 chardetng 检测编码、检测换行符（EOL），并完成编码与 UTF-8 之间的互转。需要单元测试。
- 实现 `fs/read.rs`：分块读取文件，通过 Channel 推送数据和进度，支持用 request_id 取消。需要单元测试。
- 实现 `fs/write.rs`：原子写入，优先用 ReplaceFileW，失败时回退到 rename。需要单元测试。
- 在 `commands/file.rs` 中提供这些命令：`file_stat`、`read_file`、`cancel_read`、`write_file`（请求体为原始字节）。
- 实现 `settings.rs`，读写 `%APPDATA%\Boshu\settings.json`。
- 实现 `error.rs`，定义统一错误类型 AppError。
- 验收：`cargo test` 全部通过，并且提供一份用于前端对接的 IPC 接口说明，写入 `docs/IPC.md`。

### M2 前端核心（A2，依赖 M0；ipc 部分依赖 M1）
- 在 `core/` 中实现命令注册表、快捷键、事件总线和配置模块。
- 在 `ipc/` 中对 M1 的接口做类型化封装。
- 在 `editor/` 中实现：
  - Document 模型；
  - 多标签页；
  - EditorView 与 Compartment 管理；
  - 语言懒加载，覆盖 JS/TS、Python、Rust、C/C++、Java、Go、HTML、CSS、JSON、YAML、Markdown、SQL、XML；
  - 查找替换，使用 @codemirror/search。
- 在 `ui/` 中实现顶栏（包含小地图开关和单词补全开关）、标签栏、状态栏（显示编码、EOL、语言、档位）、命令面板和进度条。
- 实现文件的打开、保存、另存为和最近文件列表。关闭有未保存修改的标签页时要提示确认。
- 验收：能正常打开、编辑、保存各种编码的文件，快捷键和命令面板可用。

### M3 大文件策略（A2，依赖 M2）
- 在 `editor/large-file.ts` 中实现：自动判断文件档位；高亮只分析可见区域，并预渲染视口下方 N 屏；Large 档默认关闭小地图和单词补全，但可以在顶栏打开。
- Huge 档显示进度条，并支持取消。
- 验收：50MB 和 150MB 的测试文件打开时界面不卡死，滚动流畅。

### M4 Markdown（A2，依赖 M2）
- 支持分屏预览，编辑区和预览区同步滚动，使用 markdown-it 渲染（包括 GFM 表格和任务列表）。
- KaTeX 和 Mermaid 按需懒加载。预览中的代码块用 Lezer 高亮。
- Large 档的预览按段落分段渲染，只渲染视口及下方 N 屏。
- 渲染输出要做 XSS 防护：禁用原始 HTML，或者用 DOMPurify 清洗。
- 验收：常见 Markdown 语法都能正确渲染，预览中不能执行脚本。

### M5 主题与收尾（A2 负责前端，A1 负责打包）
- 实现 light 和 dark 两套 CSS 变量主题，支持跟随系统，并生成对应的 CodeMirror HighlightStyle。
- 在 `extensions/api.ts` 中只写接口定义。
- A1 配置 NSIS 安装包，并检查安装包体积。
- 验收：测量启动时间、空载内存和安装包体积，结果对照架构文档第 1 节的目标。

## 执行顺序

M0 完成后，M1 和 M2 并行推进（M2 先用 mock 的 ipc）。之后依次进行 M3 和 M4，最后是 M5。
