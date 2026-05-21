import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type as osType } from '@tauri-apps/plugin-os';

export type Scope = 'fullName' | 'email';
export interface AppleIDAuthorizationRequest {
  scope: Scope[];
  nonce?: string;
  state?: string;
}

/**
 * Identity bundle returned by the native Sign-In-with-Apple plugins. The
 * caller is expected to pull `identityToken` (plus the `nonce` it supplied
 * — Apple echoes the same nonce back on the JWT's `nonce` claim) and
 * forward both to better-auth:
 *
 *   await authClient.signIn.social({
 *     provider: 'apple',
 *     idToken: { token: identityToken, nonce },
 *   });
 *
 * Better-auth verifies the JWT signature against Apple's JWKs and the
 * `aud` claim against `APPLE_CLIENT_ID` (or `appBundleIdentifier` on iOS),
 * then re-issues a better-auth session. Other fields are passed through
 * for callers that want to greet the user by name on first sign-in.
 */
export interface AppleIDAuthorizationResponse {
  userIdentifier: string | null;

  givenName: string | null;
  familyName: string | null;
  email: string | null;

  authorizationCode: string;
  identityToken: string | null;
  state: string | null;

  /**
   * Echoed back from the request — better-auth's id-token verifier
   * requires the same nonce on the JWT to defend against replay attacks.
   */
  nonce?: string | null;
}

export async function getAppleIdAuth(
  request: AppleIDAuthorizationRequest,
): Promise<AppleIDAuthorizationResponse> {
  const OS_TYPE = osType();
  if (OS_TYPE === 'ios') {
    const result = await invoke<AppleIDAuthorizationResponse>(
      'plugin:sign-in-with-apple|get_apple_id_credential',
      {
        payload: request,
      },
    );

    return result;
  } else if (OS_TYPE === 'macos') {
    return new Promise<AppleIDAuthorizationResponse>(async (resolve, reject) => {
      const unlistenComplete = await listen<AppleIDAuthorizationResponse>(
        'apple-sign-in-complete',
        ({ payload }) => {
          cleanup();
          resolve(payload);
        },
      );

      const unlistenError = await listen<string>('apple-sign-in-error', ({ payload }) => {
        cleanup();
        reject(
          typeof payload === 'string' ? new Error(payload) : new Error('Apple sign‑in failed'),
        );
      });

      function cleanup() {
        unlistenComplete();
        unlistenError();
      }

      try {
        await invoke('start_apple_sign_in', { payload: request });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  } else {
    throw new Error('Unsupported platform');
  }
}
