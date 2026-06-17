import { Effect, Layer } from 'effect';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setCurrentUserNamespace } from '@/services/userNamespace';
import {
  getUserNamespaceDir,
  getLibraryStoragePath,
  getConfigStoragePath,
} from '@/utils/userPaths';
import { FileSystem } from '@/application/ports/FileSystem';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';
import { saveLibraryBooks, loadLibraryBooks } from '@/application/services/library/libraryData';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import type { Book } from '@/domain/book';

// ---------------------------------------------------------------------------
// Unit tests for path helpers
// ---------------------------------------------------------------------------

describe('userPaths helpers', () => {
  beforeEach(() => setCurrentUserNamespace(null));
  afterEach(() => setCurrentUserNamespace(null));

  it('namespaces under the current user', () => {
    setCurrentUserNamespace('user-A');
    expect(getUserNamespaceDir()).toBe('users/user-A');
    expect(getLibraryStoragePath()).toBe('users/user-A/library.json');
    expect(getConfigStoragePath({ hash: 'h1' })).toBe('users/user-A/h1/config.json');
  });

  it('uses local namespace when signed out', () => {
    expect(getLibraryStoragePath()).toBe('users/local/library.json');
  });
});

// ---------------------------------------------------------------------------
// Cross-namespace isolation regression
// ---------------------------------------------------------------------------

// Stub CoverService: generateCoverImageUrl returns '' (no actual file needed)
const StubCoverServiceLive = Layer.succeed(CoverService, {
  getCoverImageUrl: (_book: Book) => '',
  getCoverImageBlobUrl: (_book: Book) => Effect.succeed(''),
  getCachedImageUrl: (_pathOrUrl: string) => Effect.succeed(''),
  generateCoverImageUrl: (_book: Book) => Effect.succeed(''),
  updateCoverImage: (_book: Book, _imageUrl?: string, _imageFile?: string) => Effect.void,
} satisfies CoverServiceShape);

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Ports = Layer.merge(TestFileSystemLive, Base);
const PortsWithCover = Layer.merge(Ports, StubCoverServiceLive);

const run = <A>(p: Effect.Effect<A, unknown, FileSystem | CoverService>) =>
  Effect.runPromise(p.pipe(Effect.provide(PortsWithCover)) as Effect.Effect<A, unknown, never>);

const BOOK_A: Book = {
  hash: 'hash-a',
  format: 'EPUB',
  title: 'Book A',
  author: 'Author A',
  createdAt: 1000,
  updatedAt: 1000,
  deletedAt: null,
  downloadedAt: 1000,
  uploadedAt: null,
} as Book;

describe('library cross-namespace isolation', () => {
  afterEach(() => setCurrentUserNamespace(null));

  it('saving under user-A is not visible to user-B, and is recovered when switching back to user-A', async () => {
    // Run all three operations within a single layer scope so the in-memory FS
    // store persists across the namespace switches.
    const [booksForB, booksForA] = await run(
      Effect.gen(function* () {
        // Save library as user-A
        setCurrentUserNamespace('user-A');
        yield* saveLibraryBooks([BOOK_A]);

        // Switch to user-B — should see an empty library
        setCurrentUserNamespace('user-B');
        const forB = yield* loadLibraryBooks();

        // Switch back to user-A — should still have the saved book
        setCurrentUserNamespace('user-A');
        const forA = yield* loadLibraryBooks();

        return [forB, forA] as const;
      }),
    );

    expect(booksForB).toEqual([]);
    expect(booksForA).toHaveLength(1);
    expect(booksForA[0]?.hash).toBe('hash-a');
  });
});
