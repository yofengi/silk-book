import './themes/light.css';
import './themes/dark.css';
import './themes/glass-light.css';
import './themes/glass-dark.css';
import './style.css';
import { executeCommand } from './core/commands';
import { events } from './core/events';
import { installKeybindings } from './core/keybindings';
import { loadSettings, watchSettings } from './core/settings';
import { startUpdateService } from './core/updates';
import { registerEditorCommands } from './editor/commands';
import { setProgressHost } from './editor/files';
import { loadAnsi } from './editor/encodings';
import { mountEditor } from './editor/tabs';
import { installIncomingTransferListener, receiveTransferredTab } from './editor/transfer';
import { productName } from './i18n';
import { initLanguage } from './i18n/boot';
import { ipc } from './ipc';
import { registerMarkdownCommands } from './markdown/controller';
import { registerSettingsCommands } from './settings/controller';
import { mountUI } from './ui';
import { windowLifecycleReady } from './ui/window';
import { installThemeWatcher } from './themes';
import { registerThemeCommands } from './themes/commands';
import { installFontWatcher } from './themes/fonts';

/** 依次打开（file.open 内部按路径去重，已打开的只激活） */
async function openAll(paths: string[], hereFirst = true): Promise<void> {
  for (const [index, p] of paths.entries()) {
    try {
      // 本窗接收首个启动文件；后续文件沿用打开偏好，避免再次转发首个文件。
      await executeCommand('file.open', { paths: [p], here: hereFirst && index === 0 });
    } catch (e) {
      console.error('open failed', p, e);
    }
  }
}

async function start(): Promise<void> {
  await loadSettings();
  await watchSettings();
  // 界面语言须在首次挂载 UI 之前就绪（避免先显示中文再切换）；窗口标题 = 当前语言的产品名
  await initLanguage();
  // 系统 ANSI 代码页：默认编码为 ansi 时需要实际代码页；失败时回退 'ansi' 交后端解析
  await loadAnsi();
  const syncTitle = () => void ipc.window.setTitle(productName());
  syncTitle();
  events.on('locale.changed', syncTitle);
  installThemeWatcher();
  installFontWatcher();
  registerEditorCommands();
  const root = document.getElementById('app');
  if (!root) throw new Error('#app not found');
  const { editorHost, previewHost, overlayHost, specialHost } = mountUI(root);
  setProgressHost(overlayHost);
  mountEditor(editorHost);
  registerMarkdownCommands(previewHost);
  registerThemeCommands();
  registerSettingsCommands(specialHost);
  startUpdateService();
  installKeybindings();
  await windowLifecycleReady();
  await installIncomingTransferListener();

  // 先订阅第二实例的 open-files，再取本窗口的启动数据；后端会暂存尚未初始化窗口的文件。
  await ipc.onOpenFiles((paths) => { void executeCommand('file.open', { paths }); });
  const initial = await ipc.windowInit();
  if (initial.transferToken) await receiveTransferredTab(initial.transferToken);
  await openAll(initial.files, !initial.transferToken);
}

void start();
