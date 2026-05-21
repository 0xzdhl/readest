import { createAuthClient } from 'better-auth/react';
import { inferAdditionalFields, magicLinkClient } from 'better-auth/client/plugins';
import type { auth } from './server';

/**
 * Storage key for the better-auth bearer token, used by Tauri (desktop +
 * iOS + Android) clients. The WebView writes through to platform secure
 * storage (Tauri Store / Keychain / EncryptedSharedPreferences) where
 * appropriate; in jsdom / unsupported environments we fail silently.
 */
const TOKEN_KEY = 'readest:bearer-token';

function loadToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (!globalThis.localStorage) return;
    if (token) {
      globalThis.localStorage.setItem(TOKEN_KEY, token);
    } else {
      globalThis.localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* fail silently — storage may be unavailable in some webviews */
  }
}

/**
 * Native auth client — bearer-token session.
 *
 * better-auth's `bearer` server plugin returns the session token in a
 * `set-auth-token` response header on successful sign-in / refresh. We
 * capture it from `onSuccess`, persist it, and replay it on every request
 * via `fetchOptions.auth`.
 *
 * Note: better-auth 1.6.x does not export a `bearerClient` plugin —
 * bearer-mode is configured purely through `fetchOptions.auth.type =
 * 'Bearer'`. The server plugin (`bearer()` in `auth/server.ts`) is what
 * enables the `set-auth-token` header and accepts `Authorization: Bearer
 * <token>` on subsequent requests.
 */
export const nativeAuthClient = createAuthClient({
  baseURL: import.meta.env['VITE_BETTER_AUTH_URL'] ?? '',
  plugins: [magicLinkClient(), inferAdditionalFields<typeof auth>()],
  fetchOptions: {
    auth: {
      type: 'Bearer',
      token: () => loadToken() ?? '',
    },
    onSuccess: (ctx) => {
      const setAuthHeader = ctx.response.headers.get('set-auth-token');
      if (setAuthHeader) storeToken(setAuthHeader);
    },
  },
});

export { loadToken, storeToken };
