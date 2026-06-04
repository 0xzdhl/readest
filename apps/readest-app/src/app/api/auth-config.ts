import { createFileRoute } from '@tanstack/react-router';
import { enabledSocialProviders, signupEnabled } from '@/auth/server';

/**
 * Public auth configuration for the login screen. Exposes:
 *   - `providers`: the OAuth providers actually configured (id + secret) on
 *     this deployment, so the client renders only buttons that can complete
 *     a sign-in (an unconfigured deployment shows email-only sign-in).
 *   - `signupEnabled`: whether new-account creation is allowed, so the client
 *     can hide the sign-up affordance when registration is off.
 *
 * No secrets are returned. Lives at `/api/auth-config` (NOT under
 * `/api/auth/*`) so it doesn't get swallowed by the `/api/auth/$` splat that
 * better-auth owns.
 */
export const Route = createFileRoute('/api/auth-config')({
  server: {
    handlers: {
      GET: () => Response.json({ providers: enabledSocialProviders, signupEnabled }),
    },
  },
});
