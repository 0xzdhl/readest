import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/**
 * Phase 5 integration tests for the share route tree.
 *
 *   Owner-only (auth-gated, RLS-scoped):
 *     - /api/share/create
 *     - /api/share/list
 *     - /api/share/$token/revoke
 *     - /api/share/$token/import          (authed; uses publicly resolved share + recipient RLS tx)
 *
 *   Public (token-only, withBypassRls):
 *     - /api/share/$token                  metadata
 *     - /api/share/$token/cover            302 to presigned cover URL
 *     - /api/share/$token/download         302 to presigned book URL
 *     - /api/share/$token/download/confirm download_count beacon
 *
 * (`og.png/route.ts` thunks into `render.tsx` which dynamically imports
 * satori + WASM — out of scope for an integration test that just needs to
 * pin the auth/DB contract.)
 */

const getSessionMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/server', () => ({
  auth: { api: { getSession: getSessionMock } },
}));

// Mock the storage object plane so we don't need real R2/S3 connectivity.
vi.mock('@/utils/object', () => ({
  getDownloadSignedUrl: vi
    .fn()
    .mockImplementation(async (key: string) => `https://signed.test/${key}`),
  getUploadSignedUrl: vi
    .fn()
    .mockImplementation(async (key: string) => `https://upload.test/${key}`),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  objectExists: vi.fn().mockResolvedValue(true),
  copyObject: vi.fn().mockResolvedValue(undefined),
}));

const url = process.env['TEST_DATABASE_URL'];

let adminClient: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle>;

type CreateRoute = typeof import('@/app/api/share/create/route');
type ListRoute = typeof import('@/app/api/share/list/route');
type TokenRoute = typeof import('@/app/api/share/$token/route');
type RevokeRoute = typeof import('@/app/api/share/$token/revoke/route');
type CoverRoute = typeof import('@/app/api/share/$token/cover/route');
type DownloadRoute = typeof import('@/app/api/share/$token/download/route');
type DownloadConfirmRoute = typeof import('@/app/api/share/$token/download/confirm/route');
type ImportRoute = typeof import('@/app/api/share/$token/import/route');

let createModule: CreateRoute;
let listModule: ListRoute;
let tokenModule: TokenRoute;
let revokeModule: RevokeRoute;
let coverModule: CoverRoute;
let downloadModule: DownloadRoute;
let downloadConfirmModule: DownloadConfirmRoute;
let importModule: ImportRoute;
let shareServer: typeof import('@/libs/shareServer');

interface RouteShape<P = unknown> {
  options: {
    server: {
      handlers: {
        GET?: (args: { request: Request; params: P }) => Promise<Response>;
        POST?: (args: { request: Request; params: P }) => Promise<Response>;
      };
    };
  };
}

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';

