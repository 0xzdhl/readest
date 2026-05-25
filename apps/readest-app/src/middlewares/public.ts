import { createMiddleware } from '@tanstack/react-start';
import { setRlsBypass } from '@/db/rls';
import { databaseMiddleware } from './database';

/**
 * Opens a Postgres transaction with `app.bypass_rls = 'true'` (recognised
 * by the per-table policies as a service-role escape hatch). Exposes
 * `{ tx }` on context.
 *
 * Two use cases share this:
 *   - genuinely public endpoints where the security boundary is the
 *     request itself (e.g. token-based share download: the token's
 *     secrecy IS the gate, and the lookup uses `WHERE token_hash = $1`),
 *   - signature-verified webhooks (Stripe, IAP) — the route verifies the
 *     signature BEFORE delegating to this middleware, so a forged request
 *     never reaches the bypass tx.
 */
export const publicMiddleware = createMiddleware()
  .middleware([databaseMiddleware])
  .server(async ({ next, context }) => {
    return context.db.transaction(async (tx) => {
      await setRlsBypass(tx);
      return next({ context: { tx } });
    });
  });
