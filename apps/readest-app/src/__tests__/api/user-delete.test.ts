import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
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
 * Phase 6 integration test for /api/user/delete.
 *
 * Verifies:
 *   - 401 wire-format ({ error: 'Not authenticated' }) when better-auth's
 *     APIError comes back with statusCode 401/403.
 *   - Happy path: success message returned, the FK ON DELETE CASCADE on
 *     business tables actually fans out (we seed a `files` row alongside
 *     the user and confirm it's gone after the delete).
 *
 * `auth.api.deleteUser` itself is mocked because:
 *   - it runs better-auth's own internal adapter (separate pool) and
 *     emails / cookie state — not what we're trying to assert here;
 *   - we want to test the route's error shaping AND the cascade behavior
 *     end-to-end, so the mock issues a real DELETE against the test DB
 *     to mimic better-auth's effect on the user row.
 */

const deleteUserMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/server', () => ({
  auth: { api: { deleteUser: deleteUserMock } },
}));

const url = process.env['TEST_DATABASE_URL'];

let adminClient: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle>;

type DeleteRoute = typeof import('@/app/api/user/delete');
let deleteModule: DeleteRoute;

interface RouteShape {
  options: {
    server: {
      handlers: {
        DELETE?: (args: { request: Request }) => Promise<Response>;
      };
    };
  };
}

const userA = '11111111-1111-1111-1111-111111111111';

describe.skipIf(!url)('/api/user/delete (better-auth + FK CASCADE)', () => {
  beforeAll(async () => {
    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) throw new Error('user-delete.test: bad TEST_DATABASE_URL');
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);

    vi.doMock('@/db/client', () => ({ db: appDb, type: undefined }));
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
    const del = (deleteModule.Route as unknown as RouteShape).options.server.handlers.DELETE!;
    const request = new Request('http://localhost/api/user/delete', { method: 'DELETE' });
    const response = await del({ request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('happy path: returns success message AND FK CASCADE clears business rows', async () => {
    // Seed user + a files row for them so we can verify CASCADE.
    await adminClient`INSERT INTO "user" (id, email, email_verified, name)
                      VALUES (${userA}, 'cascade@test', true, 'Cascade')`;
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                      VALUES (${userA}, 'h', 'k', 1)`;

    deleteUserMock.mockImplementationOnce(async () => {
      // Simulate better-auth performing the delete. The schema-level
      // ON DELETE CASCADE on `files.user_id` will fan it out.
      await adminClient`DELETE FROM "user" WHERE id = ${userA}`;
      return { success: true, message: 'User deleted' };
    });

    const del = (deleteModule.Route as unknown as RouteShape).options.server.handlers.DELETE!;
    const request = new Request('http://localhost/api/user/delete', {
      method: 'DELETE',
      headers: { authorization: 'Bearer abc' },
    });
    const response = await del({ request });
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
    const del = (deleteModule.Route as unknown as RouteShape).options.server.handlers.DELETE!;
    const request = new Request('http://localhost/api/user/delete', {
      method: 'DELETE',
      headers: { authorization: 'Bearer xyz', cookie: 'session=abc' },
    });
    await del({ request });
    expect(deleteUserMock).toHaveBeenCalledOnce();
    const call = deleteUserMock.mock.calls[0]?.[0] as { headers?: Headers; body?: unknown };
    expect(call.headers?.get('authorization')).toBe('Bearer xyz');
    expect(call.body).toEqual({});
  });
});
