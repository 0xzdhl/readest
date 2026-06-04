import { createFileRoute } from '@tanstack/react-router';
import { enabledSocialProviders } from '@/auth/server';

/**
 * Public auth configuration for the login screen. Exposes only the list of
 * OAuth providers that are actually configured (id + secret) on this
 * deployment — see `enabledSocialProviders` in `src/auth/server.ts`. The
 * client uses it to render OAuth buttons conditionally so an unconfigured
 * deployment shows email-only sign-in. No secrets are returned.
 *
 * Lives at `/api/auth-config` (NOT under `/api/auth/*`) so it doesn't get
 * swallowed by the `/api/auth/$` splat that better-auth owns.
 */
export const Route = createFileRoute('/api/auth-config')({
  server: {
    handlers: {
      GET: () => Response.json({ providers: enabledSocialProviders }),
    },
  },
});
