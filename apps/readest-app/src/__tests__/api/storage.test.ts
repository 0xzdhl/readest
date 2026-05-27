import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { runRoute } from '../utils/run-route';

/**
 * Integration test for the storage route tree (upload / download / list /
 * purge / stats / delete) using `rlsMiddleware`. Routes go through the
 * middleware chain end-to-end via `runRoute` so RLS scoping is exercised
 * against the real `readest_app` pool.
 */

const getSessionMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/server', () => ({
  createAuth: () => ({ api: { getSession: getSessionMock } }),
}));

const runStorageProgramMock = vi.hoisted(() => vi.fn());

vi.mock('@/storage/run', () => ({
  runStorageProgram: runStorageProgramMock,
}));

const url = process.env['TEST_DATABASE_URL'];

let adminClient: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle>;

type UploadRoute = typeof import('@/app/api/storage/upload');
type DownloadRoute = typeof import('@/app/api/storage/download');
type ListRoute = typeof import('@/app/api/storage/list');
type PurgeRoute = typeof import('@/app/api/storage/purge');
type StatsRoute = typeof import('@/app/api/storage/stats');
type DeleteRoute = typeof import('@/app/api/storage/delete');

let uploadModule: UploadRoute;
let downloadModule: DownloadRoute;
let listModule: ListRoute;
let purgeModule: PurgeRoute;
let statsModule: StatsRoute;
let deleteModule: DeleteRoute;

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

type RouteLike = Parameters<typeof runRoute>[0];

