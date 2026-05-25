import { createMiddleware } from '@tanstack/react-start';
import type { Session } from '@/auth/server';
import { betterAuthMiddleware } from './better-auth';

export type ResolvedSession = NonNullable<Session>;
export type SessionUser = ResolvedSession['user'];

/**
 * Requires a valid better-auth session resolved from request headers and
 * exposes it as `{ session, user }` on context. Short-circuits with
 * `{ error: 'Not authenticated' }` JSON (401) when the cookie/bearer is
 * missing or invalid — the legacy wire format that
 * `apps/readest-app/src/hooks/useSync.ts` substring-matches to trigger
 * silent re-login.
 *
 * No database transaction is opened. Use directly for routes that only
 * proxy to third-party APIs (AI gateway, DeepL, Edge-TTS, metadata search)
 * but still need to identify the caller for plan/quota checks read off
 * `session.user`. For routes that also touch the db, prefer
 * `rlsMiddleware` which composes this one and opens an RLS-scoped tx.
 */
export const protectedMiddleware = createMiddleware()
  .middleware([betterAuthMiddleware])
  .server(async ({ next, context, request }) => {
    const session = await context.auth.api.getSession({ headers: request.headers });
    if (!session) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 });
    }
    return next({ context: { session, user: session.user } });
  });
