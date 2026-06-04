import type { SocialProvider } from '@/auth/server';
import { getAPIBaseUrl } from './environment';

export interface AuthConfig {
  /** OAuth providers configured (id + secret present) on the server. */
  providers: SocialProvider[];
  /** Whether new-account creation is allowed. */
  signupEnabled: boolean;
}

/**
 * Fetch the public auth configuration the login screen needs: which OAuth
 * providers are usable and whether registration is open. See
 * `/api/auth-config`, `enabledSocialProviders`, and `signupEnabled`.
 *
 * Fail-closed: any network or parse error resolves to no providers (so a
 * misconfigured/unreachable server degrades to email-only sign-in) with
 * `signupEnabled` left at the documented default of `true` — the server
 * still enforces the real rule, so the UI flag is only cosmetic.
 */
export async function fetchAuthConfig(): Promise<AuthConfig> {
  try {
    const res = await fetch(`${getAPIBaseUrl()}/auth-config`);
    if (!res.ok) return { providers: [], signupEnabled: true };
    const data = (await res.json()) as { providers?: unknown; signupEnabled?: unknown };
    const providers = Array.isArray(data.providers)
      ? data.providers.filter((p): p is SocialProvider => typeof p === 'string')
      : [];
    // Only an explicit `false` disables sign-up; anything else keeps the
    // safe default so a stale/partial payload never hides registration.
    const signupEnabled = data.signupEnabled !== false;
    return { providers, signupEnabled };
  } catch {
    return { providers: [], signupEnabled: true };
  }
}
