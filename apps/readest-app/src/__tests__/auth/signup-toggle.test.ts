// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `signupEnabled` reflects the `DISABLE_SIGNUP` env var: registration is on by
 * default and only turned off when `DISABLE_SIGNUP=true`. The auth server uses
 * it to set better-auth's `disableSignUp` across every account-creation vector
 * (email/password, social, magic-link), and the login UI reads it (via
 * /api/auth-config) to hide the sign-up affordance.
 */

const stubBaseEnv = () => {
  // SKIP_ENV_VALIDATION lets us import the server module without supplying
  // every required server var; we only care about DISABLE_SIGNUP here.
  vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
  vi.stubEnv('VITE_APP_PLATFORM', 'web');
  vi.stubEnv('DISABLE_SIGNUP', undefined as unknown as string);
};

// Importing `@/auth/server` pulls in better-auth + drizzle, which is slow
// under the fully-loaded parallel suite; allow generous time.
describe('signupEnabled', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('defaults to enabled when DISABLE_SIGNUP is unset', { timeout: 60_000 }, async () => {
    stubBaseEnv();

    const { signupEnabled } = await import('@/auth/server');

    expect(signupEnabled).toBe(true);
  });

  it('is disabled when DISABLE_SIGNUP=true', { timeout: 60_000 }, async () => {
    stubBaseEnv();
    vi.stubEnv('DISABLE_SIGNUP', 'true');

    const { signupEnabled } = await import('@/auth/server');

    expect(signupEnabled).toBe(false);
  });

  it('stays enabled when DISABLE_SIGNUP=false', { timeout: 60_000 }, async () => {
    stubBaseEnv();
    vi.stubEnv('DISABLE_SIGNUP', 'false');

    const { signupEnabled } = await import('@/auth/server');

    expect(signupEnabled).toBe(true);
  });
});
