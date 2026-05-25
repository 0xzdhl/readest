import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { runRoute } from '../utils/run-route';

// Simulate better-auth's APIError shape without importing the real class
// (its transitive `better-call` re-export breaks vitest's ESM parser). The
// route ducks on `statusCode` rather than `instanceof APIError`, so this
// minimal stand-in is sufficient.
class FakeAPIError extends Error {
  public readonly statusCode: number;
  public readonly body?: { message?: string };
  constructor(statusCode: number, body?: { message?: string }) {
    super(body?.message ?? 'API error');
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Integration test for /api/user/delete. The route composes
 * `betterAuthMiddleware` (provides `context.auth` without opening a tx) and
 * lets better-auth's own `auth.api.deleteUser` enforce auth + run the
 * cascade — we verify the route's error shaping AND that the schema-level
 * FK CASCADE on `files.user_id` actually fans the delete out.
 */

const deleteUserMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/server', () => ({
  createAuth: () => ({ api: { deleteUser: deleteUserMock } }),
}));

const url = process.env['TEST_DATABASE_URL'];

let adminClient: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle>;

type DeleteRoute = typeof import('@/app/api/user/delete');
let deleteModule: DeleteRoute;

const userA = '11111111-1111-1111-1111-111111111111';

type RouteLike = Parameters<typeof runRoute>[0];

describe.skipIf(!url)('/api/user/delete (better-auth + FK CASCADE)', () => {
  beforeAll(async () => {
    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) throw new Error('user-delete.test: bad TEST_DATABASE_URL');
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);

    vi.doMock('@/db/client', () => ({ createDbClient: () => appDb }));
    deleteModule = await import('@/app/api/user/delete');
  }, 30_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
  });

  beforeEach(async () => {
    deleteUserMock.mockReset();
    await adminClient`DELETE FROM "user" WHERE id = ${userA}`;
  });

  it('401 with re-shaped error when better-auth says UNAUTHORIZED', async () => {
    deleteUserMock.mockRejectedValueOnce(new FakeAPIError(401, { message: 'no session' }));
    const request = new Request('http://localhost/api/user/delete', { method: 'DELETE' });
    const response = await runRoute(deleteModule.Route as RouteLike, 'DELETE', { request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('happy path: returns success message AND FK CASCADE clears business rows', async () => {
    await adminClient`INSERT INTO "user" (id, email, email_verified, name)
                      VALUES (${userA}, 'cascade@test', true, 'Cascade')`;
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                      VALUES (${userA}, 'h', 'k', 1)`;

    deleteUserMock.mockImplementationOnce(async () => {
      await adminClient`DELETE FROM "user" WHERE id = ${userA}`;
      return { success: true, message: 'User deleted' };
    });

    const request = new Request('http://localhost/api/user/delete', {
      method: 'DELETE',
      headers: { authorization: 'Bearer abc' },
    });
    const response = await runRoute(deleteModule.Route as RouteLike, 'DELETE', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toBe('User deleted successfully');

    const remainingUser = await adminClient<{ c: string }[]>`
      SELECT count(*)::text AS c FROM "user" WHERE id = ${userA}`;
    expect(Number(remainingUser[0]?.c)).toBe(0);

    const remainingFiles = await adminClient<{ c: string }[]>`
      SELECT count(*)::text AS c FROM files WHERE user_id = ${userA}`;
    expect(Number(remainingFiles[0]?.c)).toBe(0);
  });

  it('forwards request headers to auth.api.deleteUser', async () => {
    deleteUserMock.mockResolvedValueOnce({ success: true, message: 'User deleted' });
    const request = new Request('http://localhost/api/user/delete', {
      method: 'DELETE',
      headers: { authorization: 'Bearer xyz', cookie: 'session=abc' },
    });
    await runRoute(deleteModule.Route as RouteLike, 'DELETE', { request });
    expect(deleteUserMock).toHaveBeenCalledOnce();
    const call = deleteUserMock.mock.calls[0]?.[0] as { headers?: Headers; body?: unknown };
    expect(call.headers?.get('authorization')).toBe('Bearer xyz');
    expect(call.body).toEqual({});
  });
});
