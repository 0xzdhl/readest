import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());
const createAuthMock = vi.hoisted(() =>
  vi.fn(() => ({ api: { getSession: getSessionMock } })),
);
const setRlsUserIdMock = vi.hoisted(() => vi.fn());
const setRlsBypassMock = vi.hoisted(() => vi.fn());
const createDbClientMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth/server', () => ({
  createAuth: createAuthMock,
}));

vi.mock('@/db/rls', () => ({
  setRlsUserId: setRlsUserIdMock,
  setRlsBypass: setRlsBypassMock,
}));

vi.mock('@/db/client', () => ({
  createDbClient: createDbClientMock,
}));

type MiddlewareInput = {
  request: Request;
  context: Record<string, unknown>;
  next: ReturnType<typeof vi.fn>;
};
type MiddlewareWithServer = {
  options: { server: (args: MiddlewareInput) => Promise<unknown> };
};

const callMiddleware = async (
  mw: { options: { server?: unknown } },
  input: MiddlewareInput,
): Promise<unknown> => {
  return (mw as MiddlewareWithServer).options.server(input);
};

beforeEach(() => {
  getSessionMock.mockReset();
  createAuthMock.mockReset();
  createAuthMock.mockImplementation(() => ({ api: { getSession: getSessionMock } }));
  setRlsUserIdMock.mockReset();
  setRlsBypassMock.mockReset();
  createDbClientMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe('databaseMiddleware', () => {
  it('forwards { db } from createDbClient() to next', async () => {
    const fakeDb = { kind: 'drizzle' };
    createDbClientMock.mockReturnValueOnce(fakeDb);
    const { databaseMiddleware } = await import('@/middlewares/database');
    const next = vi.fn().mockResolvedValueOnce('next-result');

    const result = await callMiddleware(databaseMiddleware, {
      request: new Request('http://localhost/'),
      context: {},
      next,
    });

    expect(createDbClientMock).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith({ context: { db: fakeDb } });
    expect(result).toBe('next-result');
  });
});

describe('betterAuthMiddleware', () => {
  it('builds a per-request auth from context.db and forwards { auth }', async () => {
    const fakeDb = { kind: 'drizzle' };
    const fakeAuth = { api: { getSession: getSessionMock } };
    createAuthMock.mockReturnValueOnce(fakeAuth);

    const { betterAuthMiddleware } = await import('@/middlewares/better-auth');
    const next = vi.fn().mockResolvedValueOnce('next-result');

    const result = await callMiddleware(betterAuthMiddleware, {
      request: new Request('http://localhost/'),
      context: { db: fakeDb },
      next,
    });

    expect(createAuthMock).toHaveBeenCalledWith(fakeDb);
    expect(next).toHaveBeenCalledWith({ context: { auth: fakeAuth } });
    expect(result).toBe('next-result');
  });
});

describe('protectedMiddleware', () => {
  it('short-circuits with { error: "Not authenticated" } 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const auth = { api: { getSession: getSessionMock } };
    const { protectedMiddleware } = await import('@/middlewares/protected');
    const next = vi.fn();

    const result = await callMiddleware(protectedMiddleware, {
      request: new Request('http://localhost/'),
      context: { auth },
      next,
    });

    expect(next).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('forwards { session, user } via next when session exists', async () => {
    const session = { user: { id: 'u1', email: 'u@e.com' }, session: { id: 's1', token: 't' } };
    getSessionMock.mockResolvedValueOnce(session);
    const auth = { api: { getSession: getSessionMock } };
    const { protectedMiddleware } = await import('@/middlewares/protected');
    const next = vi.fn().mockResolvedValueOnce('next-result');

    const headers = new Headers({ cookie: 'sess=abc' });
    const result = await callMiddleware(protectedMiddleware, {
      request: new Request('http://localhost/', { headers }),
      context: { auth },
      next,
    });

    expect(getSessionMock).toHaveBeenCalledWith({ headers: expect.any(Headers) });
    expect(next).toHaveBeenCalledWith({
      context: { session, user: session.user },
    });
    expect(result).toBe('next-result');
  });
});

describe('rlsMiddleware', () => {
  it('opens a tx, calls setRlsUserId(tx, user.id), forwards { tx } to next', async () => {
    const tx = { kind: 'tx' };
    const db = { transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    const user = { id: 'user-xyz' };
    const session = { user, session: { id: 's' } };
    const next = vi.fn().mockResolvedValueOnce('handler-result');

    const { rlsMiddleware } = await import('@/middlewares/rls');

    const result = await callMiddleware(rlsMiddleware, {
      request: new Request('http://localhost/'),
      context: { db, user, session },
      next,
    });

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(setRlsUserIdMock).toHaveBeenCalledWith(tx, 'user-xyz');
    expect(next).toHaveBeenCalledWith({ context: { tx } });
    expect(result).toBe('handler-result');
  });
});

describe('publicMiddleware', () => {
  it('opens a tx, calls setRlsBypass(tx), forwards { tx } to next', async () => {
    const tx = { kind: 'tx' };
    const db = { transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    const next = vi.fn().mockResolvedValueOnce('handler-result');

    const { publicMiddleware } = await import('@/middlewares/public');

    const result = await callMiddleware(publicMiddleware, {
      request: new Request('http://localhost/'),
      context: { db },
      next,
    });

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(setRlsBypassMock).toHaveBeenCalledWith(tx);
    expect(next).toHaveBeenCalledWith({ context: { tx } });
    expect(result).toBe('handler-result');
  });
});
