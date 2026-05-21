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

/**
 * Auth-check helper used by API-route handlers that haven't yet been
 * migrated to the `protectedFn` middleware (currently: ai/chat, ai/embed,
 * metadata/search, tts/edge, deepl/translate). Resolves the better-auth
 * session from the incoming Authorization header and surfaces a synthetic
 * `token` field so legacy call-sites that pass the bearer downstream
 * (e.g. translator quota checks against external services) keep working.
 *
 * Phase 8 will port the remaining routes to `protectedFn` and this can
 * then be removed alongside `helpers/auth.ts`.
 */
export const validateUserAndToken = async (
  authHeader: string | null | undefined,
): Promise<
  | { user: NonNullable<Awaited<ReturnType<typeof authClient.getSession>>['data']>['user']; token: string }
  | Record<string, never>
> => {
  if (!authHeader) return {};

  const token = authHeader.replace('Bearer ', '');
  // Dynamic import avoids pulling the server bundle into client builds.
  // The server-side `auth.api.getSession({ headers })` validates the
  // bearer against the session table and returns the same user shape
  // the React `useSession()` hook exposes.
  const { auth } = await import('@/auth/server');
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return {};
  return { user: session.user, token };
};
