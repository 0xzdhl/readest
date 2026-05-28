import { clientEnv } from '@/clientEnv';
import { DEFAULT_STORAGE_QUOTA } from '@/services/constants';
import type { UserPlan } from '@/types/quota';

/**
 * Storage quota grace headroom. Mirrors `@/utils/access.STORAGE_QUOTA_GRACE_BYTES`
 * (currently 10 MiB) so users aren't blocked from finishing an in-flight
 * upload that just barely crossed the limit.
 */
export const STORAGE_QUOTA_GRACE_BYTES = 10 * 1024 * 1024;

interface StoragePlanUserFields {
  plan?: string | null;
  storageUsageBytes?: number | null;
  storagePurchasedBytes?: number | null;
}

/**
 * Server-side storage-plan resolution. Pure: reads only the user fields
 * passed in plus env-overridable fixed quota. Used by every storage route to
 * gate uploads against the caller's plan + purchased quota.
 */
export function getStoragePlanData(user: StoragePlanUserFields): {
  plan: UserPlan;
  usage: number;
  quota: number;
} {
  const plan = ((user.plan ?? 'free') as UserPlan) || 'free';
  const usage = user.storageUsageBytes ?? 0;
  const purchasedQuota = user.storagePurchasedBytes ?? 0;
  const fixedQuota = clientEnv.VITE_STORAGE_FIXED_QUOTA ?? 0;
  const planQuota = fixedQuota || DEFAULT_STORAGE_QUOTA[plan] || DEFAULT_STORAGE_QUOTA['free'];
  const quota = planQuota + purchasedQuota;
  return { plan, usage, quota };
}
