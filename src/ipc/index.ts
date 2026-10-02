// 前端对 Rust 调用的唯一入口。在 Tauri 中使用真实实现；普通浏览器（pnpm dev）回退到 mock。
import { mockIpc } from './mock';
import { tauriIpc } from './tauri';
import type { IpcApi } from './types';
import { confirmDialog } from '../ui/confirm-dialog';

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// 文件选择仍由各平台实现；所有确认共用前端主题、队列和中断语义。
export const ipc: IpcApi = { ...(inTauri ? tauriIpc : mockIpc), confirm: confirmDialog };
export * from './types';
