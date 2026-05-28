import { inferAdditionalFields, magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { clientEnv } from '@/clientEnv';
import type { Auth } from './server';

/**
 * Web auth client — cookie session (better-auth default).
 *
 * `inferAdditionalFields<typeof auth>()` projects the server-side
 * `additionalFields` (`plan`, `storageUsageBytes`,
 * `storagePurchasedBytes`) onto `session.user` so callers get typed
 * access without an extra DB query.
 */
export const authClient = createAuthClient({
  baseURL: clientEnv.VITE_BETTER_AUTH_URL,
  plugins: [magicLinkClient(), inferAdditionalFields<Auth>()],
});

export const { signIn, signOut, signUp, useSession, getSession } = authClient;
