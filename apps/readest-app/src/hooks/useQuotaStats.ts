import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getStorageStats } from '@/libs/storage';
import type { QuotaType, UserPlan } from '@/types/quota';
import { getStoragePlanData, getTranslationPlanData, getUserProfilePlan } from '@/utils/access';
import { useTranslation } from './useTranslation';

export const useQuotaStats = (briefName = false) => {
  const _ = useTranslation();
  const { user } = useAuth();
  const [quotas, setQuotas] = useState<QuotaType[]>([]);
  const [userProfilePlan, setUserProfilePlan] = useState<UserPlan | undefined>(undefined);
  // Live storage usage from GET /api/storage/stats (SUM(files.file_size)).
  // The `user.storage_usage_bytes` column is never written, so the plan-derived
  // usage is always 0; we overlay the live value once it loads. `undefined`
  // means "not yet fetched" so we fall back to the (stale) plan usage until the
  // network round-trip resolves.
  const [liveStorageUsage, setLiveStorageUsage] = useState<number | undefined>(undefined);

  // Fetch the live storage usage whenever the signed-in user changes (this also
  // covers the account page's refresh(): it calls authClient refetch(), which
  // produces a new `user` identity and re-runs this effect). Guard the no-user
  // / SSR case so we never call the authed endpoint while signed out.
  useEffect(() => {
    if (!user) {
      setLiveStorageUsage(undefined);
      return;
    }
    let cancelled = false;
    getStorageStats()
      .then((stats) => {
        if (!cancelled) setLiveStorageUsage(stats.usage);
      })
      .catch((error) => {
        // Non-fatal: keep showing the plan-derived usage if the fetch fails.
        console.error('Failed to load live storage usage:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;

    const storagPlan = getStoragePlanData(user);
    // Prefer the live SUM(file_size) usage once fetched; fall back to the
    // plan-derived value (0 today) until then.
    const storageUsage = liveStorageUsage ?? storagPlan.usage;
    const inGB = storagPlan.quota > 1e9;
    const storagePercentage =
      storagPlan.quota > 0 ? Math.round((storageUsage / storagPlan.quota) * 100) : 0;
    const storageQuota: QuotaType = {
      name: briefName ? _('Storage') : _('Cloud Sync Storage'),
      tooltip: _('{{percentage}}% of Cloud Sync Space Used.', {
        percentage: storagePercentage,
      }),
      used: parseFloat((storageUsage / 1024 / 1024 / (inGB ? 1024 : 1)).toFixed(2)),
      total: Math.round((storagPlan.quota / 1024 / 1024 / (inGB ? 1024 : 1)) * 10) / 10,
      unit: inGB ? 'GB' : 'MB',
    };
    const translationPlan = getTranslationPlanData(user);
    const now = new Date();
    const translationResetAt = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    const translationQuota: QuotaType = {
      name: briefName ? _('Translation') : _('Translation Characters'),
      tooltip: _('{{percentage}}% of Daily Translation Characters Used.', {
        percentage: Math.round((translationPlan.usage / translationPlan.quota) * 100),
      }),
      used: Math.round(translationPlan.usage / 1024),
      total: Math.round(translationPlan.quota / 1024),
      unit: 'K',
      resetAt: translationResetAt,
    };
    setUserProfilePlan(getUserProfilePlan(user));
    setQuotas([storageQuota, translationQuota]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, liveStorageUsage]);

  return {
    quotas,
    userProfilePlan,
  };
};
