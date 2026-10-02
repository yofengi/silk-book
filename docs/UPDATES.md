# 版本检查与发布

应用使用公开仓库 [yofengi/silk-book](https://github.com/yofengi/silk-book) 的 GitHub Releases。用户无需提供 GitHub 凭据。

## 用户行为

设置导航的“关于”位于“快捷键”下方，显示当前版本、GitHub 入口、手动检查更新和检查间隔。

| 间隔 | 后台检查周期 |
| --- | --- |
| 默认 | 每 24 小时 |
| 随时 | 每小时 |
| 每周 | 每 7 天 |
| 每月 | 每 30 天 |

启动后延迟检查，不阻塞编辑器加载；到期时间持久化，多个窗口共享检查状态。手动检查不受后台间隔限制。

后台发现更高的稳定版本时，顶栏显示下载图标。用户可查看更新说明、下载当前系统及架构的安装包，或忽略该版本。忽略记录只隐藏相应版本的后台提示，手动检查仍可查看；后续新版本会重新提示。

下载安装包通过系统默认浏览器进行。应用不静默替换当前程序，也不会为了更新而关闭正在编辑的文件。

## 发布约定

- 版本保持 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 一致，使用 `v0.1.0` 形式的 tag。
- 应用查询 `/repos/yofengi/silk-book/releases/latest`，比较稳定语义版本；草稿与预发布不作为正式更新。
- 安装包名称包含平台和架构：`silk-book-<version>-windows-x64-setup.exe`、`silk-book-<version>-macos-arm64.dmg`、`silk-book-<version>-macos-x64.dmg`。
- GitHub Actions 的 `Build installers` 工作流先生成原生安装包和校验文件，验证完成后再发布正式 Release。
- 网络失败、尚无正式发布、当前平台没有安装包和已经是最新版本分别显示，不能互相替代。

## 平台状态

Windows 设置目录沿用 `%APPDATA%/Boshu`。macOS 使用 `~/Library/Application Support/Boshu`。尺寸记忆由常规页的“记住窗口大小”开关控制，默认启用。

macOS 产物在 macOS runner 构建并检查临时签名；正式 Apple 开发者签名和公证需要维护者另行配置凭据。
