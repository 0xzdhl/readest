import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Either } from 'effect';

// The share landing page is cross-origin isolated (COEP: require-corp). A 302
// redirect to the cross-origin storage URL (R2 / MinIO at a different origin)
// is blocked by the browser because object storage doesn't send
// Cross-Origin-Resource-Policy — ERR_BLOCKED_BY_RESPONSE.NotSameOrigin...ByCoep.
// The cover endpoint must therefore stream the bytes through itself so the
// <img> stays same-origin. These tests pin that contract.

const resolveActiveShareMock = vi.hoisted(() => vi.fn());
vi.mock('@/libs/shareServer', () => ({
  resolveActiveShare: (...args: unknown[]) => resolveActiveShareMock(...args),
  rejectionToHttp: () => ({ status: 410, body: { code: 'gone' } }),
}));

const runStorageProgramMock = vi.hoisted(() => vi.fn());
vi.mock('@/storage/run', () => ({ runStorageProgram: runStorageProgramMock }));

import { Route } from '@/app/api/share/$token/cover/route';

interface CoverRouteLike {
  options: {
    server: {
      handlers: {
        GET: (args: {
          params: Record<string, string>;
          context: { tx: unknown };
          request: Request;
        }) => Promise<Response>;
      };
    };
  };
}

const getHandler = (Route as unknown as CoverRouteLike).options.server.handlers.GET;

const callCover = (token: string) =>
  getHandler({
    params: { token },
    context: { tx: {} },
    request: new Request(`http://localhost/api/share/${token}/cover`),
  });

const SIGNED_URL =
  'http://storage.local:9000/readest-files/u/h/cover.png?X-Amz-Signature=abc';

describe('GET /api/share/$token/cover', () => {
  beforeEach(() => {
    resolveActiveShareMock.mockReset();
    runStorageProgramMock.mockReset();
    vi.restoreAllMocks();
  });

  it('streams the cover bytes same-origin instead of 302-redirecting to storage', async () => {
    resolveActiveShareMock.mockResolvedValue({
      ok: true,
      share: { coverFileKey: 'u/h/cover.png' },
    });
    runStorageProgramMock.mockResolvedValue(Either.right(SIGNED_URL));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      }),
    );

    const res = await callCover('aBcDeFgHiJkLmNoPqRsTuV');

    // Must NOT redirect — a cross-origin redirect target is COEP-blocked.
    expect(res.status).toBe(200);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    // Bytes are proxied from the presigned storage URL.
    expect(fetchMock).toHaveBeenCalledWith(SIGNED_URL);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('returns 404 when the share has no cover', async () => {
    resolveActiveShareMock.mockResolvedValue({ ok: true, share: { coverFileKey: null } });
    const res = await callCover('aBcDeFgHiJkLmNoPqRsTuV');
    expect(res.status).toBe(404);
  });
});
