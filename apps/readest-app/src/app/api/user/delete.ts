import { createFileRoute } from '@tanstack/react-router';
import { betterAuthMiddleware } from '@/middlewares/better-auth';

/**
 * Self-delete: uses `betterAuthMiddleware` for the `auth` instance only —
 * NO session/tx middleware. Reasons:
 *
 *   - `auth.api.deleteUser` enforces auth itself (UNAUTHORIZED on missing
 *     session + freshness check via `sessionConfig.freshAge`), so a
 *     `protectedMiddleware` gate would only duplicate that work.
 *   - The call writes through better-auth's own internal adapter (its own
 *     pool), not the request tx, so opening an RLS tx via `rlsMiddleware`
 *     would just leave an empty tx hanging. FK `ON DELETE CASCADE` on every
 *     business table's `user_id` then fans the delete out — this route owns
 *     no manual fan-out.
 *
 * 401 wire-format reshape: better-auth throws an APIError with statusCode
 * 401/403; we duck-type on `statusCode` rather than `instanceof APIError`
 * so the check survives differing module instances (vitest re-bundles
 * `better-auth/api`'s transitive `better-call` re-exports and the
 * `instanceof` chain breaks).
 */
const hasStatusCode = (
  error: unknown,
): error is { statusCode: number; body?: { message?: string }; message?: string } =>
  typeof error === 'object' &&
  error !== null &&
  'statusCode' in error &&
  typeof (error as { statusCode?: unknown }).statusCode === 'number';

export const Route = createFileRoute('/api/user/delete')({
  server: {
    middleware: [betterAuthMiddleware],
    handlers: {
      DELETE: async ({ request, context }) => {
        const { auth } = context;
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