const sessionFor = (userId: string) => ({
  user: {
    id: userId,
    email: `${userId}@test`,
    emailVerified: true,
    name: 'Test',
    plan: 'free',
    storageUsageBytes: 0,
    storagePurchasedBytes: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: { id: 'sess-' + userId, userId, token: 't', expiresAt: new Date() },
});

describe.skipIf(!url)('/api/share/* (drizzle + runProtected/runPublic)', () => {
  beforeAll(async () => {
    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) throw new Error('share.test: bad TEST_DATABASE_URL');
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);

    const role = await appClient`SELECT current_user`;
    const currentUser = (role[0] as { current_user?: string } | undefined)?.current_user;
    if (currentUser !== 'readest_app') {
      throw new Error(`share.test: connected as ${currentUser}, expected readest_app`);
    }

    vi.doMock('@/db/client', () => ({ db: appDb, type: undefined }));

    createModule = await import('@/app/api/share/create/route');
    listModule = await import('@/app/api/share/list/route');
    tokenModule = await import('@/app/api/share/$token/route');
    revokeModule = await import('@/app/api/share/$token/revoke/route');
    coverModule = await import('@/app/api/share/$token/cover/route');
    downloadModule = await import('@/app/api/share/$token/download/route');
    downloadConfirmModule = await import('@/app/api/share/$token/download/confirm/route');
    importModule = await import('@/app/api/share/$token/import/route');
    shareServer = await import('@/libs/shareServer');

    await adminClient`INSERT INTO "user" (id, email, email_verified, name)
                      VALUES (${userA}, 'a-share@test', true, 'User A'),
                             (${userB}, 'b-share@test', true, 'User B')
                      ON CONFLICT (id) DO NOTHING`;
  }, 30_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
  });

  beforeEach(async () => {
    getSessionMock.mockReset();
    await adminClient`DELETE FROM book_shares WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM files WHERE user_id IN (${userA}, ${userB})`;
  });

  // Seed helper: book file, optional cover.
  const seedBookFile = async (userId: string, bookHash: string, withCover = false) => {
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                      VALUES (${userId}, ${bookHash}, ${userId + '/' + bookHash + '/book.epub'}, 1000)`;
    if (withCover) {
      await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                        VALUES (${userId}, ${bookHash}, ${userId + '/' + bookHash + '/cover.png'}, 100)`;
    }
  };

  // ─── create (owner-only) ─────────────────────────────────────────────────
  it('create: 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const post = (createModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/share/create', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const response = await post({ request, params: {} });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('create: inserts a book_shares row for the caller', async () => {
    await seedBookFile(userA, 'hash-A-1');
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const post = (createModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/share/create', {
      method: 'POST',
      body: JSON.stringify({
        bookHash: 'hash-A-1',
        expirationDays: 7,
        title: 'Test Book',
        format: 'EPUB',
      }),
    });
    const response = await post({ request, params: {} });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; url: string };
    expect(body.token).toBeTruthy();
    expect(body.token.length).toBe(22);

    const rows = await adminClient<{ user_id: string; book_hash: string; token: string }[]>`
      SELECT user_id, book_hash, token FROM book_shares WHERE user_id = ${userA}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.book_hash).toBe('hash-A-1');
    expect(rows[0]?.token).toBe(body.token);
  });

  // ─── list (owner-only) ───────────────────────────────────────────────────
  it('list: cross-user RLS denial — userB does not see userA shares', async () => {
    await seedBookFile(userA, 'hash-A-2');
    const hashA = await shareServer.hashShareToken('ABCDEFGHIJKLMNOPQRSTUV');
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_format, book_size, expires_at)
        VALUES (${hashA}, 'ABCDEFGHIJKLMNOPQRSTUV', ${userA}, 'hash-A-2', 'A', 'EPUB', 1000,
                ${new Date(Date.now() + 86400000)})`;

    getSessionMock.mockResolvedValueOnce(sessionFor(userB));
    const get = (listModule.Route as unknown as RouteShape).options.server.handlers.GET!;
    const request = new Request('http://localhost/api/share/list', { method: 'GET' });
    const response = await get({ request, params: {} });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { shares: unknown[] };
    expect(body.shares).toEqual([]);
  });

  // ─── revoke (owner-only) ─────────────────────────────────────────────────
  it('revoke: owner can revoke, sets revoked_at', async () => {
    await seedBookFile(userA, 'hash-A-3');
    const token = 'ABCDEFGHIJKLMNOPQRSTUW';
    const tokenHash = await shareServer.hashShareToken(token);
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_format, book_size, expires_at)
        VALUES (${tokenHash}, ${token}, ${userA}, 'hash-A-3', 'A', 'EPUB', 1000,
                ${new Date(Date.now() + 86400000)})`;

    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const post = (revokeModule.Route as unknown as RouteShape<{ token: string }>).options.server
      .handlers.POST!;
    const request = new Request(`http://localhost/api/share/${token}/revoke`, { method: 'POST' });
    const response = await post({ request, params: { token } });
    expect(response.status).toBe(204);

    const persisted = await adminClient<
      { revoked_at: Date | null }[]
    >`SELECT revoked_at FROM book_shares WHERE token_hash = ${tokenHash}`;
    expect(persisted[0]?.revoked_at).not.toBeNull();
  });

  // ─── public token metadata ───────────────────────────────────────────────
  it('$token GET: returns metadata for an active share', async () => {
    await seedBookFile(userA, 'hash-A-4', true);
    const token = 'ABCDEFGHIJKLMNOPQRSTUX';
    const tokenHash = await shareServer.hashShareToken(token);
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_author, book_format, book_size, expires_at)
        VALUES (${tokenHash}, ${token}, ${userA}, 'hash-A-4', 'The Book', 'The Author', 'EPUB',
                1000, ${new Date(Date.now() + 86400000)})`;

    const get = (tokenModule.Route as unknown as RouteShape<{ token: string }>).options.server
      .handlers.GET!;
    const request = new Request(`http://localhost/api/share/${token}`, { method: 'GET' });
    const response = await get({ request, params: { token } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      title: string;
      author: string;
      hasCover: boolean;
    };
    expect(body.title).toBe('The Book');
    expect(body.author).toBe('The Author');
    expect(body.hasCover).toBe(true);
  });

  it('$token GET: 404 not_found for unknown token', async () => {
    const get = (tokenModule.Route as unknown as RouteShape<{ token: string }>).options.server
      .handlers.GET!;
    const request = new Request('http://localhost/api/share/NOPENOPENOPENOPENOPEXX', {
      method: 'GET',
    });
    const response = await get({ request, params: { token: 'NOPENOPENOPENOPENOPEXX' } });
    expect(response.status).toBe(404);
  });

  it('$token GET: 410 revoked', async () => {
    await seedBookFile(userA, 'hash-A-rev');
    const token = 'ABCDEFGHIJKLMNOPQRSTUY';
    const tokenHash = await shareServer.hashShareToken(token);
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_format, book_size, expires_at, revoked_at)
        VALUES (${tokenHash}, ${token}, ${userA}, 'hash-A-rev', 'A', 'EPUB', 1000,
                ${new Date(Date.now() + 86400000)}, ${new Date()})`;

    const get = (tokenModule.Route as unknown as RouteShape<{ token: string }>).options.server
      .handlers.GET!;
    const request = new Request(`http://localhost/api/share/${token}`, { method: 'GET' });
    const response = await get({ request, params: { token } });
    expect(response.status).toBe(410);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe('revoked');
  });

  // ─── public cover / download ─────────────────────────────────────────────
  it('$token/cover GET: 302 to signed URL for share with cover', async () => {
    await seedBookFile(userA, 'hash-A-cov', true);
    const token = 'ABCDEFGHIJKLMNOPQRSTUZ';
    const tokenHash = await shareServer.hashShareToken(token);
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_format, book_size, expires_at)
        VALUES (${tokenHash}, ${token}, ${userA}, 'hash-A-cov', 'A', 'EPUB', 1000,
                ${new Date(Date.now() + 86400000)})`;

    const get = (coverModule.Route as unknown as RouteShape<{ token: string }>).options.server
      .handlers.GET!;
    const request = new Request(`http://localhost/api/share/${token}/cover`, { method: 'GET' });
    const response = await get({ request, params: { token } });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toMatch(/^https:\/\/signed.test\//);
  });

  it('$token/download GET: 302 to signed URL', async () => {
    await seedBookFile(userA, 'hash-A-dl');
    const token = 'AABCDEFGHIJKLMNOPQRSTU';
    const tokenHash = await shareServer.hashShareToken(token);
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_format, book_size, expires_at)
        VALUES (${tokenHash}, ${token}, ${userA}, 'hash-A-dl', 'A', 'EPUB', 1000,
                ${new Date(Date.now() + 86400000)})`;

    const get = (downloadModule.Route as unknown as RouteShape<{ token: string }>).options.server
      .handlers.GET!;
    const request = new Request(`http://localhost/api/share/${token}/download`, { method: 'GET' });
    const response = await get({ request, params: { token } });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toMatch(/^https:\/\/signed.test\//);
  });

  // ─── public download confirm beacon ──────────────────────────────────────
  it('$token/download/confirm POST: increments download_count atomically', async () => {
    await seedBookFile(userA, 'hash-A-cnf');
    const token = 'BBCDEFGHIJKLMNOPQRSTUV';
    const tokenHash = await shareServer.hashShareToken(token);
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_format, book_size, expires_at, download_count)
        VALUES (${tokenHash}, ${token}, ${userA}, 'hash-A-cnf', 'A', 'EPUB', 1000,
                ${new Date(Date.now() + 86400000)}, 0)`;

    const post = (downloadConfirmModule.Route as unknown as RouteShape<{ token: string }>).options
      .server.handlers.POST!;
    const request = new Request(`http://localhost/api/share/${token}/download/confirm`, {
      method: 'POST',
    });
    const response = await post({ request, params: { token } });
    expect(response.status).toBe(204);

    const after = await adminClient<
      { download_count: number }[]
    >`SELECT download_count FROM book_shares WHERE token_hash = ${tokenHash}`;
    expect(after[0]?.download_count).toBe(1);
  });

  it('$token/download/confirm: does NOT bump revoked shares', async () => {
    await seedBookFile(userA, 'hash-A-cnf-rev');
    const token = 'CBCDEFGHIJKLMNOPQRSTUV';
    const tokenHash = await shareServer.hashShareToken(token);
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_format, book_size, expires_at, revoked_at, download_count)
        VALUES (${tokenHash}, ${token}, ${userA}, 'hash-A-cnf-rev', 'A', 'EPUB', 1000,
                ${new Date(Date.now() + 86400000)}, ${new Date()}, 0)`;

    const post = (downloadConfirmModule.Route as unknown as RouteShape<{ token: string }>).options
      .server.handlers.POST!;
    const request = new Request(`http://localhost/api/share/${token}/download/confirm`, {
      method: 'POST',
    });
    const response = await post({ request, params: { token } });
    expect(response.status).toBe(204);

    const after = await adminClient<
      { download_count: number }[]
    >`SELECT download_count FROM book_shares WHERE token_hash = ${tokenHash}`;
    expect(after[0]?.download_count).toBe(0);
  });

  // ─── import (owner-authed; sharer != recipient) ──────────────────────────
  it('import POST: copies bytes into recipient namespace and inserts files row', async () => {
    await seedBookFile(userA, 'hash-A-imp');
    const token = 'DBCDEFGHIJKLMNOPQRSTUV';
    const tokenHash = await shareServer.hashShareToken(token);
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_format, book_size, expires_at)
        VALUES (${tokenHash}, ${token}, ${userA}, 'hash-A-imp', 'A', 'EPUB', 1000,
                ${new Date(Date.now() + 86400000)})`;

    getSessionMock.mockResolvedValueOnce(sessionFor(userB));
    const post = (importModule.Route as unknown as RouteShape<{ token: string }>).options.server
      .handlers.POST!;
    const request = new Request(`http://localhost/api/share/${token}/import`, { method: 'POST' });
    const response = await post({ request, params: { token } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { alreadyOwned: boolean; bookHash: string };
    expect(body.alreadyOwned).toBe(false);
    expect(body.bookHash).toBe('hash-A-imp');

    const recipientFiles = await adminClient<
      { user_id: string; book_hash: string; file_key: string }[]
    >`SELECT user_id, book_hash, file_key FROM files WHERE user_id = ${userB}`;
    expect(recipientFiles).toHaveLength(1);
    expect(recipientFiles[0]?.file_key.startsWith(`${userB}/`)).toBe(true);
    expect(recipientFiles[0]?.book_hash).toBe('hash-A-imp');
  });

  it('import POST: idempotent when recipient already owns the book', async () => {
    await seedBookFile(userA, 'hash-A-idem');
    await seedBookFile(userB, 'hash-A-idem'); // recipient already has it
    const token = 'EBCDEFGHIJKLMNOPQRSTUV';
    const tokenHash = await shareServer.hashShareToken(token);
    await adminClient`INSERT INTO book_shares
        (token_hash, token, user_id, book_hash, book_title, book_format, book_size, expires_at)
        VALUES (${tokenHash}, ${token}, ${userA}, 'hash-A-idem', 'A', 'EPUB', 1000,
                ${new Date(Date.now() + 86400000)})`;

    getSessionMock.mockResolvedValueOnce(sessionFor(userB));
    const post = (importModule.Route as unknown as RouteShape<{ token: string }>).options.server
      .handlers.POST!;
    const request = new Request(`http://localhost/api/share/${token}/import`, { method: 'POST' });
    const response = await post({ request, params: { token } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { alreadyOwned: boolean };
    expect(body.alreadyOwned).toBe(true);

    // No extra file row inserted.
    const count = await adminClient<
      { c: string }[]
    >`SELECT count(*)::text AS c FROM files WHERE user_id = ${userB}`;
    expect(Number(count[0]?.c)).toBe(1);
  });
});
