import { describe, test, expect } from 'vitest';
import type { Book } from '@/domain/book';
import { mergeSyncedBook } from '@/app/library/hooks/useBooksSync';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: '43d8',
    format: 'EPUB',
    title: 'Hamlet',
    author: 'Shakespeare',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('mergeSyncedBook', () => {
  test('a stale/contaminated tombstone must NOT drop a present, uploaded local book', () => {
    // Present local book: live (no deletedAt), newer updatedAt, uploaded.
    const oldBook = makeBook({
      deletedAt: undefined,
      updatedAt: 2000,
      uploadedAt: 1500,
    });
    // Stale synced row carrying a tombstone whose updatedAt is NOT newer than
    // the local book (e.g. a contaminated row from another user, or a delete
    // the server already lost the LWW for).
    const matchingBook = makeBook({
      deletedAt: 1000,
      updatedAt: 1000,
    });

    const merged = mergeSyncedBook(oldBook, matchingBook);

    // The book must remain visible — deletedAt stays unset.
    expect(merged.deletedAt == null).toBe(true);
    // Local non-deleted state is preserved; book stays uploaded.
    expect(merged.uploadedAt).toBe(1500);
  });

  test('a genuine newer delete still wins (tombstone applied)', () => {
    const oldBook = makeBook({
      deletedAt: undefined,
      updatedAt: 2000,
      uploadedAt: 1500,
    });
    // Genuine newer delete: updatedAt >= local AND deletedAt newer than local.
    const matchingBook = makeBook({
      deletedAt: 3000,
      updatedAt: 3000,
    });

    const merged = mergeSyncedBook(oldBook, matchingBook);

    expect(merged.deletedAt).toBe(3000);
  });

  test('a newer delete beats an older local delete (LWW on deletedAt)', () => {
    const oldBook = makeBook({ deletedAt: 1000, updatedAt: 1000 });
    const matchingBook = makeBook({ deletedAt: 3000, updatedAt: 3000 });

    const merged = mergeSyncedBook(oldBook, matchingBook);

    expect(merged.deletedAt).toBe(3000);
  });

  test('an older synced tombstone never resurrects a newer local delete', () => {
    // Local book already deleted recently; a stale synced tombstone arrives.
    const oldBook = makeBook({ deletedAt: 3000, updatedAt: 3000 });
    const matchingBook = makeBook({ deletedAt: 1000, updatedAt: 1000 });

    const merged = mergeSyncedBook(oldBook, matchingBook);

    // The newer local delete must be preserved.
    expect(merged.deletedAt).toBe(3000);
  });

  test('when the synced row is newer and live, its (live) deletedAt clears nothing extra', () => {
    // Server has a newer, live revision (e.g. re-uploaded). Local was deleted
    // with an OLDER deletedAt. A live newer server row should win → undeleted.
    const oldBook = makeBook({ deletedAt: 1000, updatedAt: 1000 });
    const matchingBook = makeBook({
      deletedAt: undefined,
      updatedAt: 3000,
      uploadedAt: 2900,
    });

    const merged = mergeSyncedBook(oldBook, matchingBook);

    // Server's newer live state wins; book becomes visible again.
    expect(merged.deletedAt == null).toBe(true);
    expect(merged.updatedAt).toBe(3000);
  });

  test('base field merge mirrors LWW orientation (server wins when updatedAt >= local)', () => {
    const oldBook = makeBook({ title: 'Old Title', updatedAt: 2000 });
    const matchingBook = makeBook({ title: 'New Title', updatedAt: 2500 });

    const merged = mergeSyncedBook(oldBook, matchingBook);

    expect(merged.title).toBe('New Title');
  });

  test('base field merge keeps local when it is strictly newer', () => {
    const oldBook = makeBook({ title: 'Local Title', updatedAt: 3000 });
    const matchingBook = makeBook({ title: 'Server Title', updatedAt: 2000 });

    const merged = mergeSyncedBook(oldBook, matchingBook);

    expect(merged.title).toBe('Local Title');
  });
});
