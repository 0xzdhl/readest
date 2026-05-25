import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '@/db/schema';
import { runRoute } from '../utils/run-route';

/**
 * Integration tests for /api/sync under the new `rlsMiddleware` chain.
 * The middleware-mounted route is exercised via `runRoute`; the pure
 * `handlePost`/`handleGet` exports are still called directly from a
 * manually-opened RLS-scoped tx for the LWW and isolation cases (those
 * tests want to control exactly which user_id the tx is bound to).
 */

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth/server', () => ({
  createAuth: () => ({ api: { getSession: getSessionMock } }),
}));

const url = process.env['TEST_DATABASE_URL'];

let adminClient: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle<typeof schema>>;

type SyncRouteModule = typeof import('@/app/api/sync');

let syncModule: SyncRouteModule;
let setRlsUserId: typeof import('@/db/rls')['setRlsUserId'];

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';

type RouteLike = Parameters<typeof runRoute>[0];

// Open a tx scoped to `userId` so the route's handler-level reads/writes
// run against the same RLS context the middleware would set in production.
const withRlsTx = async <T>(userId: string, fn: (tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0]) => Promise<T>): Promise<T> => {
  return appDb.transaction(async (tx) => {
    await setRlsUserId(tx, userId);
    return fn(tx);
  });
};

