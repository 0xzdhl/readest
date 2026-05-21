import { authClient as webClient } from './client';
import { nativeAuthClient } from './native-client';
import { isTauriAppPlatform } from '@/services/environment';

/**
 * Platform-routed better-auth client.
 *
 * Web (cookie session)    → `client.ts`'s `authClient`.
 * Tauri / iOS / Android  → `native-client.ts`'s `nativeAuthClient`,
 *                          which persists the bearer token in the WebView's
 *                          localStorage and replays it via
 *                          `Authorization: Bearer …` headers.
 *
 * Both clients are interface-compatible: they share `signIn` / `signOut` /
 * `signUp` / `useSession` / `getSession` / `magicLink` (via the plugin
 * registered on both sides), and the `inferAdditionalFields<typeof auth>`
 * projection guarantees `session.user.{plan,storageUsageBytes,storagePurchasedBytes}`
 * are typed the same way.
 *
 * The UI layer always imports from `@/auth` so a single component renders
 * the same on every platform — the only difference is how the request
 * carries its credential.
 */
export const authClient = isTauriAppPlatform() ? nativeAuthClient : webClient;

export const { signIn, signOut, signUp, useSession, getSession } = authClient;
export { loadToken, storeToken } from './native-client';
