import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// We import the route module after mocking @/db/client + @/auth/server so the
// app-role transaction (not the admin one) backs every drizzle call inside
// the handlers — that's what RLS actually polices in production.
const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth/server', () => ({
  auth: {
    api: { getSession: getSessionMock },
  },
}));

// Avoid pulling supabase/jwt-decode (and their env-var contracts) into the
// route module's transitive deps — only `transformBook*` is used from
// `@/utils/transform`, which has no runtime deps on supabase.

const url = process.env['TEST_DATABASE_URL'];

let adminClient: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle>;

// Lazy imports populated in beforeAll once the DB client mock is wired up.
type SyncRouteModule = typeof import('@/app/api/sync');
type RlsModule = typeof import('@/db/rls');
type SchemaModule = typeof import('@/db/schema');

let syncModule: SyncRouteModule;
let rlsModule: RlsModule;
let schema: SchemaModule;

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';

describe.skipIf(!url)('/api/sync (drizzle + protectedFn)', () => {
  beforeAll(async () => {
    // 1. Migrate as superuser.
    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    // 2. Open the constrained app-role pool — the route under test must talk
    //    to PG as `readest_app` so RLS is actually enforced (superuser /
    //    table-owner roles bypass it silently).
    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) {
      throw new Error(
        'sync.test: failed to substitute readest_app credentials into TEST_DATABASE_URL',
      );
    }
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);

    const role = await appClient`SELECT current_user`;
    const currentUser = (role[0] as { current_user?: string } | undefined)?.current_user;
    if (currentUser !== 'readest_app') {
      throw new Error(
        `sync.test: connected as ${currentUser}, expected readest_app — RLS would not be enforced`,
      );
    }

    // 3. Mock @/db/client AFTER the app-role pool is open so the route module
    //    issues queries through the same pool as `withRls` in this test.
    vi.doMock('@/db/client', () => ({ db: appDb, type: undefined }));

    syncModule = await import('@/app/api/sync');
    rlsModule = await import('@/db/rls');
    schema = await import('@/db/schema');

    // Seed both users via admin (cascades will clean books/configs/notes on
    // user delete, but we don't delete users between tests — only their rows).
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
    // Clean per-test so seeded rows don't leak across cases. Admin bypasses
    // RLS (table owner) so we can wipe both users' rows in one shot.
    await adminClient`DELETE FROM book_notes  WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM book_configs WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM books        WHERE user_id IN (${userA}, ${userB})`;
  });

  // ────────────────────────────────────────────────────────────────────────
  // happy path — POST then GET round-trips userA's records.
  //
  // We exercise the handlers directly inside `withRls(userA, ...)`. Phase 3
  // already covers the middleware end-to-end (session resolution + tx open);
  // here we're testing "given a tx and a user, the route does the right
  // upsert/select".
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

    // POST
    const postResponse = await rlsModule.withRls(userA, async (tx) => {
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

    // GET
    const getResponse = await rlsModule.withRls(userA, async (tx) => {
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
  // 401 — no session → protectedFn middleware (resolveSessionOr401) throws.
  //
  // We can't drive the full file-route handler chain without the TanStack
  // Start runtime, so we drive the same machinery the route uses: the
  // middleware's session-resolver. The route handler is a one-liner over it,
  // and the resolver throws a Response(401) on null session per
  // `apps/readest-app/src/libs/server/auth-fn.ts`.
  // ────────────────────────────────────────────────────────────────────────
  it('401 when no session is present', async () => {
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
  });

  // ────────────────────────────────────────────────────────────────────────
  // cross-user RLS denial — userB cannot see userA's seeded book.
  //
  // Would fail if the handler ever filtered by `WHERE user_id = ?` against
  // an attacker-controlled value, or if it forgot to use the RLS-bound `tx`.
  // ────────────────────────────────────────────────────────────────────────
  it('cross-user RLS denial: userB sees no books seeded for userA', async () => {
    // Admin (bypass) inserts a row owned by userA.
    await adminClient`INSERT INTO books (user_id, book_hash, title, author, updated_at)
                      VALUES (${userA}, 'hash-A-secret', 'Secret', 'Author', now())`;

    const response = await rlsModule.withRls(userB, async (tx) => {
      const request = new Request('http://localhost/api/sync?since=0', { method: 'GET' });
      return syncModule.handleGet(request, { user: { id: userB }, tx });
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      books: Array<{ book_hash: string }>;
    };
    expect(body.books.find((b) => b.book_hash === 'hash-A-secret')).toBeUndefined();
    expect(body.books).toHaveLength(0);

    // And cross-check via admin that the row really exists — otherwise the
    // assertion above would pass for the wrong reason.
    const exists =
      await adminClient`SELECT 1 FROM books WHERE user_id = ${userA} AND book_hash = 'hash-A-secret'`;
    expect(exists.length).toBe(1);

    // Type-guard reference so `schema` isn't unused.
    expect(schema.books).toBeDefined();
  });
});
