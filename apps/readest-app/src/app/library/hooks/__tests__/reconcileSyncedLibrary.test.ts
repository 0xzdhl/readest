import { describe, test, expect } from 'vitest';
import type { Book } from '@/domain/book';
import { reconcileSyncedLibrary } from '@/app/library/hooks/useBooksSync';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'h',
    format: 'EPUB',
    title: 'Book',
    author: 'Author',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('reconcileSyncedLibrary', () => {
  test('a book present in the live store is NEVER dropped, even if absent from the stale snapshot', () => {
    // `processed` was computed from a STALE snapshot that did not include
    // Hamlet (it was imported concurrently during the sync awaits).
    const hamlet = makeBook({ hash: '43d8', title: 'Hamlet', uploadedAt: 1500, updatedAt: 2000 });
    const other = makeBook({ hash: 'aaaa', title: 'Other', updatedAt: 1000 });
    const processed = [other]; // stale: missing Hamlet

    // The CURRENT live store (read at apply time) DOES contain Hamlet.
    const liveAtApply = [other, hamlet];

    const result = reconcileSyncedLibrary(processed, liveAtApply);

    const hashes = result.map((b) => b.hash).sort();
    expect(hashes).toContain('43d8'); // Hamlet preserved
    expect(hashes).toContain('aaaa');
  });

  test('processed (merged) version wins over the live snapshot for a shared hash', () => {
    // The sync merge already resolved the authoritative version for this book.
    const processedBook = makeBook({ hash: 'x', title: 'Merged', updatedAt: 3000 });
    const liveBook = makeBook({ hash: 'x', title: 'Live Stale', updatedAt: 2000 });

    const result = reconcileSyncedLibrary([processedBook], [liveBook]);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('Merged');
  });

  test('a concurrently-updated live book (e.g. uploadedAt just set) is kept when not in processed', () => {
    const processed: Book[] = []; // stale snapshot was empty
    const justUploaded = makeBook({ hash: 'up', uploadedAt: 9999, coverDownloadedAt: 8888 });

    const result = reconcileSyncedLibrary(processed, [justUploaded]);

    expect(result).toHaveLength(1);
    expect(result[0]!.uploadedAt).toBe(9999);
    expect(result[0]!.coverDownloadedAt).toBe(8888);
  });

  test('order: processed books first (preserves sync ordering), then live-only books appended', () => {
    const a = makeBook({ hash: 'a' });
    const b = makeBook({ hash: 'b' });
    const c = makeBook({ hash: 'c' });
    // processed has a, b; live adds c (concurrently imported).
    const result = reconcileSyncedLibrary([a, b], [a, b, c]);
    expect(result.map((x) => x.hash)).toEqual(['a', 'b', 'c']);
  });

  test('empty processed + empty live yields empty', () => {
    expect(reconcileSyncedLibrary([], [])).toEqual([]);
  });
});
