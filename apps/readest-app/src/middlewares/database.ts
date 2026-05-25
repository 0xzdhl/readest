import { createMiddleware } from '@tanstack/react-start';
import { createDbClient } from '@/db/client';

/**
 * Provides the singleton drizzle client on `context.db`. Composed by
 * `rlsMiddleware` and `publicMiddleware` to open per-request transactions;
 * routes that need raw db access (no tx) can list this directly.
 */
export const databaseMiddleware = createMiddleware().server(async ({ next }) => {
  return next({ context: { db: createDbClient() } });
});
