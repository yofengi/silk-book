import { getLocale, t, type Key } from '../i18n';
import type { UpdateCheckResult, UpdateTransferState } from '../ipc';

export function updateErrorText(kind: string): string {
  const keys: Record<string, Key> = {
    updateNetwork: 'updates.error.network', updateTimeout: 'updates.error.timeout',
    updateRateLimit: 'updates.error.rateLimit', updateInvalidRelease: 'updates.error.invalidRelease',
    updateOpen: 'updates.error.open',
    updateDownload: 'updates.error.download', updateSignature: 'updates.error.signature',
    updateCache: 'updates.error.cache', updateInstall: 'updates.error.install',
    updateBusy: 'updates.error.busy', updateSettings: 'updates.error.settings',
    unsupported: 'updates.error.unsupported',
  };
  return t(keys[kind] ?? 'updates.error.generic');
}

export function updateTransferPercent(transfer: UpdateTransferState): number | null {
  if (transfer.phase === 'ready' || transfer.phase === 'preparingInstall' || transfer.phase === 'installing') return 100;
  return transfer.totalBytes !== null && transfer.totalBytes > 0
    ? Math.max(0, Math.min(100, Math.floor(transfer.downloadedBytes / transfer.totalBytes * 100))) : null;
}

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const unit = Math.min(3, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${units[unit]}`;
}

export function updateProgressText(transfer: UpdateTransferState): string {
  const percent = updateTransferPercent(transfer);
  return transfer.totalBytes !== null && transfer.totalBytes > 0
    ? t('updates.progressKnown', { downloaded: bytes(transfer.downloadedBytes), total: bytes(transfer.totalBytes), percent: percent ?? 0 })
    : t('updates.progressUnknown', { downloaded: bytes(transfer.downloadedBytes) });
}

export function updateTransferText(transfer: UpdateTransferState): string {
  const version = transfer.release?.version ?? '—';
  switch (transfer.phase) {
    case 'idle': return '';
    case 'downloading': return t('updates.downloading', { version, progress: updateProgressText(transfer) });
    case 'verifying': return t('updates.verifying', { version });
    case 'ready': return t('updates.ready', { version });
    case 'preparingInstall': return t('updates.preparingInstall');
    case 'installing': return t('updates.installing');
    case 'error': return updateErrorText(transfer.error?.kind ?? 'updateDownload');
  }
}

export function updateResultText(result: UpdateCheckResult, platform: string): string {
  switch (result.status) {
    case 'noReleases': return t('updates.nonePublished');
    case 'current': return t('updates.current');
    case 'available': return t('updates.available', { version: result.release?.version ?? '—' });
    case 'noAsset': return t('updates.noAsset', { version: result.release?.version ?? '—', platform });
  }
}
