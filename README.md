# 帛书 · silk book

帛书是一款基于 Tauri 2 和 CodeMirror 6 的桌面文本与代码编辑器，提供简体中文、English、繁體中文和日本語界面。

## 下载

在 [GitHub Releases](https://github.com/yofengi/silk-book/releases/latest) 下载对应平台的安装包：

- Windows x64：`silk-book-<版本>-windows-x64-setup.exe`
- macOS Apple Silicon：`silk-book-<版本>-macos-arm64.dmg`
- macOS Intel：`silk-book-<版本>-macos-x64.dmg`

校验文件 `SHA256SUMS.txt` 随安装包一同发布。macOS 首次发布使用临时签名，尚未经过 Apple 公证；系统可能要求在“隐私与安全性”中允许打开。

## 功能

- 多标签编辑、拖动排序、拖出新窗口和跨窗口合并，保留尚未保存的内容。
- 代码语法高亮、查找替换、小地图、单词补全和 Markdown 预览。
- 自动换行、行号、当前行高亮、英文拼写检查、智能复制及 Tab 行为设置。
- 编码和换行符读写设置；状态栏提供文件操作、编码重开与保存、换行符切换。
- 毛玻璃与经典外观、字体设置、自定义主题和快捷键。
- 可选的窗口尺寸记忆，以及 GitHub 发布版本检查、后台下载进度和确认安装更新。
- Windows 文件关联，分别使用文本与代码文件图标。

插件扩展接口已预留，当前版本尚不支持安装、加载第三方插件。

## 本地开发

安装 [Tauri 2 平台开发依赖](https://v2.tauri.app/start/prerequisites/)、Rust 稳定版、Node.js 22 或更新版本，以及 `package.json` 指定的 pnpm 版本。

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

仅预览前端可运行 `pnpm dev`；浏览器模式使用模拟文件和系统接口，不代表原生文件访问能力。

```sh
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
node --experimental-vm-modules --test scripts/a1-regression.test.mjs
node scripts/test-tab-transfers.mjs
node scripts/test-tab-merging.mjs
node scripts/test-tab-drop.mjs
```

Windows 打包：`pnpm tauri build --bundles nsis`。macOS 打包必须在 macOS 上运行，详见 [跨平台构建说明](docs/RELEASE-BUILD.md) 和 [Windows 安装说明](docs/INSTALLER.md)。

## 项目结构

- `src/`：编辑器、界面、设置、主题和多语言。
- `src-tauri/`：文件编码、原生窗口、操作系统功能和安装配置。
- `scripts/`：测试、验证和资源处理脚本。
- `docs/`：[架构](docs/ARCHITECTURE.md)及 [IPC 接口](docs/IPC.md)。

内置 Maple Mono NF CN 字体的许可见 [字体许可证](font/woff2/MapleMono-NF-CN-LICENSE.txt)。
