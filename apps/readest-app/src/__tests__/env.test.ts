// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientEnv } from '@/clientEnv';

const stubMinimumEnv = () => {
  vi.stubEnv('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/postgres');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret');
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:5173');
  vi.stubEnv('VITE_APP_PLATFORM', 'web');
};

// `.env.test.local` leaks the required server vars into process.env, so clear
// them explicitly to simulate a CI build/prerender that has no secrets.
const clearRequiredServerEnv = () => {
  vi.stubEnv('DATABASE_URL', undefined as unknown as string);
  vi.stubEnv('BETTER_AUTH_SECRET', undefined as unknown as string);
  vi.stubEnv('BETTER_AUTH_URL', undefined as unknown as string);
};

describe('env', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('loads the minimum required env and centralizes runtime defaults', async () => {
    stubMinimumEnv();

    const { env } = await import('@/env');

    expect(env.DATABASE_URL).toBe('postgres://postgres:postgres@localhost:5432/postgres');
    expect(env.BETTER_AUTH_URL).toBe('http://localhost:5173');
    expect(clientEnv.VITE_APP_PLATFORM).toBe('web');
    expect(env.DATABASE_POOL_MAX).toBe(10);
    // RESEND_FROM_EMAIL is no longer a centralized default — it's now a
    // required env var supplied externally, so it isn't asserted here.
    expect(env.SMTP_HOST).toBe('localhost');
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.AI_GATEWAY_EMBEDDING_MODEL).toBe('openai/text-embedding-3-small');
    expect(env.DEEPL_FREE_API).toBe('https://api-free.deepl.com/v2/translate');
    expect(env.DEEPL_PRO_API).toBe('https://api.deepl.com/v2/translate');
  });

  it('throws when required server env vars are missing', async () => {
    clearRequiredServerEnv();
    vi.stubEnv('VITE_APP_PLATFORM', 'web');

    await expect(import('@/env')).rejects.toThrow();
  });

  it('skips validation when SKIP_ENV_VALIDATION is set (build/prerender)', async () => {
    // No DATABASE_URL / BETTER_AUTH_SECRET / BETTER_AUTH_URL — as in CI prerender.
    clearRequiredServerEnv();
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    vi.stubEnv('VITE_APP_PLATFORM', 'web');

    const { env } = await import('@/env');

    // Importing must not throw; missing required vars surface as undefined.
    expect(env.DATABASE_URL).toBeUndefined();
  });
});
