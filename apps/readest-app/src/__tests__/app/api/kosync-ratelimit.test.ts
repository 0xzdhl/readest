import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KoSyncProxyPayload } from '@/types/kosync';

/**
 * #4: the per-IP edge rate limit is the real control for the unauthenticated
 * kosync open relay. It is backed by a Workers Rate Limiting binding
 * (KOSYNC_RATE_LIMITER) configured in wrangler.jsonc. Here we drive the handler
 * with the `cloudflare:workers` stub's mutable `env` to exercise the 429 path,
 * and confirm that when the binding is absent (self-host / Node / tests) the
 * proxy is NOT rate-limited.
 */

const fetchNoRedirectMock = vi.hoisted(() =>
  vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ),
);
vi.mock('@/utils/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/network')>();
  return {
    ...actual,
    fetchNoRedirect: (input: string | URL, init?: RequestInit) => fetchNoRedirectMock(input, init),
  };
});

import { env } from 'cloudflare:workers';
import { Route } from '@/app/api/kosync';

type Handler = (args: {
  request: Request;
  params: Record<string, string>;
  context: Record<string, unknown>;
}) => Promise<Response>;
const getHandler = (): Handler =>
  (Route as unknown as { options: { server: { handlers: { POST: Handler } } } }).options.server
    .handlers.POST;

const post = (body: Partial<KoSyncProxyPayload>) =>
  new Request('https://web.readest.com/api/kosync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const validBody: Partial<KoSyncProxyPayload> = {
  serverUrl: 'https://sync.example.com',
  endpoint: '/users/auth',
  method: 'GET',
};

describe('/api/kosync — edge rate limit (#4)', () => {
  afterEach(() => {
    delete (env as unknown as Record<string, unknown>)['KOSYNC_RATE_LIMITER'];
    vi.clearAllMocks();
  });

  it('returns 429 when the rate limiter denies the request', async () => {
    (env as unknown as Record<string, unknown>)['KOSYNC_RATE_LIMITER'] = {
      limit: async () => ({ success: false }),
    };
    const res = await getHandler()({ request: post(validBody), params: {}, context: {} });
    expect(res.status).toBe(429);
    // The limit must be enforced BEFORE any upstream fetch.
    expect(fetchNoRedirectMock).not.toHaveBeenCalled();
  });

  it('allows the request (keyed per cf-connecting-ip) when the limiter permits', async () => {
    (env as unknown as Record<string, unknown>)['KOSYNC_RATE_LIMITER'] = {
      limit: async ({ key }: { key: string }) => ({ success: true, key }),
    };
    const res = await getHandler()({ request: post(validBody), params: {}, context: {} });
    expect(res.status).not.toBe(429);
  });

  it('is a no-op (not rate-limited) when the binding is absent', async () => {
    const res = await getHandler()({ request: post(validBody), params: {}, context: {} });
    expect(res.status).not.toBe(429);
  });
});
