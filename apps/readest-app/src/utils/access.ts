import type { UserPlan } from '@/types/quota';
import { DEFAULT_DAILY_TRANSLATION_QUOTA, DEFAULT_STORAGE_QUOTA } from '@/services/constants';
import { isTauriAppPlatform } from '@/services/environment';
import { getDailyUsage } from '@/services/translators/utils';
import { readPublicEnv } from '@/utils/publicEnv';
import { authClient, loadToken } from '@/auth';

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
  const fixedQuota = Number.parseInt(readPublicEnv('VITE_STORAGE_FIXED_QUOTA') || '0', 10);
  const planQuota = fixedQuota || DEFAULT_STORAGE_QUOTA[plan] || DEFAULT_STORAGE_QUOTA['free'];
  const quota = planQuota + purchasedQuota;

  return { plan, usage, quota };
};

export const getTranslationQuota = (plan: UserPlan): number => {
  const fixedQuota = Number.parseInt(readPublicEnv('VITE_TRANSLATION_FIXED_QUOTA') || '0', 10);
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
 * Get the access token used for `Authorization: Bearer …` headers when the
 * UI calls our own API.
 *
 * Web: returns `null`. better-auth's web client is cookie-based — the
 * `better-auth.session_token` cookie is sent automatically on same-origin
 * requests, so callers should pass `credentials: 'include'` (already the
 * default when running on the same origin) instead of relying on a header.
 *
 * Native (Tauri / iOS / Android): returns the bearer token that
 * `native-client.ts` captured from the `set-auth-token` response header on
 * the most recent sign-in / refresh, stored in localStorage under
 * `readest:bearer-token`.
 *
 * Stays async for backwards compatibility — pre-Phase-7 callers awaited
 * `supabase.auth.getSession()` here, and converting them all to sync would
 * be churn for no benefit (the bearer load is microtask-cheap).
 */
export const getAccessToken = async (): Promise<string | null> => {
  if (isTauriAppPlatform()) {
    return loadToken();
  }
  return null;
};

export const getUserID = async (): Promise<string | null> => {
  const { data } = await authClient.getSession();
  return data?.user?.id ?? null;
};
