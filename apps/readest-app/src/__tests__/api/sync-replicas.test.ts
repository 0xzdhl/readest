import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { runRoute } from '../utils/run-route';

/**
 * Integration tests for /api/sync/replicas and /api/sync/replica-keys
 * under the new `rlsMiddleware` chain.
 */

const getSessionMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/server', () => ({
  createAuth: () => ({ api: { getSession: getSessionMock } }),
}));

const url = process.env['TEST_DATABASE_URL'];

let adminClient: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle>;

type ReplicasRoute = typeof import('@/app/api/sync/replicas');
type ReplicaKeysRoute = typeof import('@/app/api/sync/replica-keys');

let replicasModule: ReplicasRoute;
let replicaKeysModule: ReplicaKeysRoute;

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

// HLC: physical-ms big-endian hex (13) "-" logical (8) "-" replica id.
// Build one anchored to "now" so push validators don't reject for clock skew.
const makeHlc = (offsetMs = 0): string => {
  const ms = (Date.now() + offsetMs).toString(16).padStart(13, '0');
  return `${ms}-00000000-A`;
};

type RouteLike = Parameters<typeof runRoute>[0];

describe.skipIf(!url)('/api/sync/replicas + /api/sync/replica-keys', () => {
  beforeAll(async () => {
    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) throw new Error('sync-replicas.test: bad TEST_DATABASE_URL');
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);

    const role = await appClient`SELECT current_user`;
    const currentUser = (role[0] as { current_user?: string } | undefined)?.current_user;
    if (currentUser !== 'readest_app') {
      throw new Error(`sync-replicas.test: connected as ${currentUser}, expected readest_app`);
    }

    vi.doMock('@/db/client', () => ({ createDbClient: () => appDb }));

    replicasModule = await import('@/app/api/sync/replicas');
    replicaKeysModule = await import('@/app/api/sync/replica-keys');

    await adminClient`INSERT INTO "user" (id, email, email_verified, name)
                      VALUES (${userA}, 'a-rep@test', true, 'User A'),
                             (${userB}, 'b-rep@test', true, 'User B')
                      ON CONFLICT (id) DO NOTHING`;
  }, 30_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
  });

  beforeEach(async () => {
    getSessionMock.mockReset();
    await adminClient`DELETE FROM replicas WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM replica_keys WHERE user_id IN (${userA}, ${userB})`;
  });

  // ─── replicas pull (GET) ─────────────────────────────────────────────────
  it('replicas GET: 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const request = new Request('http://localhost/api/sync/replicas?kind=settings', {
      method: 'GET',
    });
    const response = await runRoute(replicasModule.Route as RouteLike, 'GET', { request });
    expect(response.status).toBe(401);
  });

  it('replicas GET: returns only the caller’s rows (RLS scoped)', async () => {
    const tsA = makeHlc();
    const tsB = makeHlc();
    await adminClient`INSERT INTO replicas (user_id, kind, replica_id, fields_jsonb, updated_at_ts, schema_version)
                      VALUES (${userA}, 'settings', 'r-a', '{}'::jsonb, ${tsA}, 1),
                             (${userB}, 'settings', 'r-b', '{}'::jsonb, ${tsB}, 1)`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/sync/replicas?kind=settings', {
      method: 'GET',
    });
    const response = await runRoute(replicasModule.Route as RouteLike, 'GET', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Array<{ user_id: string; replica_id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.user_id).toBe(userA);
    expect(body.rows[0]?.replica_id).toBe('r-a');
  });

  // ─── replicas push (POST) ────────────────────────────────────────────────
  it('replicas POST push: merges via crdt_merge_replica', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const ts = makeHlc();
    const request = new Request('http://localhost/api/sync/replicas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: [
          {
            user_id: userA,
            kind: 'settings',
            replica_id: 'r-push',
            fields_jsonb: { k: { v: 'hello', t: ts } },
            manifest_jsonb: null,
            deleted_at_ts: null,
            reincarnation: null,
            updated_at_ts: ts,
            schema_version: 1,
          },
        ],
      }),
    });
    const response = await runRoute(replicasModule.Route as RouteLike, 'POST', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Array<{ replica_id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.replica_id).toBe('r-push');

    const persisted = await adminClient<{ replica_id: string; user_id: string }[]>`
      SELECT replica_id, user_id FROM replicas WHERE user_id = ${userA}`;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.replica_id).toBe('r-push');
  });

  // ─── replica-keys ────────────────────────────────────────────────────────
  it('replica-keys POST: creates a 32-byte salt and returns base64 string', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/sync/replica-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alg: 'pbkdf2-600k-sha256' }),
    });
    const response = await runRoute(replicaKeysModule.Route as RouteLike, 'POST', { request });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      row: { saltId: string; alg: string; salt: string; createdAt: string };
    };
    expect(body.row.alg).toBe('pbkdf2-600k-sha256');
    const decoded = Buffer.from(body.row.salt, 'base64');
    expect(decoded.length).toBe(32);
    expect(body.row.saltId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await adminClient<
      { salt_id: string; alg: string }[]
    >`SELECT salt_id, alg FROM replica_keys WHERE user_id = ${userA}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.salt_id).toBe(body.row.saltId);
  });

  it('replica-keys POST: rejects unsupported alg with 422', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/sync/replica-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alg: 'unsupported-alg' }),
    });
    const response = await runRoute(replicaKeysModule.Route as RouteLike, 'POST', { request });
    expect(response.status).toBe(422);
  });

  it('replica-keys GET: lists only the caller’s keys', async () => {
    const saltA = Buffer.alloc(32, 1);
    const saltB = Buffer.alloc(32, 2);
    await adminClient`INSERT INTO replica_keys (user_id, salt_id, alg, salt)
                      VALUES (${userA}, 'salt-A', 'pbkdf2-600k-sha256', ${saltA}),
                             (${userB}, 'salt-B', 'pbkdf2-600k-sha256', ${saltB})`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/sync/replica-keys', { method: 'GET' });
    const response = await runRoute(replicaKeysModule.Route as RouteLike, 'GET', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Array<{ saltId: string; salt: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.saltId).toBe('salt-A');
    expect(Buffer.from(body.rows[0]!.salt, 'base64').equals(saltA)).toBe(true);
  });

  it('replica-keys DELETE: forgets the caller’s salts only', async () => {
    const saltA = Buffer.alloc(32, 1);
    const saltB = Buffer.alloc(32, 2);
    await adminClient`INSERT INTO replica_keys (user_id, salt_id, alg, salt)
                      VALUES (${userA}, 'salt-A', 'pbkdf2-600k-sha256', ${saltA}),
                             (${userB}, 'salt-B', 'pbkdf2-600k-sha256', ${saltB})`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/sync/replica-keys', { method: 'DELETE' });
    const response = await runRoute(replicaKeysModule.Route as RouteLike, 'DELETE', { request });
    expect(response.status).toBe(200);

    const remaining = await adminClient<
      { user_id: string }[]
    >`SELECT user_id FROM replica_keys WHERE user_id IN (${userA}, ${userB})`;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.user_id).toBe(userB);
  });

  it('replica-keys DELETE: strips cipher envelopes from the caller’s replicas', async () => {
    const ts = makeHlc();
    const fields = {
      plain: { v: 'hello', t: ts },
      cipher: { v: { alg: 'aes-gcm', c: 'xxx' }, t: ts },
    };
    await adminClient`INSERT INTO replicas (user_id, kind, replica_id, fields_jsonb, updated_at_ts, schema_version)
                      VALUES (${userA}, 'settings', 'r-cipher', ${JSON.stringify(fields)}::jsonb, ${ts}, 1)`;
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const request = new Request('http://localhost/api/sync/replica-keys', { method: 'DELETE' });
    const response = await runRoute(replicaKeysModule.Route as RouteLike, 'DELETE', { request });
    expect(response.status).toBe(200);

    const after = await adminClient<{ fields_jsonb: Record<string, unknown> }[]>`
      SELECT fields_jsonb FROM replicas WHERE user_id = ${userA} AND replica_id = 'r-cipher'`;
    expect(after).toHaveLength(1);
    expect(after[0]?.fields_jsonb).toHaveProperty('plain');
    expect(after[0]?.fields_jsonb).not.toHaveProperty('cipher');
  });
});
