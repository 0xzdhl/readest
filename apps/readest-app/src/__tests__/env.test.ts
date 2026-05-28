// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientEnv } from '@/clientEnv';

const stubMinimumEnv = () => {
  vi.stubEnv('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/postgres');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret');
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:5173');
  vi.stubEnv('VITE_APP_PLATFORM', 'web');
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
    expect(env.RESEND_FROM_EMAIL).toBe('noreply@readest.app');
    expect(env.SMTP_HOST).toBe('localhost');
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.AI_GATEWAY_EMBEDDING_MODEL).toBe('openai/text-embedding-3-small');
    expect(env.DEEPL_FREE_API).toBe('https://api-free.deepl.com/v2/translate');
    expect(env.DEEPL_PRO_API).toBe('https://api.deepl.com/v2/translate');
  });
});
