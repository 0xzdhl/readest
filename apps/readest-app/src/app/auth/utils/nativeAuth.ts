import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type as osType } from '@tauri-apps/plugin-os';

import { storeToken } from '@/auth';

export interface AuthRequest {
  authUrl: string;
}

export interface AuthResponse {
  redirectUrl: string;
}

/**
 * Bridge into the native in-app-browser session.
 *
 * On iOS we use `ASWebAuthenticationSession` (via the `native-bridge`
 * plugin's `auth_with_safari`). On macOS we kick off a deferred native
 * task and resolve when the host fires `safari-auth-complete`. The auth
 * URL is the OAuth provider's authorise endpoint (Google, GitHub, etc.);
 * the response carries the deep-link the provider redirected to —
 * `readest://auth-callback?token=…` for the better-auth bearer flow.
 */
export async function authWithSafari(request: AuthRequest): Promise<AuthResponse> {
  const OS_TYPE = osType();
  if (OS_TYPE === 'ios') {
    const result = await invoke<AuthResponse>('plugin:native-bridge|auth_with_safari', {
      payload: request,
    });
    return result;
  } else if (OS_TYPE === 'macos') {
    return new Promise<AuthResponse>(async (resolve, reject) => {
      const unlistenComplete = await listen<AuthResponse>(
        'safari-auth-complete',
        ({ payload }) => {
          cleanup();
          resolve(payload);
        },
      );

      function cleanup() {
        unlistenComplete();
      }

      try {
        await invoke<AuthResponse>('auth_with_safari', { payload: request });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  } else {
    throw new Error('Unsupported OS type');
  }
}

/**
 * Android in-app-browser (Chrome Custom Tabs) bridge. Same contract as
 * `authWithSafari`: opens the provider's authorise URL, returns the
 * provider's redirect deep-link.
 */
export async function authWithCustomTab(request: AuthRequest): Promise<AuthResponse> {
  const result = await invoke<AuthResponse>('plugin:native-bridge|auth_with_custom_tab', {
    payload: request,
  });

  return result;
}

/**
 * Pull the better-auth bearer token out of a deep-link callback URL.
 *
 * better-auth's bearer plugin sets `set-auth-token` on the HTTP response
 * during web flows, but the OAuth callback URL we receive on native is
 * just a redirect — better-auth's server appends the token directly to
 * the callback URL it redirected to. The token can land in either the
 * query string or the hash fragment depending on whether the provider
 * preserved the original `response_mode`; check both.
 *
 * Returns `null` when no token is found (the caller should treat that
 * as a failed sign-in and bail).
 */
export function extractBearerFromCallback(callbackUrl: string): string | null {
  let queryToken: string | null = null;
  let hashToken: string | null = null;
  try {
    const u = new URL(callbackUrl);
    queryToken = u.searchParams.get('token');
    if (u.hash) {
      const hashParams = new URLSearchParams(u.hash.replace(/^#/, ''));
      hashToken = hashParams.get('token');
    }
  } catch {
    // Some custom-scheme URLs (`readest://…`) parse fine; others do not.
    // Fall back to a manual scan.
    const queryMatch = callbackUrl.match(/[?&]token=([^&#]+)/);
    if (queryMatch?.[1]) queryToken = decodeURIComponent(queryMatch[1]);
    const hashMatch = callbackUrl.match(/#.*token=([^&]+)/);
    if (hashMatch?.[1]) hashToken = decodeURIComponent(hashMatch[1]);
  }
  return queryToken ?? hashToken;
}

/**
 * Convenience wrapper used by the auth page: extract the bearer from a
 * provider redirect URL and stash it in the native client's localStorage
 * slot. After this call the existing `nativeAuthClient.useSession()` will
 * pick the token up on its next request.
 */
export function storeBearerFromCallback(callbackUrl: string): string | null {
  const token = extractBearerFromCallback(callbackUrl);
  if (token) storeToken(token);
  return token;
}
