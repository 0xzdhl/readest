import { describe, expect, it } from 'vitest';
import { countSyncedRecords } from '@/hooks/useSync';

/**
 * Regression: the "{{count}} book(s) synced" toast must not count phantom
 * metadata-only book rows that were never uploaded (no files). Such rows have
 * `uploaded_at = null`. For `type === 'books'` the count must therefore gate on
 * a non-null `uploaded_at`; for other sync types (configs/notes) every
 * non-deleted record counts.
 */
describe('countSyncedRecords', () => {
  it('does not count metadata-only books with null uploaded_at', () => {
    expect(
      countSyncedRecords('books', [
        { deleted_at: null, uploaded_at: null },
        { deleted_at: null, uploaded_at: null },
      ]),
    ).toBe(0);
  });

  it('counts books that have a non-null uploaded_at', () => {
    expect(
      countSyncedRecords('books', [{ deleted_at: null, uploaded_at: '2026-06-22T00:00:00Z' }]),
    ).toBe(1);
  });

  it('does not count deleted books even when uploaded_at is set', () => {
    expect(
      countSyncedRecords('books', [
        { deleted_at: '2026-06-22T00:00:00Z', uploaded_at: '2026-06-22T00:00:00Z' },
      ]),
    ).toBe(0);
  });

  it('counts all non-deleted records for non-book types regardless of uploaded_at', () => {
    expect(countSyncedRecords('configs', [{ deleted_at: null }, { deleted_at: null }])).toBe(2);
  });

  it('returns 0 for null records', () => {
    expect(countSyncedRecords('notes', null)).toBe(0);
  });
});
