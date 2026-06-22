/**
 * Regression test: the account "Cloud Storage Usage" / Overview "Usage" bar
 * must reflect the LIVE storage usage (SUM(files.file_size) from
 * GET /api/storage/stats), not the dead `user.storage_usage_bytes` column.
 *
 * `getStoragePlanData` reads that column (always 0), so before the fix the
 * storage quota's `used` was always 0 even when the user had data stored. The
 * hook now overlays the live `usage` returned by `getStorageStats()`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { StorageStats } from '@/libs/storage';

const useAuthMock = vi.fn<() => { user: { storageUsageBytes: number } | null }>(() => ({
  user: { storageUsageBytes: 0 },
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

// Pass-through translator so tooltip interpolation doesn't blow up.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

const getStorageStatsMock = vi.fn<() => Promise<StorageStats>>();
vi.mock('@/libs/storage', () => ({
  getStorageStats: () => getStorageStatsMock(),
}));

// Deterministic plan: 1 GiB quota, usage 0 (the dead-column value). Keeps the
// translation plan trivial so this test focuses on storage.
const ONE_GIB = 1024 * 1024 * 1024;
vi.mock('@/utils/access', () => ({
  getStoragePlanData: () => ({ plan: 'free', usage: 0, quota: ONE_GIB }),
  getTranslationPlanData: () => ({ plan: 'free', usage: 0, quota: 10 * 1024 }),
  getUserProfilePlan: () => 'free',
}));

import { useQuotaStats } from '@/hooks/useQuotaStats';

describe('useQuotaStats — live storage usage', () => {
  beforeEach(() => {
    getStorageStatsMock.mockReset();
    useAuthMock.mockReturnValue({ user: { storageUsageBytes: 0 } });
  });
  afterEach(() => cleanup());

  test('storage quota used reflects the live usage, not the 0 column', async () => {
    const liveUsage = 108 * 1024 * 1024; // ~108 MiB
    getStorageStatsMock.mockResolvedValue({
      totalFiles: 3,
      totalSize: liveUsage,
      usage: liveUsage,
      quota: ONE_GIB,
      usagePercentage: 11,
      byBookHash: [],
    });

    const { result } = renderHook(() => useQuotaStats());

    // Once the live fetch resolves the storage quota's `used` must be non-zero
    // (~108 MiB expressed in GB against a 1 GiB quota), not the column's 0.
    await waitFor(() => {
      const storage = result.current.quotas[0];
      expect(storage).toBeDefined();
      expect(storage!.used).toBeGreaterThan(0);
    });

    const storage = result.current.quotas[0]!;
    // 108 MiB / 1024 = 0.105... GB, rounded to 2 dp.
    expect(storage.unit).toBe('GB');
    expect(storage.used).toBeCloseTo(0.11, 2);
    expect(storage.total).toBe(1);
  });

  test('signed-out user produces no quotas and never calls the authed endpoint', async () => {
    useAuthMock.mockReturnValue({ user: null });
    const { result } = renderHook(() => useQuotaStats());
    expect(result.current.quotas).toEqual([]);
    expect(getStorageStatsMock).not.toHaveBeenCalled();
  });
});
