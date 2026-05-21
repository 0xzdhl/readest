import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { books, files, replicaKeys } from '@/db/schema';

// Only run when an explicit test DB is provided (e.g. via the docker setup
// in scripts/test-rls.sh). Otherwise we skip — these tests need a real
// Postgres + the `readest_app` role and would otherwise hammer a missing host.
const url = process.env['TEST_DATABASE_URL'];

let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle>;
let adminClient: ReturnType<typeof postgres>;

describe.skipIf(!url)('RLS isolation', () => {
  beforeAll(async () => {
    // run migrations as superuser
    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    // create app-role connection
    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) {
      throw new Error(
        'rls-isolation test: failed to substitute readest_app credentials into TEST_DATABASE_URL',
      );
    }
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);

    // Assert we actually connected as the restricted role; otherwise RLS would
    // be silently bypassed (superuser / table owner = no enforcement) and the
    // whole describe block would be tautological.
    const role = await appClient`SELECT current_user`;
    const currentUser = (role[0] as { current_user?: string } | undefined)?.current_user;
    if (currentUser !== 'readest_app') {
      throw new Error(
        `rls-isolation test: connected as ${currentUser}, expected readest_app`,
      );
    }
  }, 30_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
  });

  it('user A cannot read user B rows', async () => {
    // seed two users + one book each via admin (bypasses RLS — admin is the
    // table owner; RLS only restricts non-superusers / non-owners).
    const userA = '11111111-1111-1111-1111-111111111111';
    const userB = '22222222-2222-2222-2222-222222222222';
    await adminClient`INSERT INTO "user" (id, email, email_verified, name) VALUES (${userA}, 'a@test', true, 'User A'), (${userB}, 'b@test', true, 'User B') ON CONFLICT DO NOTHING`;
    await adminClient`DELETE FROM books WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`INSERT INTO books (user_id, book_hash) VALUES (${userA}, 'hash-a'), (${userB}, 'hash-b')`;

    // Sanity check: bypass_rls sees both rows we just seeded. If this fails
    // it means the seed didn't take, not that the policy works.
    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.bypass_rls', 'true', true)`);
      const all = await tx.select().from(books);
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    // As userA, scan books
    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userA}, true)`);
      const rows = await tx.select().from(books);
      expect(rows.every((r) => r.userId === userA)).toBe(true);
      expect(rows.length).toBe(1);
    });
  });

  it('user A cannot UPDATE user B rows', async () => {
    const userA = '11111111-1111-1111-1111-111111111111';
    const userB = '22222222-2222-2222-2222-222222222222';

    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userA}, true)`);
      const result = await tx.execute(
        sql`UPDATE books SET user_id = ${userA} WHERE user_id = ${userB}`,
      );
      // Should affect 0 rows because RLS hides user B's rows from user A.
      expect((result as unknown as { count: number }).count ?? 0).toBe(0);
    });
  });

  it('bypass_rls=true sees all rows', async () => {
    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.bypass_rls', 'true', true)`);
      const rows = await tx.select().from(books);
      expect(rows.length).toBe(2);
    });
  });

  it('files SELECT policy hides tombstoned (deleted_at NOT NULL) rows from owner', async () => {
    const userA = '11111111-1111-1111-1111-111111111111';
    // Seed: one live file and one tombstoned file for userA.
    await adminClient`DELETE FROM files WHERE user_id = ${userA}`;
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size, deleted_at) VALUES (${userA}, 'hash-a', 'key-live', 100, NULL), (${userA}, 'hash-a', 'key-dead', 100, now())`;

    // As userA via withRls, only the live row is visible.
    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userA}, true)`);
      const rows = await tx.select().from(files);
      expect(rows.length).toBe(1);
      expect(rows[0]?.fileKey).toBe('key-live');
    });

    // With bypass_rls, both rows are visible — proves the seed has both.
    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.bypass_rls', 'true', true)`);
      const rows = await tx
        .select()
        .from(files)
        .where(sql`user_id = ${userA}`);
      expect(rows.length).toBe(2);
    });
  });

  it('files UPDATE policy forbids resurrecting a tombstoned row', async () => {
    const userA = '11111111-1111-1111-1111-111111111111';
    // Seed a tombstoned row.
    await adminClient`DELETE FROM files WHERE user_id = ${userA}`;
    await adminClient`INSERT INTO files (user_id, book_hash, file_key, file_size, deleted_at) VALUES (${userA}, 'hash-a', 'key-dead', 100, now() - interval '1 day')`;

    // The SELECT policy hides the row, so an UPDATE matching the predicate
    // affects 0 rows (RLS uses SELECT predicate for USING on UPDATE row scan).
    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userA}, true)`);
      const result = await tx.execute(
        sql`UPDATE files SET deleted_at = NULL WHERE user_id = ${userA} AND file_key = 'key-dead'`,
      );
      expect((result as unknown as { count: number }).count ?? 0).toBe(0);
    });
  });

  it('replica_keys is append-only: UPDATE by owner affects 0 rows or errors', async () => {
    const userA = '11111111-1111-1111-1111-111111111111';
    // Seed a replica_keys row.
    await adminClient`DELETE FROM replica_keys WHERE user_id = ${userA}`;
    await adminClient`INSERT INTO replica_keys (user_id, salt_id, alg, salt) VALUES (${userA}, 'salt-1', 'pbkdf2', '\\x00'::bytea)`;

    // As userA via withRls, attempting to update `alg` must NOT mutate the row.
    // With no UPDATE policy, RLS denies the UPDATE entirely → 0 rows affected.
    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userA}, true)`);
      const result = await tx.execute(
        sql`UPDATE replica_keys SET alg = 'argon2id' WHERE user_id = ${userA} AND salt_id = 'salt-1'`,
      );
      expect((result as unknown as { count: number }).count ?? 0).toBe(0);
    });

    // Confirm the row is unchanged via admin.
    const after =
      await adminClient`SELECT alg FROM replica_keys WHERE user_id = ${userA} AND salt_id = 'salt-1'`;
    expect((after[0] as { alg?: string } | undefined)?.alg).toBe('pbkdf2');

    // But INSERT (under app.user_id) and SELECT and DELETE should still work.
    await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userA}, true)`);
      const rows = await tx.select().from(replicaKeys);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });
});
