import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `fetchEnabledOAuthProviders` asks the server which OAuth providers are
 * configured so the login UI can render only those buttons. It is
 * deliberately fail-closed: any network/parse error yields an empty list,
 * so a misconfigured or unreachable server falls back to email-only sign-in
 * rather than showing dead OAuth buttons.
 */

const baselineEnv = () => {
  vi.stubEnv('VITE_APP_PLATFORM', 'web');
  vi.stubEnv('VITE_API_BASE_URL', 'https://web.example.com');
  vi.stubEnv('VITE_NODE_BASE_URL', 'https://node.example.com');
  vi.stubEnv('VITE_WEBSITE_URL', 'https://www.example.com');
  vi.stubEnv('VITE_DOWNLOAD_BASE_URL', 'https://dl.example.com/releases');
  vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com');
  vi.stubEnv('VITE_BRAND_NAME', 'ExampleBrand');
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

describe('fetchEnabledOAuthProviders', () => {
  it('returns the providers reported by the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ providers: ['google', 'apple'] }))),
    );

    const { fetchEnabledOAuthProviders } = await import('@/services/authConfig');
    await expect(fetchEnabledOAuthProviders()).resolves.toEqual(['google', 'apple']);
  });

  it('returns an empty list when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const { fetchEnabledOAuthProviders } = await import('@/services/authConfig');
    await expect(fetchEnabledOAuthProviders()).resolves.toEqual([]);
  });

  it('returns an empty list on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );

    const { fetchEnabledOAuthProviders } = await import('@/services/authConfig');
    await expect(fetchEnabledOAuthProviders()).resolves.toEqual([]);
  });

  it('ignores a malformed providers payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ providers: 'google' }))),
    );

    const { fetchEnabledOAuthProviders } = await import('@/services/authConfig');
    await expect(fetchEnabledOAuthProviders()).resolves.toEqual([]);
  });
});
