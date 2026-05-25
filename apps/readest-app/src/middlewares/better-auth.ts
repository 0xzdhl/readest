import { createMiddleware } from '@tanstack/react-start';
import { createAuth } from '@/auth/server';
import { databaseMiddleware } from './database';

/**
 * Builds a per-request better-auth instance bound to the per-request drizzle
 * client and exposes it as `context.auth`. Per-request creation matters on
 * Cloudflare Workers, where module-scoped singletons can outlive a single
 * request and leak state across requests sharing the same isolate.
 */
export const betterAuthMiddleware = createMiddleware()
  .middleware([databaseMiddleware])
  .server(async ({ next, context }) => {
    const auth = createAuth(context.db);
    return next({ context: { auth } });
  });
