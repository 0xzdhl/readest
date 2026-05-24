import { createAuthClient } from 'better-auth/react';
import { inferAdditionalFields, magicLinkClient } from 'better-auth/client/plugins';
import { env } from '@/env';
import type { auth } from './server';

/**
 * Web auth client — cookie session (better-auth default).
 *
 * `inferAdditionalFields<typeof auth>()` projects the server-side
 * `additionalFields` (`plan`, `storageUsageBytes`,
 * `storagePurchasedBytes`) onto `session.user` so callers get typed
 * access without an extra DB query.
 */
export const authClient = createAuthClient({
  baseURL: env.VITE_BETTER_AUTH_URL,
  plugins: [magicLinkClient(), inferAdditionalFields<typeof auth>()],
});

export const { signIn, signOut, signUp, useSession, getSession } = authClient;
