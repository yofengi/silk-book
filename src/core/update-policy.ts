import type { UpdateCheckResult } from '../ipc/types';

export const UPDATE_START_DELAY_MS = 12_000;
export const UPDATE_INTERVALS = [1, 24, 168, 720] as const;
const HOUR_MS = 3_600_000;

export function updateIntervalHours(value: unknown): number {
  return typeof value === 'number' && (UPDATE_INTERVALS as readonly number[]).includes(value) ? value : 24;
}

/** 时钟回拨与损坏的时间戳不会无限推迟检查。 */
export function nextUpdateDelay(lastCheckedAt: number, intervalHours: number, now: number): number {
  if (!Number.isSafeInteger(lastCheckedAt) || lastCheckedAt <= 0 || lastCheckedAt > now) return 0;
  return Math.max(0, lastCheckedAt + updateIntervalHours(intervalHours) * HOUR_MS - now);
}

export function shouldNotifyUpdate(result: UpdateCheckResult | null, ignoredVersion: string): boolean {
  return !!result?.release && (result.status === 'available' || result.status === 'noAsset')
    && result.release.version !== ignoredVersion;
}