describe.skipIf(!url)('/api/storage/* (rlsMiddleware + RLS)', () => {
  beforeAll(async () => {
    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) {
      throw new Error('storage.test: failed to substitute readest_app credentials');
    }
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);

    const role = await appClient`SELECT current_user`;
    const currentUser = (role[0] as { current_user?: string } | undefined)?.current_user;
    if (currentUser !== 'readest_app') {
      throw new Error(`storage.test: connected as ${currentUser}, expected readest_app`);
    }

    vi.doMock('@/db/client', () => ({ createDbClient: () => appDb }));

    uploadModule = await import('@/app/api/storage/upload');
    downloadModule = await import('@/app/api/storage/download');
    listModule = await import('@/app/api/storage/list');
    purgeModule = await import('@/app/api/storage/purge');
    statsModule = await import('@/app/api/storage/stats');
    deleteModule = await import('@/app/api/storage/delete');

    await adminClient`INSERT INTO "user" (id, email, email_verified, name)
                      VALUES (${userA}, 'a-storage@test', true, 'User A'),
                             (${userB}, 'b-storage@test', true, 'User B')
                      ON CONFLICT (id) DO NOTHING`;
  }, 30_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
  });

  beforeEach(async () => {
    getSessionMock.mockReset();
    runStorageProgramMock.mockReset();
    // Default storage behaviour: presigns succeed with placeholder URL.
    runStorageProgramMock.mockImplementation(async () => 'https://signed.test/default');
    await adminClient`DELETE FROM files WHERE user_id IN (${userA}, ${userB})`;
  });

  // ─── upload ──────────────────────────────────────────────────────────────
  it('upload: 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const request = new Request('http://localhost/api/storage/upload', {
      method: 'POST',
      body: JSON.stringify({ fileName: 'x.epub', fileSize: 100 }),
    });
    const response = await runRoute(uploadModule.Route as RouteLike, 'POST', { request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('upload: inserts files row and returns signed URL on first upload', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/storage/upload', {
      method: 'POST',
      body: JSON.stringify({ fileName: 'book.epub', fileSize: 1000, bookHash: 'hash-A-1' }),
    });
    runStorageProgramMock.mockResolvedValueOnce('https://upload.test/book.epub');
    const response = await runRoute(uploadModule.Route as RouteLike, 'POST', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { uploadUrl?: string; fileKey?: string };
    expect(body.fileKey).toBe(`${userA}/book.epub`);
    expect(body.uploadUrl).toMatch(/^https:\/\/upload.test\//);

    const rows = await adminClient<
      { user_id: string; file_key: string; book_hash: string | null; file_size: number }[]
    >`SELECT user_id, file_key, book_hash, file_size FROM files WHERE user_id = ${userA}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.file_key).toBe(`${userA}/book.epub`);
    expect(rows[0]?.book_hash).toBe('hash-A-1');
  });

  // ─── download ────────────────────────────────────────────────────────────
  it('download GET: returns signed URL for own file', async () => {
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                      VALUES (${userA}, 'hash-A-2', ${userA + '/file.epub'}, 200)`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request(
      `http://localhost/api/storage/download?fileKey=${encodeURIComponent(userA + '/file.epub')}`,
      { method: 'GET' },
    );
    runStorageProgramMock.mockResolvedValueOnce('https://signed.test/file');
    const response = await runRoute(downloadModule.Route as RouteLike, 'GET', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { downloadUrl?: string };
    expect(body.downloadUrl).toContain('signed.test');
  });

  it('download GET: cross-user RLS denial returns 404 (not 200 with other user URL)', async () => {
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                      VALUES (${userA}, 'hash-secret', 'secret-key', 200)`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userB));
    const request = new Request(`http://localhost/api/storage/download?fileKey=secret-key`, {
      method: 'GET',
    });
    const response = await runRoute(downloadModule.Route as RouteLike, 'GET', { request });
    expect(response.status).toBe(404);
  });

  // ─── list ────────────────────────────────────────────────────────────────
  it('list: returns only the caller’s files', async () => {
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                      VALUES (${userA}, 'hash-A-3', ${userA + '/a.epub'}, 300),
                             (${userB}, 'hash-B-3', ${userB + '/b.epub'}, 400)`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/storage/list', { method: 'GET' });
    const response = await runRoute(listModule.Route as RouteLike, 'GET', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { file_key: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.files.map((f) => f.file_key)).toEqual([`${userA}/a.epub`]);
  });

  // ─── purge ───────────────────────────────────────────────────────────────
  it('purge: deletes only the caller’s rows; cross-user keys 404', async () => {
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                      VALUES (${userA}, 'hash-A-4', 'a-purge-key', 100),
                             (${userB}, 'hash-B-4', 'b-purge-key', 100)`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/storage/purge', {
      method: 'DELETE',
      body: JSON.stringify({ fileKeys: ['a-purge-key', 'b-purge-key'] }),
    });
    const response = await runRoute(purgeModule.Route as RouteLike, 'DELETE', { request });
    expect(response.status).toBe(207);
    const body = (await response.json()) as {
      success: string[];
      failed: Array<{ fileKey: string }>;
    };
    expect(body.success).toContain('a-purge-key');
    expect(body.failed.map((f) => f.fileKey)).toContain('b-purge-key');

    const remaining = await adminClient<
      { file_key: string }[]
    >`SELECT file_key FROM files WHERE file_key = 'b-purge-key'`;
    expect(remaining).toHaveLength(1);
  });

  // ─── stats ───────────────────────────────────────────────────────────────
  it('stats: aggregates only the caller’s files', async () => {
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                      VALUES (${userA}, 'hash-X', ${userA + '/x.epub'}, 1000),
                             (${userA}, 'hash-X', ${userA + '/x.png'}, 100),
                             (${userA}, 'hash-Y', ${userA + '/y.epub'}, 500),
                             (${userB}, 'hash-X', ${userB + '/x.epub'}, 9999)`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/storage/stats', { method: 'GET' });
    const response = await runRoute(statsModule.Route as RouteLike, 'GET', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      totalFiles: number;
      totalSize: number;
      byBookHash: Array<{ bookHash: string | null; fileCount: number; totalSize: number }>;
    };
    expect(body.totalFiles).toBe(3);
    expect(body.totalSize).toBe(1600);
    expect(body.byBookHash[0]?.bookHash).toBe('hash-X');
    expect(body.byBookHash[0]?.totalSize).toBe(1100);
    expect(body.byBookHash[1]?.bookHash).toBe('hash-Y');
    expect(body.byBookHash[1]?.totalSize).toBe(500);
  });

  // ─── delete ──────────────────────────────────────────────────────────────
  it('delete: removes own file and 404s on cross-user keys', async () => {
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size)
                      VALUES (${userA}, 'hash-A-5', 'a-del-key', 100),
                             (${userB}, 'hash-B-5', 'b-del-key', 100)`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));

    const ownReq = new Request(`http://localhost/api/storage/delete?fileKey=a-del-key`, {
      method: 'DELETE',
    });
    const ownResp = await runRoute(deleteModule.Route as RouteLike, 'DELETE', { request: ownReq });
    expect(ownResp.status).toBe(200);

    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const crossReq = new Request(`http://localhost/api/storage/delete?fileKey=b-del-key`, {
      method: 'DELETE',
    });
    const crossResp = await runRoute(deleteModule.Route as RouteLike, 'DELETE', {
      request: crossReq,
    });
    expect(crossResp.status).toBe(404);
  });
});
