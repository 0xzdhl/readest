import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAuthClientMock = vi.fn((config: unknown) => ({ config }));
const magicLinkClientMock = vi.fn(() => ({ id: 'magic-link' }));
const inferAdditionalFieldsMock = vi.fn(() => ({ id: 'infer-fields' }));

vi.mock('better-auth/react', () => ({
  createAuthClient: (config: unknown) => createAuthClientMock(config),
}));

vi.mock('better-auth/client/plugins', () => ({
  magicLinkClient: () => magicLinkClientMock(),
  inferAdditionalFields: () => inferAdditionalFieldsMock(),
}));

vi.mock('@/clientEnv', () => ({
  clientEnv: {
    VITE_BETTER_AUTH_URL: 'https://auth.example.com',
  },
}));

describe('native auth client session transport', () => {
  beforeEach(() => {
    vi.resetModules();
    createAuthClientMock.mockClear();
    magicLinkClientMock.mockClear();
    inferAdditionalFieldsMock.mockClear();
    localStorage.clear();
  });

  it('stores the session token surfaced in set-auth-token', async () => {
    const { loadSessionToken } = await import('@/auth/native-client');
    const configCall = createAuthClientMock.mock.calls[0];
    expect(configCall).toBeDefined();
    const config = configCall![0] as {
      fetchOptions: { onSuccess: (ctx: { response: Response }) => void };
    };

    expect(loadSessionToken()).toBeNull();

    config.fetchOptions.onSuccess({
      response: new Response(null, {
        headers: {
          'set-auth-token': 'session-token-123',
        },
      }),
    });

    expect(loadSessionToken()).toBe('session-token-123');
  });

  it('replays the stored session token as a Better Auth cookie header on native auth requests', async () => {
    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { storeSessionToken } = await import('@/auth/native-client');
    const configCall = createAuthClientMock.mock.calls[0];
    expect(configCall).toBeDefined();
    const config = configCall![0] as {
      fetchOptions: {
        customFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
      };
    };

    storeSessionToken('session-token-123');

    await config.fetchOptions.customFetchImpl('https://auth.example.com/session', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer should-not-be-sent',
        'X-Test': '1',
      },
    });

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall).toBeDefined();
    const init = (firstCall?.[1] ?? {}) as unknown as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Cookie')).toBe('__Secure-better-auth.session_token=session-token-123');
    expect(headers.get('X-Test')).toBe('1');
  });
});
