import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KoSyncProxyPayload } from '@/types/kosync';

/**
 * Handler-level tests for the /api/kosync proxy hardening (T4-kosync-mitigations).
 *
 * The proxy is an unauthenticated open relay by design (no-account KOReader web
 * sync posts SAME-ORIGIN to it). These tests lock the CODE-level mitigations:
 *   1. Origin / Sec-Fetch-Site gate (defense-in-depth, forgeable).
 *   2. Forwarded-header allowlist (only KOReader auth headers reach upstream).
 *   3. Redirect guard: an upstream 3xx must surface as 502, never the body.
 */

// Control the outbound fetch so we can assert what the proxy forwards and how it
// reacts to upstream redirects, without real network access. `isLanAddress` /
// `isRedirectStatus` keep their real implementations.
const fetchNoRedirectMock = vi.hoisted(() =>
  vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('@/utils/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/network')>();
  return {
    ...actual,
    fetchNoRedirect: (input: string | URL, init?: RequestInit) => fetchNoRedirectMock(input, init),
  };
});

import { getBaseUrl } from '@/services/environment';
import { Route } from '@/app/api/kosync';

type Handler = (args: {
  request: Request;
  params: Record<string, string>;
  context: Record<string, unknown>;
}) => Promise<Response>;

const getHandler = (): Handler =>
  (
    Route as unknown as {
      options: { server: { handlers: { POST: Handler } } };
    }
  ).options.server.handlers.POST;

// The allowed origin under test mirrors the CORS allow-list, which is derived
// from VITE_API_BASE_URL (getBaseUrl()). Read it from the same source so the
// test stays hermetic regardless of which base URL the env resolves to.
const ALLOWED_ORIGIN = getBaseUrl();

const basePayload = (): KoSyncProxyPayload => ({
  serverUrl: 'https://sync.koreader.rocks',
  endpoint: '/users/auth',
  method: 'GET',
  headers: {
    'X-Auth-User': 'alice',
    'X-Auth-Key': 'secret-key',
  },
  body: undefined,
});

const makeRequest = (payload: KoSyncProxyPayload, headers: Record<string, string> = {}): Request =>
  new Request(`${ALLOWED_ORIGIN}/api/kosync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

const callHandler = (payload: KoSyncProxyPayload, headers?: Record<string, string>) =>
  getHandler()({
    request: makeRequest(payload, headers),
    params: {},
    context: {},
  });

beforeEach(() => {
  fetchNoRedirectMock.mockReset();
  fetchNoRedirectMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('kosync proxy — Origin / Sec-Fetch-Site gate (defense-in-depth)', () => {
  it('rejects a request whose Origin is present but not allowed', async () => {
    const res = await callHandler(basePayload(), { Origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    // Must short-circuit before reaching upstream.
    expect(fetchNoRedirectMock).not.toHaveBeenCalled();
  });

  it('allows a request with an allowed Origin', async () => {
    const res = await callHandler(basePayload(), { Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(200);
    expect(fetchNoRedirectMock).toHaveBeenCalledTimes(1);
  });

  it('allows a request with no Origin header (Tauri/native/non-browser clients)', async () => {
    const res = await callHandler(basePayload());
    expect(res.status).toBe(200);
    expect(fetchNoRedirectMock).toHaveBeenCalledTimes(1);
  });

  it('allows a request with Sec-Fetch-Site: same-origin even when Origin is not allow-listed', async () => {
    // same-origin is the browser's own attestation; honor it regardless of the
    // Origin value (the proxy is reached SAME-ORIGIN from the web app).
    const res = await callHandler(basePayload(), {
      Origin: 'https://not-in-allowlist.example.com',
      'Sec-Fetch-Site': 'same-origin',
    });
    expect(res.status).toBe(200);
  });

  it('rejects cross-site Sec-Fetch-Site with a disallowed Origin', async () => {
    const res = await callHandler(basePayload(), {
      Origin: 'https://evil.example.com',
      'Sec-Fetch-Site': 'cross-site',
    });
    expect(res.status).toBe(403);
    expect(fetchNoRedirectMock).not.toHaveBeenCalled();
  });
});

describe('kosync proxy — forwarded-header allowlist', () => {
  it('forwards only KOReader auth headers + proxy Accept/Content-Type to upstream', async () => {
    const payload = basePayload();
    payload.headers = {
      'X-Auth-User': 'alice',
      'X-Auth-Key': 'secret-key',
      Authorization: 'Bearer should-pass',
      // Everything below MUST be dropped — they widen the relay surface.
      Cookie: 'session=should-not-leak',
      'X-Forwarded-For': '10.0.0.1',
      'X-Evil-Header': 'nope',
      Host: 'internal.example.com',
    };

    await callHandler(payload, { Origin: ALLOWED_ORIGIN });

    expect(fetchNoRedirectMock).toHaveBeenCalledTimes(1);
    const init = fetchNoRedirectMock.mock.calls[0]![1] as RequestInit;
    const sentHeaders = new Headers(init.headers as HeadersInit);

    expect(sentHeaders.get('X-Auth-User')).toBe('alice');
    expect(sentHeaders.get('X-Auth-Key')).toBe('secret-key');
    expect(sentHeaders.get('Authorization')).toBe('Bearer should-pass');
    expect(sentHeaders.get('Accept')).toBe('application/vnd.koreader.v1+json');
    expect(sentHeaders.get('Content-Type')).toBe('application/json');

    expect(sentHeaders.get('Cookie')).toBeNull();
    expect(sentHeaders.get('X-Forwarded-For')).toBeNull();
    expect(sentHeaders.get('X-Evil-Header')).toBeNull();
    expect(sentHeaders.get('Host')).toBeNull();
  });

  it('matches KOReader auth headers case-insensitively', async () => {
    const payload = basePayload();
    payload.headers = {
      'x-auth-user': 'bob',
      'x-auth-key': 'k',
      authorization: 'Basic xyz',
    };

    await callHandler(payload, { Origin: ALLOWED_ORIGIN });

    const init = fetchNoRedirectMock.mock.calls[0]![1] as RequestInit;
    const sentHeaders = new Headers(init.headers as HeadersInit);
    expect(sentHeaders.get('X-Auth-User')).toBe('bob');
    expect(sentHeaders.get('X-Auth-Key')).toBe('k');
    expect(sentHeaders.get('Authorization')).toBe('Basic xyz');
  });
});

describe('kosync proxy — redirect guard (3xx -> 502)', () => {
  it('returns 502 (not the upstream body) when upstream responds 302', async () => {
    fetchNoRedirectMock.mockResolvedValue(
      new Response('SECRET-INTERNAL-BODY', {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );

    const res = await callHandler(basePayload(), { Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/redirect/i);
    expect(JSON.stringify(body)).not.toContain('SECRET-INTERNAL-BODY');
  });

  it('returns 502 for any 3xx status (e.g. 307)', async () => {
    fetchNoRedirectMock.mockResolvedValue(new Response(null, { status: 307 }));
    const res = await callHandler(basePayload(), { Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(502);
  });
});
