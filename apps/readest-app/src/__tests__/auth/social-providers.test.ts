// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `enabledSocialProviders` mirrors the fail-closed filtering in
 * `src/auth/server.ts`: a provider is only enabled when BOTH its client id
 * and secret are configured. The login UI reads this (via /api/auth-config)
 * to decide which OAuth buttons to render, so an unconfigured deployment
 * shows email-only sign-in.
 */

const ALL_PROVIDER_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'APPLE_CLIENT_ID',
  'APPLE_CLIENT_SECRET',
];

const stubBaseEnv = () => {
  // SKIP_ENV_VALIDATION lets us import the server module without supplying
  // every required server var; we only care about the provider creds here.
  vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
  vi.stubEnv('VITE_APP_PLATFORM', 'web');
  // `.env.test.local` can leak real provider creds into process.env; clear
  // them so each test starts from a known "unconfigured" baseline.
  for (const name of ALL_PROVIDER_ENV) {
    vi.stubEnv(name, undefined as unknown as string);
  }
};

describe('enabledSocialProviders', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  // Importing `@/auth/server` pulls in better-auth + drizzle, which is slow
  // under the fully-loaded parallel suite; allow generous time (mirrors the
  // explicit timeouts on the heavy route tests in runAuth-routes.test.ts).
  it('is empty when no provider credentials are configured', { timeout: 60_000 }, async () => {
    stubBaseEnv();

    const { enabledSocialProviders } = await import('@/auth/server');

    expect(enabledSocialProviders).toEqual([]);
  });

  it('enables a provider only when both id and secret are set', { timeout: 60_000 }, async () => {
    stubBaseEnv();
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-secret');
    // Only the id is set for github — must stay disabled (fail-closed).
    vi.stubEnv('GITHUB_CLIENT_ID', 'github-id');

    const { enabledSocialProviders } = await import('@/auth/server');

    expect(enabledSocialProviders).toEqual(['google']);
  });

  it('lists every fully-configured provider', { timeout: 60_000 }, async () => {
    stubBaseEnv();
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-secret');
    vi.stubEnv('DISCORD_CLIENT_ID', 'discord-id');
    vi.stubEnv('DISCORD_CLIENT_SECRET', 'discord-secret');

    const { enabledSocialProviders } = await import('@/auth/server');

    expect([...enabledSocialProviders].sort()).toEqual(['discord', 'google']);
  });
});
