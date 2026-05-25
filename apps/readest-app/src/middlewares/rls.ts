import { createMiddleware } from '@tanstack/react-start';
import { setRlsUserId } from '@/db/rls';
import { protectedMiddleware } from './protected';

/**
 * Requires a valid session AND opens an RLS-scoped Postgres transaction
 * with `app.user_id` set so the per-table policies in
 * `db/migrations/0001_rls_and_pg_funcs.sql` allow access to the caller's
 * rows. Exposes `{ session, user, tx }` on context; handlers run drizzle
 * queries against `context.tx` and the row scoping is enforced by the
 * database, not the route code.
 *
 * 401 short-circuit comes from `protectedMiddleware` — by the time this
 * middleware's body runs, the session is guaranteed.
 */
export const rlsMiddleware = createMiddleware()
  .middleware([protectedMiddleware])
  .server(async ({ next, context }) => {
    return context.db.transaction(async (tx) => {
      await setRlsUserId(tx, context.user.id);
      return next({ context: { tx } });
    });
  });
