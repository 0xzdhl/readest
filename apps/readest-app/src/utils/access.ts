import { authClient, loadSessionToken } from '@/auth';
import { clientEnv } from '@/clientEnv';
import { DEFAULT_DAILY_TRANSLATION_QUOTA, DEFAULT_STORAGE_QUOTA } from '@/services/constants';
import { isTauriAppPlatform } from '@/services/environment';
import { getDailyUsage } from '@/services/translators/utils';
import type { UserPlan } from '@/types/quota';

/**
 * Subset of better-auth's `session.user` we read in the UI layer. Mirrors
 * the `additionalFields` declared in `auth/server.ts` (camelCase, matching
 * the drizzle schema's JS property names). All fields are optional / nullable
 * so callers can pass freshly-loaded users that haven't yet had the
 * additional fields hydrated (e.g. during sign-up); we fall back to the
 * free-tier defaults in that case.
 */
export interface PlanUser {
  plan?: string | null;
  storageUsageBytes?: number | null;
  storagePurchasedBytes?: number | null;
}

const pickPlan = (user: PlanUser | null | undefined): UserPlan => {
  const raw = (user?.plan ?? 'free') as UserPlan;
  return raw || 'free';
};

export const getSubscriptionPlan = (user: PlanUser | null | undefined): UserPlan => pickPlan(user);

export const getUserProfilePlan = (user: PlanUser | null | undefined): UserPlan => {
  let plan = pickPlan(user);
  if (plan === 'free') {
    const purchasedQuota = user?.storagePurchasedBytes ?? 0;
    if (purchasedQuota > 0) {
      plan = 'purchase';
    }
  }
  return plan;
};

export const STORAGE_QUOTA_GRACE_BYTES = 10 * 1024 * 1024; // 10 MB grace

export const getStoragePlanData = (user: PlanUser | null | undefined) => {
  const plan = pickPlan(user);
  const usage = user?.storageUsageBytes ?? 0;
  const purchasedQuota = user?.storagePurchasedBytes ?? 0;
  const fixedQuota = clientEnv.VITE_STORAGE_FIXED_QUOTA ?? 0;
  const planQuota = fixedQuota || DEFAULT_STORAGE_QUOTA[plan] || DEFAULT_STORAGE_QUOTA['free'];
  const quota = planQuota + purchasedQuota;

  return { plan, usage, quota };
};

export const getTranslationQuota = (plan: UserPlan): number => {
  const fixedQuota = clientEnv.VITE_TRANSLATION_FIXED_QUOTA ?? 0;
  return (
    fixedQuota || DEFAULT_DAILY_TRANSLATION_QUOTA[plan] || DEFAULT_DAILY_TRANSLATION_QUOTA['free']
  );
};

export const getTranslationPlanData = (user: PlanUser | null | undefined) => {
  const plan = pickPlan(user);
  const usage = getDailyUsage() || 0;
  const quota = getTranslationQuota(plan);

  return { plan, usage, quota };
};

export const getDailyTranslationPlanData = (user: PlanUser | null | undefined) => {
  const plan = pickPlan(user);
  const quota = getTranslationQuota(plan);

  return { plan, quota };
};

/**
 * Get the stored Better Auth session token used by native clients to replay
 * the `session_token` cookie manually when calling our own API.
 *
 * Web: returns `null`. better-auth's web client is browser-cookie based, so
 * callers should rely on `credentials: 'include'` instead of reading a token.
 *
 * Native (Tauri / iOS / Android): returns the signed Better Auth
 * session-cookie token that `native-client.ts` captured from the
 * `set-auth-token` response header on the most recent sign-in / refresh,
 * stored in localStorage under `readest:session-token`.
 *
 * Stays async for backwards compatibility — pre-Phase-7 callers awaited
 * `supabase.auth.getSession()` here, and converting them all to sync would
 * be churn for no benefit (the native session-token read is microtask-cheap).
 */
export const getNativeSessionToken = async (): Promise<string | null> => {
  if (isTauriAppPlatform()) {
    return loadSessionToken();
  }
  return null;
};

export const getUserID = async (): Promise<string | null> => {
  const { data } = await authClient.getSession();
  return data?.user?.id ?? null;
};
