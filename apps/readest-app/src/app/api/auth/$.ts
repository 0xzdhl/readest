import { createFileRoute } from '@tanstack/react-router';
import { betterAuthMiddleware } from '@/middlewares/better-auth';

// All `/api/auth/*` traffic is delegated to better-auth's request handler.
// better-auth dispatches each endpoint (sign-in, callbacks, session, etc.)
// internally based on the request URL. The auth instance is per-request via
// `betterAuthMiddleware` so module-scoped state cannot leak across requests
// on Cloudflare Workers isolates.
export const Route = createFileRoute('/api/auth/$')({
  server: {
    middleware: [betterAuthMiddleware],
    handlers: {
      GET: ({ request, context }) => context.auth.handler(request),
      POST: ({ request, context }) => context.auth.handler(request),
    },
  },
});
