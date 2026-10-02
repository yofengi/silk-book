import { t, type Key } from '../i18n';
import type { UpdateCheckResult } from '../ipc';

export function updateErrorText(kind: string): string {
  const keys: Record<string, Key> = {
    updateNetwork: 'updates.error.network', updateTimeout: 'updates.error.timeout',
    updateRateLimit: 'updates.error.rateLimit', updateInvalidRelease: 'updates.error.invalidRelease',
    updateOpen: 'updates.error.open',
  };
  return t(keys[kind] ?? 'updates.error.generic');
}

export function updateResultText(result: UpdateCheckResult, platform: string): string {
  switch (result.status) {
    case 'noReleases': return t('updates.nonePublished');
    case 'current': return t('updates.current');
    case 'available': return t('updates.available', { version: result.release?.version ?? '—' });
    case 'noAsset': return t('updates.noAsset', { version: result.release?.version ?? '—', platform });
  }
}
