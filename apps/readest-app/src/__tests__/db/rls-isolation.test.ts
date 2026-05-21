import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { books } from '@/db/schema';

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
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);
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
});
