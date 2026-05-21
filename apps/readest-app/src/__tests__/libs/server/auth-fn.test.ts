import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth/server', () => ({
  auth: {
    api: { getSession: getSessionMock },
  },
}));

// `auth-fn` re-exports `createServerFn` / `getRequest` from
// `@tanstack/react-start`; we don't exercise the middleware end-to-end here
// (the framework wiring is hard to mock). The bits we care about are the
// helper that converts a missing session into a 401 Response.
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({ middleware: () => ({}) }),
  createMiddleware: () => ({ server: () => ({}) }),
}));
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('http://localhost/'),
}));

vi.mock('@/db/rls', () => ({
  withRls: vi.fn(),
  withBypassRls: vi.fn(),
}));

describe('resolveSessionOr401', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('throws a 401 Response when no session is found', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const { resolveSessionOr401 } = await import('@/libs/server/auth-fn');

    let thrown: unknown;
    try {
      await resolveSessionOr401(new Headers());
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Unauthorized');
  });

  it('returns the session when one exists', async () => {
    const session = {
      user: { id: 'user-1', email: 'u@e.com' },
      session: { id: 's', token: 't' },
    };
    getSessionMock.mockResolvedValueOnce(session);
    const { resolveSessionOr401 } = await import('@/libs/server/auth-fn');

    const headers = new Headers({ cookie: 'sess=abc' });
    const result = await resolveSessionOr401(headers);

    expect(result).toBe(session);
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(getSessionMock).toHaveBeenCalledWith({ headers });
  });
});
