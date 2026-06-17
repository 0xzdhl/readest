/**
 * Unit tests for `handleGet` user-scope predicate (defense-in-depth).
 *
 * Goal: verify that `buildWhere` in `handleGet` ANDs an explicit
 * `eq(table.userId, ctx.user.id)` into every WHERE clause, regardless of
 * which query parameters are present. This is independent of RLS and ensures
 * the pull cannot leak another user's rows even with a superuser DB connection.
 *
 * Strategy: use a hermetic fake `tx` that never touches a real database.
 * The fake records every `.where(condition)` call so we can inspect whether
 * the condition tree references `user_id = <userId>` for each of the three
 * tables (books, bookConfigs, bookNotes).
 *
 * Drizzle conditions are plain objects with a `queryChunks` structure.
 * We serialise them to a string by walking the chunks and assert that the
 * user_id column name and user id value both appear.
 */
import { describe, expect, it } from 'vitest';
import { eq, getTableName, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { books, bookConfigs, bookNotes } from '@/db/schema';
import { handleGet } from '@/app/api/sync';
import type { SyncHandlerContext } from '@/app/api/sync';
import type { DbTx } from '@/db/rls';

// ---------------------------------------------------------------------------
// SQL serialiser
// ---------------------------------------------------------------------------

/**
 * Walk a Drizzle SQL node's queryChunks and produce a flat string.
 * Each chunk is either a raw SQL string fragment, a `Param` (bound value),
 * or a column reference with a `.name` property. This is enough to assert
 * that `user_id` and the user-id value appear in the serialised predicate.
 */
function conditionToString(cond: SQL | undefined): string {
  if (!cond) return '';
  const parts: string[] = [];
  for (const chunk of cond.queryChunks) {
    if (typeof chunk === 'string') {
      parts.push(chunk);
    } else if (chunk !== null && typeof chunk === 'object') {
      const c = chunk as Record<string, unknown>;
      if ('value' in c) {
        // Param node
        parts.push(String(c['value']));
      } else if ('name' in c) {
        // Column reference
        parts.push(String(c['name']));
      } else if ('queryChunks' in c) {
        // Nested SQL node — recurse
        parts.push(conditionToString(c as unknown as SQL));
      }
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Fake tx factory
// ---------------------------------------------------------------------------

/**
 * Returns a minimal fake drizzle `tx` whose `.select().from(table).where(cond)`
 * chain resolves with an empty array and records every WHERE condition.
 *
 * We use `getTableName(table)` (the stable drizzle public API) to extract the
 * SQL table name so the captured entries map to "books", "book_configs", etc.
 */
function makeFakeTx(capturedWheres: Array<{ tableName: string; cond: SQL | undefined }>): DbTx {
  const makeChain = (tableName: string) => ({
    where(cond: SQL | undefined) {
      capturedWheres.push({ tableName, cond });
      return {
        orderBy: () => ({
          limit: () => Promise.resolve([]),
        }),
      };
    },
  });

  const fakeTx = {
    select: () => ({
      from: (table: PgTable) => {
        return makeChain(getTableName(table));
      },
    }),
    execute: async () => [],
  };
  return fakeTx as unknown as DbTx;
}

/**
 * Build a minimal `SyncHandlerContext` for a given user id.
 */
function makeCtx(
  userId: string,
  captured: Array<{ tableName: string; cond: SQL | undefined }>,
): SyncHandlerContext {
  return { user: { id: userId }, tx: makeFakeTx(captured) };
}

/**
 * Assert that `cond` contains an equality predicate on `user_id` for `userId`.
 * We serialise `eq(table.userId, userId)` to a string and verify that string
 * is a substring of the serialised full condition.
 */
function assertOwnerPredicate(
  cond: SQL | undefined,
  table: typeof books | typeof bookConfigs | typeof bookNotes,
  userId: string,
  label: string,
): void {
  expect(cond, `${label}: WHERE must not be undefined`).toBeDefined();

  const condStr = conditionToString(cond);
  const ownerStr = conditionToString(eq(table.userId, userId));

  expect(condStr, `${label}: WHERE should include owner predicate (got: "${condStr}")`).toContain(
    ownerStr,
  );
  expect(condStr, `${label}: WHERE should contain the user id value`).toContain(userId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** Table name → schema table object lookup (SQL names match getTableName output) */
const TABLE_BY_NAME: Record<string, typeof books | typeof bookConfigs | typeof bookNotes> = {
  [getTableName(books)]: books,
  [getTableName(bookConfigs)]: bookConfigs,
  [getTableName(bookNotes)]: bookNotes,
};

describe('handleGet — user-scope predicate (defense-in-depth)', () => {
  /**
   * Call handleGet with given search-param suffix and return captured wheres.
   */
  async function runGet(
    extraParams: string,
    userId = TEST_USER_ID,
  ): Promise<Array<{ tableName: string; cond: SQL | undefined }>> {
    const captured: Array<{ tableName: string; cond: SQL | undefined }> = [];
    const ctx = makeCtx(userId, captured);
    const request = new Request(`http://localhost/api/sync?since=0${extraParams}`);
    await handleGet(request, ctx);
    return captured;
  }

  // ── Case 1: no book/meta filters → and(owner, freshness)
  it('includes owner predicate for all three tables when no book/meta params', async () => {
    const wheres = await runGet('');
    expect(wheres, 'should query 3 tables').toHaveLength(3);

    for (const { tableName, cond } of wheres) {
      const table = TABLE_BY_NAME[tableName];
      expect(table, `Unknown table name captured: "${tableName}"`).toBeDefined();
      assertOwnerPredicate(cond, table!, TEST_USER_ID, `${tableName} (no filters)`);
    }
  });

  // ── Case 2: book filter only → and(owner, eq(bookHash, ...), freshness)
  it('includes owner predicate when book param is set', async () => {
    const wheres = await runGet('&book=hash-test');
    expect(wheres, 'should query 3 tables').toHaveLength(3);

    for (const { tableName, cond } of wheres) {
      const table = TABLE_BY_NAME[tableName];
      expect(table, `Unknown table name: "${tableName}"`).toBeDefined();
      assertOwnerPredicate(cond, table!, TEST_USER_ID, `${tableName} (book filter)`);
    }
  });

  // ── Case 3: meta_hash filter only → and(owner, eq(metaHash, ...), freshness)
  it('includes owner predicate when meta_hash param is set', async () => {
    const wheres = await runGet('&meta_hash=meta-test');
    expect(wheres, 'should query 3 tables').toHaveLength(3);

    for (const { tableName, cond } of wheres) {
      const table = TABLE_BY_NAME[tableName];
      expect(table, `Unknown table name: "${tableName}"`).toBeDefined();
      assertOwnerPredicate(cond, table!, TEST_USER_ID, `${tableName} (meta_hash filter)`);
    }
  });

  // ── Case 4: both book + meta_hash → and(owner, or(bookHash, metaHash), freshness)
  it('includes owner predicate when both book and meta_hash params are set', async () => {
    const wheres = await runGet('&book=hash-test&meta_hash=meta-test');
    expect(wheres, 'should query 3 tables').toHaveLength(3);

    for (const { tableName, cond } of wheres) {
      const table = TABLE_BY_NAME[tableName];
      expect(table, `Unknown table name: "${tableName}"`).toBeDefined();
      assertOwnerPredicate(cond, table!, TEST_USER_ID, `${tableName} (book+meta filters)`);
    }
  });

  // ── Case 5: type=books — only the books table is queried
  it('includes owner predicate when type=books limits to books table', async () => {
    const wheres = await runGet('&type=books');
    expect(wheres, 'should query only 1 table for type=books').toHaveLength(1);
    const w = wheres[0]!;
    assertOwnerPredicate(w.cond, books, TEST_USER_ID, `${w.tableName} (type=books)`);
  });

  // ── Case 6: ctx.user.id is propagated — different user gets their own id
  it('uses ctx.user.id (not a hardcoded value)', async () => {
    const otherUser = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const wheres = await runGet('', otherUser);
    expect(wheres, 'should query 3 tables').toHaveLength(3);

    for (const { tableName, cond } of wheres) {
      const table = TABLE_BY_NAME[tableName];
      expect(table, `Unknown table name: "${tableName}"`).toBeDefined();
      assertOwnerPredicate(cond, table!, otherUser, `${tableName} (other user)`);
      // Regression: must NOT embed the default test user's id
      const condStr = conditionToString(cond);
      expect(condStr, `${tableName}: must not contain first user's id`).not.toContain(TEST_USER_ID);
    }
  });
});
