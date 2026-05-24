import { createFileRoute } from '@tanstack/react-router';
import { authMiddleware } from '@/middlewares/auth';

/**
 * Phase 6 of the supabase→better-auth migration: replaces the legacy
 * `supabaseAdmin.auth.admin.deleteUser(user.id)` call with better-auth's
 * own self-deletion endpoint.
 *
 * Auth is enforced INSIDE `auth.api.deleteUser` — it pulls the session
 * straight from the forwarded request headers (better-auth bearer + cookie),
 * throws an APIError(UNAUTHORIZED) on its own if there's no session, and
 * refuses if the session isn't "fresh" enough (default 1 day; controlled
 * by `sessionConfig.freshAge`). On success it tears down the `user` row;
 * the schema's FK `ON DELETE CASCADE` on every business table's `user_id`
 * column then removes books, configs, notes, files, shares, replicas,
 * payments, subscriptions, etc., in one shot — so this route owns NO
 * manual fan-out logic.
 *
 * We don't compose `runProtected` here because `auth.api.deleteUser` writes
 * through better-auth's own internal adapter (its own pool), not our
 * request tx, so wrapping in `withRls` would just open an empty tx that
 * commits nothing.
 *
 * The legacy supabase route returned `{ error: 'Not authenticated' }` 401
 * JSON when no session — we re-shape better-auth's 401/403 below to keep
 * that wire contract intact. We duck-type on `statusCode` rather than
 * `instanceof APIError` so the check survives differing module instances
 * (vitest re-bundles `better-auth/api`'s transitive `better-call` re-exports
 * and the `instanceof` chain breaks).
 */
const hasStatusCode = (error: unknown): error is { statusCode: number; body?: { message?: string }; message?: string } =>
  typeof error === 'object' &&
  error !== null &&
  'statusCode' in error &&
  typeof (error as { statusCode?: unknown }).statusCode === 'number';

export const Route = createFileRoute('/api/user/delete')({
  server: {
    middleware: [authMiddleware],
    handlers: {
      DELETE: async ({ request, context }) => {
        const auth = context.auth;
        try {
          await auth.api.deleteUser({
            headers: request.headers,
            body: {},
          });
          return Response.json({ message: 'User deleted successfully' });
        } catch (error) {
          if (hasStatusCode(error)) {
            const status = error.statusCode;
            if (status === 401 || status === 403) {
              return Response.json({ error: 'Not authenticated' }, { status: 401 });
            }
            return Response.json(
              { error: error.body?.message ?? error.message ?? 'Delete failed' },
              { status },
            );
          }
          console.error('User delete failed:', error);
          const message = error instanceof Error ? error.message : 'Something went wrong';
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