describe.skipIf(!url)('/api/sync (rlsMiddleware + drizzle)', () => {
  beforeAll(async () => {
    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) {
      throw new Error('sync.test: failed to substitute readest_app credentials into TEST_DATABASE_URL');
    }
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient, { schema });

    const role = await appClient`SELECT current_user`;
    const currentUser = (role[0] as { current_user?: string } | undefined)?.current_user;
    if (currentUser !== 'readest_app') {
      throw new Error(
        `sync.test: connected as ${currentUser}, expected readest_app — RLS would not be enforced`,
      );
    }

    vi.doMock('@/db/client', () => ({ createDbClient: () => appDb }));

    syncModule = await import('@/app/api/sync');
    ({ setRlsUserId } = await import('@/db/rls'));

    await adminClient`INSERT INTO "user" (id, email, email_verified, name)
                      VALUES (${userA}, 'a-sync@test', true, 'User A'),
                             (${userB}, 'b-sync@test', true, 'User B')
                      ON CONFLICT (id) DO NOTHING`;
  }, 30_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
  });

  beforeEach(async () => {
    getSessionMock.mockReset();
    await adminClient`DELETE FROM book_notes  WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM book_configs WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM books        WHERE user_id IN (${userA}, ${userB})`;
  });

  // ────────────────────────────────────────────────────────────────────────
  // happy path — POST then GET round-trips userA's records.
  //
  // We exercise the pure handlers directly inside `withRlsTx(userA, ...)`.
  // The middleware chain is exercised separately by the 401 wire-format
  // test below.
  // ────────────────────────────────────────────────────────────────────────
  it('happy path: POST then GET returns userA records', async () => {
    const now = Date.now();
    const bookPayload = {
      hash: 'hash-A-1',
      metaHash: 'meta-A-1',
      format: 'EPUB',
      title: 'Book A',
      author: 'Author A',
      createdAt: now,
      updatedAt: now,
    };

    const postResponse = await withRlsTx(userA, async (tx) => {
      const request = new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ books: [bookPayload], configs: [], notes: [] }),
      });
      return syncModule.handlePost(request, { user: { id: userA }, tx });
    });
    expect(postResponse.status).toBe(200);
    const postBody = (await postResponse.json()) as {
      books: Array<{ book_hash: string }>;
      configs: unknown[];
      notes: unknown[];
    };
    expect(postBody.books).toHaveLength(1);
    expect(postBody.books[0]?.book_hash).toBe('hash-A-1');

    const getResponse = await withRlsTx(userA, async (tx) => {
      const request = new Request('http://localhost/api/sync?since=0', { method: 'GET' });
      return syncModule.handleGet(request, { user: { id: userA }, tx });
    });
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as {
      books: Array<{ book_hash: string }>;
      configs: unknown[];
      notes: unknown[];
    };
    expect(getBody.books.map((b) => b.book_hash)).toContain('hash-A-1');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 401 wire format — middleware short-circuits with `{ error: 'Not
  // authenticated' }` JSON. `useSync.ts` substring-matches this body to
  // trigger silent re-login; the contract has to keep holding.
  // ────────────────────────────────────────────────────────────────────────
  it('401 response body is { error: "Not authenticated" } JSON', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const request = new Request('http://localhost/api/sync?since=0', { method: 'GET' });
    const response = await runRoute(syncModule.Route as RouteLike, 'GET', { request });

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  // ────────────────────────────────────────────────────────────────────────
  // LWW: POST preserves server-newer rows.
  // ────────────────────────────────────────────────────────────────────────
  it('LWW: POST preserves server-newer books (stale client payload is ignored)', async () => {
    const serverTime = new Date('2025-01-15T12:00:00.000Z');
    const staleClientTime = new Date('2025-01-15T11:00:00.000Z'); // 1h older

    await withRlsTx(userA, async (tx) => {
      const request = new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          books: [
            {
              hash: 'hash-A-lww',
              format: 'EPUB',
              title: 'Server Title',
              author: 'Author',
              createdAt: serverTime.getTime(),
              updatedAt: serverTime.getTime(),
            },
          ],
          configs: [],
          notes: [],
        }),
      });
      return syncModule.handlePost(request, { user: { id: userA }, tx });
    });

    const postResponse = await withRlsTx(userA, async (tx) => {
      const request = new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          books: [
            {
              hash: 'hash-A-lww',
              format: 'EPUB',
              title: 'Stale Title',
              author: 'Stale Author',
              createdAt: staleClientTime.getTime(),
              updatedAt: staleClientTime.getTime(),
            },
          ],
          configs: [],
          notes: [],
        }),
      });
      return syncModule.handlePost(request, { user: { id: userA }, tx });
    });
    expect(postResponse.status).toBe(200);

    const persisted = await adminClient<
      { title: string | null; updated_at: Date | string }[]
    >`SELECT title, updated_at FROM books WHERE user_id = ${userA} AND book_hash = 'hash-A-lww'`;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.title).toBe('Server Title');
    expect(new Date(persisted[0]!.updated_at).toISOString()).toBe(serverTime.toISOString());
  });

  it('LWW: POST updates when client is newer', async () => {
    const oldServerTime = new Date('2025-01-15T11:00:00.000Z');
    const newClientTime = new Date('2025-01-15T12:00:00.000Z');

    await withRlsTx(userA, async (tx) => {
      const request = new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          books: [
            {
              hash: 'hash-A-lww-fresh',
              format: 'EPUB',
              title: 'Old Title',
              author: 'Author',
              createdAt: oldServerTime.getTime(),
              updatedAt: oldServerTime.getTime(),
            },
          ],
          configs: [],
          notes: [],
        }),
      });
      return syncModule.handlePost(request, { user: { id: userA }, tx });
    });

    const postResponse = await withRlsTx(userA, async (tx) => {
      const request = new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          books: [
            {
              hash: 'hash-A-lww-fresh',
              format: 'EPUB',
              title: 'New Title',
              author: 'Author',
              createdAt: oldServerTime.getTime(),
              updatedAt: newClientTime.getTime(),
            },
          ],
          configs: [],
          notes: [],
        }),
      });
      return syncModule.handlePost(request, { user: { id: userA }, tx });
    });
    expect(postResponse.status).toBe(200);

    const persisted = await adminClient<
      { title: string | null; updated_at: Date | string }[]
    >`SELECT title, updated_at FROM books WHERE user_id = ${userA} AND book_hash = 'hash-A-lww-fresh'`;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.title).toBe('New Title');
    expect(new Date(persisted[0]!.updated_at).toISOString()).toBe(newClientTime.toISOString());
  });

  it('LWW: POST preserves server-newer book_configs and book_notes', async () => {
    const serverTime = new Date('2025-01-15T12:00:00.000Z');
    const staleClientTime = new Date('2025-01-15T11:00:00.000Z');

    await adminClient`INSERT INTO books (user_id, book_hash, title, author, updated_at)
                      VALUES (${userA}, 'hash-A-cfg', 'Book', 'Author', ${serverTime.toISOString()})`;

    await withRlsTx(userA, async (tx) => {
      const request = new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          books: [],
          configs: [
            {
              bookHash: 'hash-A-cfg',
              location: 'server-loc',
              updatedAt: serverTime.getTime(),
            },
          ],
          notes: [
            {
              bookHash: 'hash-A-cfg',
              id: 'note-1',
              type: 'highlight',
              note: 'server note',
              updatedAt: serverTime.getTime(),
            },
          ],
        }),
      });
      return syncModule.handlePost(request, { user: { id: userA }, tx });
    });

    await withRlsTx(userA, async (tx) => {
      const request = new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          books: [],
          configs: [
            {
              bookHash: 'hash-A-cfg',
              location: 'stale-loc',
              updatedAt: staleClientTime.getTime(),
            },
          ],
          notes: [
            {
              bookHash: 'hash-A-cfg',
              id: 'note-1',
              type: 'highlight',
              note: 'stale note',
              updatedAt: staleClientTime.getTime(),
            },
          ],
        }),
      });
      return syncModule.handlePost(request, { user: { id: userA }, tx });
    });

    const cfg = await adminClient<
      { location: string | null; updated_at: Date | string }[]
    >`SELECT location, updated_at FROM book_configs WHERE user_id = ${userA} AND book_hash = 'hash-A-cfg'`;
    expect(cfg).toHaveLength(1);
    expect(cfg[0]?.location).toBe('server-loc');
    expect(new Date(cfg[0]!.updated_at).toISOString()).toBe(serverTime.toISOString());

    const note = await adminClient<
      { note: string | null; updated_at: Date | string }[]
    >`SELECT note, updated_at FROM book_notes WHERE user_id = ${userA} AND book_hash = 'hash-A-cfg' AND id = 'note-1'`;
    expect(note).toHaveLength(1);
    expect(note[0]?.note).toBe('server note');
    expect(new Date(note[0]!.updated_at).toISOString()).toBe(serverTime.toISOString());
  });

  // ────────────────────────────────────────────────────────────────────────
  // cross-user RLS denial — userB cannot see userA's seeded book.
  // ────────────────────────────────────────────────────────────────────────
  it('cross-user RLS denial: userB sees no books seeded for userA', async () => {
    await adminClient`INSERT INTO books (user_id, book_hash, title, author, updated_at)
                      VALUES (${userA}, 'hash-A-secret', 'Secret', 'Author', now())`;

    const response = await withRlsTx(userB, async (tx) => {
      const request = new Request('http://localhost/api/sync?since=0', { method: 'GET' });
      return syncModule.handleGet(request, { user: { id: userB }, tx });
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      books: Array<{ book_hash: string }>;
    };
    expect(body.books.find((b) => b.book_hash === 'hash-A-secret')).toBeUndefined();
    expect(body.books).toHaveLength(0);

    const exists =
      await adminClient`SELECT 1 FROM books WHERE user_id = ${userA} AND book_hash = 'hash-A-secret'`;
    expect(exists.length).toBe(1);

    expect(schema.books).toBeDefined();
  });
});
