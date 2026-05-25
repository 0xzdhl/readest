import { isTauriAppPlatform } from '@/services/environment';
import { authClient as webClient } from './client';
import { nativeAuthClient } from './native-client';

/**
 * Platform-routed better-auth client.
 *
 * Web (cookie session)    → `client.ts`'s `authClient`.
 * Tauri / iOS / Android  → `native-client.ts`'s `nativeAuthClient`,
 *                          which persists the Better Auth session-token
 *                          bridge in the WebView's localStorage and replays
 *                          it as a `Cookie` header.
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
export {
  buildSessionCookieHeader,
  getNativeSessionCookieHeader,
  loadSessionToken,
  storeSessionToken,
} from './native-client';
