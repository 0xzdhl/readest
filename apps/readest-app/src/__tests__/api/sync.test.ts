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
  // 401 wire-format — the file-route handler must re-shape the bare
  // `Response('Unauthorized', 401)` thrown by `resolveSessionOr401` into the
  // legacy JSON body `{ error: 'Not authenticated' }`. The client hook
  // (apps/readest-app/src/hooks/useSync.ts:148) does a substring-match on
  // the surfaced error message to trigger re-login; without this re-shape
  // the body is plain-text "Unauthorized" and re-login never fires.
  // ────────────────────────────────────────────────────────────────────────
  it('401 response body is { error: "Not authenticated" } JSON', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    // Re-import the route module to pick up the now-reset mock for this case.
    const mod = await import('@/app/api/sync');

    type RouteShape = {
      options: {
        server: {
          handlers: {
            GET: (args: { request: Request }) => Promise<Response>;
            POST: (args: { request: Request }) => Promise<Response>;
          };
        };
      };
    };
    const handlers = (mod.Route as unknown as RouteShape).options.server.handlers;
    const request = new Request('http://localhost/api/sync?since=0', { method: 'GET' });
    const response = await handlers.GET({ request });

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  // ────────────────────────────────────────────────────────────────────────
  // LWW: POST preserves server-newer rows.
  //
  // The legacy supabase route ran a per-record updated_at/deleted_at
  // comparison and only overwrote when the client's payload was strictly
  // newer. Phase 4's bulk `onConflictDoUpdate({ target, set })` originally
  // clobbered unconditionally; this test pins the restored gating so a stale
  // client payload cannot overwrite legitimate newer server state.
  // ────────────────────────────────────────────────────────────────────────
  it('LWW: POST preserves server-newer books (stale client payload is ignored)', async () => {
    const serverTime = new Date('2025-01-15T12:00:00.000Z');
    const staleClientTime = new Date('2025-01-15T11:00:00.000Z'); // 1h older

    // Seed userA's book directly through the route under test so the same
    // INSERT path runs (proves the upsert wins on its own first insert).
    await rlsModule.withRls(userA, async (tx) => {
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

    // POST a stale payload (older updated_at + a different title) — should
    // be rejected by the LWW gate and the server's row should be unchanged.
    const postResponse = await rlsModule.withRls(userA, async (tx) => {
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

    // Read back through admin (bypasses RLS) so we see exactly what was
    // persisted, independent of route GET semantics.
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

    await rlsModule.withRls(userA, async (tx) => {
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

    const postResponse = await rlsModule.withRls(userA, async (tx) => {
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

    // book_configs FK depends on books row existing.
    await adminClient`INSERT INTO books (user_id, book_hash, title, author, updated_at)
                      VALUES (${userA}, 'hash-A-cfg', 'Book', 'Author', ${serverTime.toISOString()})`;

    await rlsModule.withRls(userA, async (tx) => {
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

    await rlsModule.withRls(userA, async (tx) => {
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
