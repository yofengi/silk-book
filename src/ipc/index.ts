// 前端对 Rust 调用的唯一入口。在 Tauri 中使用真实实现；普通浏览器（pnpm dev）回退到 mock。
import { mockIpc } from './mock';
import { tauriIpc } from './tauri';
import type { IpcApi } from './types';

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const ipc: IpcApi = inTauri ? tauriIpc : mockIpc;
export * from './types';
