import { inferAdditionalFields, magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { env } from '@/env';
import type { Auth } from './server';

/**
 * Storage key for the Better Auth session token surfaced to native clients
 * through the `set-auth-token` bridge header.
 *
 * Stored in the WebView's localStorage (WKWebView per-app on iOS,
 * WebView2 on Windows, Android WebView). Persists across launches but
 * not necessarily across OS-level app data clears. Secure-keychain
 * integration is out of scope for this migration. In jsdom /
 * unsupported environments we fail silently.
 */
const SESSION_TOKEN_KEY = 'readest:session-token';

const getSessionCookieName = () =>
  env.VITE_BETTER_AUTH_URL.startsWith('https://')
    ? '__Secure-better-auth.session_token'
    : 'better-auth.session_token';

export function loadSessionToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(SESSION_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function storeSessionToken(token: string | null): void {
  try {
    if (!globalThis.localStorage) return;
    if (token) {
      globalThis.localStorage.setItem(SESSION_TOKEN_KEY, token);
    } else {
      globalThis.localStorage.removeItem(SESSION_TOKEN_KEY);
    }
  } catch {
    /* fail silently — storage may be unavailable in some webviews */
  }
}

/**
 * Native auth client — Better Auth session-cookie replay.
 *
 * better-auth's `bearer` server plugin still exposes the signed
 * `session_token` cookie value via the `set-auth-token` response header.
 * Native social OAuth uses that as the bridge back into the WebView.
 *
 * After we capture the token, native requests replay the Better Auth
 * session cookie manually via the `Cookie` header, matching the
 * session-cookie model used everywhere else in the app.
 */
export const buildSessionCookieHeader = (token = loadSessionToken()): string | null => {
  if (!token) return null;
  return `${getSessionCookieName()}=${token}`;
};

const nativeSessionFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete('Authorization');
  const cookieHeader = buildSessionCookieHeader();
  if (!cookieHeader) {
    return fetch(input, {
      ...init,
      headers,
    });
  }
  headers.set('Cookie', cookieHeader);
  return fetch(input, {
    ...init,
    credentials: 'omit',
    headers,
  });
};

const shouldClearStoredSession = (url: string | URL) => {
  const href = typeof url === 'string' ? url : url.toString();
  return (
    href.includes('/sign-out') ||
    href.includes('/delete-user') ||
    href.includes('/revoke-session') ||
    href.includes('/revoke-sessions') ||
    href.includes('/revoke-other-sessions')
  );
};

/**
 * Note: better-auth 1.6.x does not ship a dedicated Tauri cookie plugin.
 * We keep using the normal React client and override fetch transport for
 * native so its requests carry the stored session cookie explicitly.
 *
 */
export const nativeAuthClient = createAuthClient({
  baseURL: env.VITE_BETTER_AUTH_URL,
  plugins: [magicLinkClient(), inferAdditionalFields<Auth>()],
  fetchOptions: {
    customFetchImpl: nativeSessionFetch,
    onSuccess: (ctx) => {
      const setAuthHeader = ctx.response.headers.get('set-auth-token');
      if (setAuthHeader) {
        storeSessionToken(setAuthHeader);
        return;
      }
      if (shouldClearStoredSession(ctx.request.url)) {
        storeSessionToken(null);
      }
    },
  },
});

export const getNativeSessionCookieHeader = buildSessionCookieHeader;
