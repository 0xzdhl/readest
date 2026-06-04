import type { SocialProvider } from '@/auth/server';
import { getAPIBaseUrl } from './environment';

/**
 * Ask the server which OAuth providers are configured (id + secret present)
 * so the login screen only renders buttons that can actually complete a
 * sign-in. See `/api/auth-config` and `enabledSocialProviders`.
 *
 * Fail-closed: any network or parse error resolves to an empty list, so a
 * misconfigured or unreachable server degrades to email-only sign-in rather
 * than showing OAuth buttons that would 404.
 */
export async function fetchEnabledOAuthProviders(): Promise<SocialProvider[]> {
  try {
    const res = await fetch(`${getAPIBaseUrl()}/auth-config`);
    if (!res.ok) return [];
    const data = (await res.json()) as { providers?: unknown };
    if (!Array.isArray(data.providers)) return [];
    return data.providers.filter((p): p is SocialProvider => typeof p === 'string');
  } catch {
    return [];
  }
}
