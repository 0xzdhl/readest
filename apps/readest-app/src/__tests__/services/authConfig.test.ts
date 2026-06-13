import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `fetchAuthConfig` asks the server which OAuth providers are configured and
 * whether registration is open, so the login UI can render only usable OAuth
 * buttons and hide the sign-up affordance when registration is off.
 *
 * It is deliberately fail-closed: any network/parse error yields no providers
 * (so a misconfigured/unreachable server falls back to email-only sign-in)
 * and leaves `signupEnabled` at its documented default of `true` (the server
 * still enforces the real rule, so the UI flag is cosmetic).
 */

const baselineEnv = () => {
  vi.stubEnv('VITE_APP_PLATFORM', 'web');
  vi.stubEnv('VITE_API_BASE_URL', 'https://web.example.com');
  vi.stubEnv('VITE_NODE_BASE_URL', 'https://node.example.com');
  vi.stubEnv('VITE_WEBSITE_URL', 'https://www.example.com');
  vi.stubEnv('VITE_DOWNLOAD_BASE_URL', 'https://dl.example.com/releases');
  vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com');
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  baselineEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('fetchAuthConfig', () => {
  it('returns the providers and signup flag reported by the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ providers: ['google', 'apple'], signupEnabled: false })),
      ),
    );

    const { fetchAuthConfig } = await import('@/services/authConfig');
    await expect(fetchAuthConfig()).resolves.toEqual({
      providers: ['google', 'apple'],
      signupEnabled: false,
    });
  });

  it('fails closed on a network error (no providers, signup defaults on)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const { fetchAuthConfig } = await import('@/services/authConfig');
    await expect(fetchAuthConfig()).resolves.toEqual({ providers: [], signupEnabled: true });
  });

  it('fails closed on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );

    const { fetchAuthConfig } = await import('@/services/authConfig');
    await expect(fetchAuthConfig()).resolves.toEqual({ providers: [], signupEnabled: true });
  });

  it('ignores a malformed providers payload and defaults signup on when absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ providers: 'google' }))),
    );

    const { fetchAuthConfig } = await import('@/services/authConfig');
    await expect(fetchAuthConfig()).resolves.toEqual({ providers: [], signupEnabled: true });
  });

  it('treats signupEnabled as disabled only when explicitly false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ providers: [], signupEnabled: 'nope' }))),
    );

    const { fetchAuthConfig } = await import('@/services/authConfig');
    // Non-boolean → keep the safe default (enabled).
    await expect(fetchAuthConfig()).resolves.toEqual({ providers: [], signupEnabled: true });
  });
});
