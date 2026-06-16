import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildBooksUpsertSet } from '@/app/api/sync';

/**
 * Regression: the books LWW upsert must NOT erase the server's real
 * `uploaded_at` when a device that never uploaded the file wins LWW with an
 * incoming `uploaded_at = null`. The `set:` map for `uploaded_at` therefore
 * has to be `COALESCE(excluded.uploaded_at, books.uploaded_at)` instead of a
 * bare `excluded.uploaded_at`, so a null incoming value can never clobber an
 * existing server value (cross-device file download would otherwise break).
 *
 * Rendered as SQL (no DB needed) so it runs in any environment.
 */
const dialect = new PgDialect();

describe('books upsert set: uploaded_at is non-destructive', () => {
  it('renders COALESCE(excluded.uploaded_at, books.uploaded_at) for uploaded_at', () => {
    const set = buildBooksUpsertSet();
    const uploadedAt = set['uploadedAt'];
    expect(uploadedAt).toBeDefined();

    const { sql } = dialect.sqlToQuery(uploadedAt!);
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ');
    expect(normalized).toContain('coalesce(excluded.uploaded_at');
    expect(normalized).toContain('"books".uploaded_at');
    // it must not be a bare overwrite that can null out the server value
    expect(normalized).not.toBe('excluded.uploaded_at');
  });

  it('still overwrites other columns directly with excluded.* (e.g. title)', () => {
    const set = buildBooksUpsertSet();
    const title = set['title'];
    expect(title).toBeDefined();
    const { sql } = dialect.sqlToQuery(title!);
    expect(sql.toLowerCase().replace(/\s+/g, ' ').trim()).toBe('excluded.title');
  });

  it('does not include the PK columns (user_id / book_hash) in the set map', () => {
    const set = buildBooksUpsertSet();
    expect(set['userId']).toBeUndefined();
    expect(set['bookHash']).toBeUndefined();
  });
});
