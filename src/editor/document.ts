// Document 模型：路径、编码、EOL、dirty、大小档位
import type { Eol } from '../ipc';
import { getSetting } from '../core/settings';
import { t } from '../i18n';

export type SizeTier = 'Normal' | 'Large' | 'Huge';

export interface DocumentInfo {
  path: string | null; // null = 未保存的新文件
  encoding: string;
  eol: Eol;
  hasBom: boolean;
  /** 仅 eol === 'MIXED'：读取时的原始换行序列，保存时原样传回 */
  eolMap?: string;
  /** “通过编码重新打开”选定的读取编码；之后“重新加载”沿用 */
  readEncoding?: string;
  /** 解码时出现非法字节 */
  malformed?: boolean;
  size: number;
  tier: SizeTier;
  dirty: boolean;
}

export function sizeTier(size: number): SizeTier {
  if (size > getSetting('files.hugeFileThreshold')) return 'Huge';
  if (size > getSetting('files.largeFileThreshold')) return 'Large';
  return 'Normal';
}

export function createDocument(init: Partial<DocumentInfo> = {}): DocumentInfo {
  const size = init.size ?? 0;
  return {
    path: null,
    encoding: 'UTF-8',
    eol: 'LF',
    hasBom: false,
    dirty: false,
    ...init,
    size,
    tier: init.tier ?? sizeTier(size),
  };
}

export function baseName(path: string | null): string {
  if (!path) return t('tab.untitled');
  return path.replace(/^mock:\/\//, '').split(/[\\/]/).pop() || path;
}

/** Windows 路径身份：统一大小写、分隔符及扩展长度路径前缀。 */
export function pathKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase();
}
