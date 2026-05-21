import type { Session } from '@/auth/server';
import type { db } from '@/db/client';
import { withBypassRls, withRls } from '@/db/rls';
import { resolveSessionOr401 } from './auth-fn';
import { DEFAULT_STORAGE_QUOTA } from '@/services/constants';
import type { UserPlan } from '@/types/quota';
import { readPublicEnv } from '@/utils/publicEnv';

/**
 * Phase 5 of the supabase→better-auth migration. File-route HTTP handlers
 * (`createFileRoute({ server: { handlers } })`) and TanStack-Start server
 * functions (`createServerFn().middleware([...])`) are *different* dispatch
 * paths in TanStack Start — a serverFn middleware cannot be composed into a
 * file-route handler directly. Phase 4 inlined a `runProtected` wrapper in
 * `sync.ts` (see comment block at the top of that file); Phase 5 lifts the
 * three variants into a single shared helper so every refactored route
 * (storage / replicas / shares) calls the same code path:
 *
 *   - `runProtected`: authenticated, RLS-scoped to `session.user.id`.
 *   - `runService`:    no session, RLS bypassed (admin-pool semantics).
 *                      Reserved for trusted server-only callers (currently
 *                      unused outside this file; webhooks land in Phase 6).
 *   - `runPublic`:     no session, RLS bypassed. For genuinely public
 *                      endpoints like the book_shares token-based download
 *                      path — the token's secrecy IS the security boundary,
 *                      and the lookup requires bypass because there's no
 *                      `app.user_id` to plug into RLS.
 *
 * All three open the per-request transaction the route's drizzle queries
 * will run against, so handler bodies are pure (Request, ctx) → Response.
 *
 * 401 wire-format reshape: `resolveSessionOr401` throws a bare
 * `Response('Unauthorized', 401)`. The legacy supabase routes returned
 * `{ error: 'Not authenticated' }` JSON and `apps/readest-app/src/hooks/
 * useSync.ts:148` substring-matches on that body to trigger silent re-login.
 * `runProtected` re-shapes the 401 to keep that contract; other thrown
 * `Response` objects are passed through unchanged.
 */

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ProtectedRouteContext {
  user: NonNullable<Session>['user'];
  session: NonNullable<Session>;
  tx: TxLike;
}

export interface ServiceRouteContext {
  tx: TxLike;
}

export interface PublicRouteContext {
  tx: TxLike;
}

export interface AuthRouteContext {
  user: NonNullable<Session>['user'];
  session: NonNullable<Session>;
}

export async function runProtected(
  request: Request,
  inner: (ctx: ProtectedRouteContext) => Promise<Response>,
): Promise<Response> {
  try {
    const session = await resolveSessionOr401(request.headers);
    return await withRls(session.user.id, (tx) => inner({ user: session.user, session, tx }));
  } catch (e) {
    if (e instanceof Response) {
      if (e.status === 401) {
        return Response.json({ error: 'Not authenticated' }, { status: 401 });
      }
      return e;
    }
    throw e;
  }
}

export async function runService(
  inner: (ctx: ServiceRouteContext) => Promise<Response>,
): Promise<Response> {
  return withBypassRls((tx) => inner({ tx }));
}

export async function runPublic(
  inner: (ctx: PublicRouteContext) => Promise<Response>,
): Promise<Response> {
  return withBypassRls((tx) => inner({ tx }));
}

/**
 * Authenticated, NO database transaction. For routes that only proxy to
 * third-party APIs (AI gateway, DeepL, Edge-TTS, metadata search) but need
 * to identify the caller for quota / plan-tier checks read off
 * `session.user`. Opening a DB transaction for these would be wasteful and
 * would briefly hold a pool slot per request — `runAuth` skips the tx and
 * just resolves the session.
 *
 * 401 wire-format matches `runProtected`: `{ error: 'Not authenticated' }`
 * JSON, so the client hook's substring match (see `runProtected` jsdoc)
 * keeps working for any route that previously used a legacy auth-check.
 */
export async function runAuth(
  request: Request,
  inner: (ctx: AuthRouteContext) => Promise<Response>,
): Promise<Response> {
  try {
    const session = await resolveSessionOr401(request.headers);
    return await inner({ user: session.user, session });
  } catch (e) {
    if (e instanceof Response) {
      if (e.status === 401) {
        return Response.json({ error: 'Not authenticated' }, { status: 401 });
      }
      return e;
    }
    throw e;
  }
}

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
 * Server-side storage-plan resolution. Pre-Phase-3 the route handlers read
 * these values from a Supabase JWT (`storage_usage_bytes` /
 * `storage_purchased_bytes` claims). After Phase 3 they live on the
 * better-auth user row (`additionalFields` in `auth/server.ts`) and ride
 * along on `session.user` in camelCase. This helper centralises the
 * default-fill + env-override so every storage route resolves quota the
 * same way without each route reaching into the user object directly.
 */
export function getStoragePlanData(user: StoragePlanUserFields): {
  plan: UserPlan;
  usage: number;
  quota: number;
} {
  const plan = ((user.plan ?? 'free') as UserPlan) || 'free';
  const usage = user.storageUsageBytes ?? 0;
  const purchasedQuota = user.storagePurchasedBytes ?? 0;
  const fixedQuota = Number.parseInt(readPublicEnv('VITE_STORAGE_FIXED_QUOTA') || '0', 10);
  const planQuota =
    fixedQuota || DEFAULT_STORAGE_QUOTA[plan] || DEFAULT_STORAGE_QUOTA['free'];
  const quota = planQuota + purchasedQuota;
  return { plan, usage, quota };
}
