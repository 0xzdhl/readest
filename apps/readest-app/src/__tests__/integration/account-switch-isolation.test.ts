/**
 * End-to-end regression test for the cross-account data-isolation bug.
 *
 * Reported scenario: User A uploads a book (hash `9cbb...`). User signs out and
 * into account B on the SAME device. The book + reading progress wrongly appear
 * under B, and opening it 404s (the file only exists under A's storage prefix).
 *
 * Root cause: global local stores never reset/namespaced on account switch (so
 * A's books got pushed under B), plus the server pull had no user predicate.
 *
 * This test drives THREE composed layers to prove the fix is correct end-to-end:
 *
 *   1. Namespace isolation (Tasks 3 & 4): A's library.json + config.json are NOT
 *      visible to B's load; A's data is preserved after switching back.
 *
 *   2. Push owner-guard (Task 4 & 6): the `loadedNamespace !== getCurrentUserNamespace()`
 *      invariant blocks A's cached library from being pushed as B; then
 *      `resetForUserSwitch()` wipes the store.
 *
 *   3. Server pull scoping (Task 1): `handleGet` ANDs `eq(table.userId, ctx.user.id)`
 *      so user B's pull cannot return user A's rows from the database.
 *
 * If any of the namespacing / guard / server-predicate pieces are reverted, at
 * least one assertion group here will fail.
 */

// ---------------------------------------------------------------------------
// Vitest setup -- mock environment + md5 (same pattern as library-store tests)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
  getAPIBaseUrl: () => 'https://example.test',
}));

vi.mock('@/utils/md5', () => ({
  md5Fingerprint: (value: string) => `md5_${value.replace(/[^a-zA-Z0-9]/g, '_')}`,
}));

// ---------------------------------------------------------------------------
// Effect imports (layered FS, namespace, library data)
// ---------------------------------------------------------------------------

import { Effect, Layer } from 'effect';
import { eq, getTableName, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { setCurrentUserNamespace, getCurrentUserNamespace } from '@/services/userNamespace';
import { saveLibraryBooks, loadLibraryBooks } from '@/application/services/library/libraryData';
import { FileSystem } from '@/application/ports/FileSystem';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import { useLibraryStore } from '@/store/libraryStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';
import { safeSaveJsonE } from '@/application/services/shared/json';
import { getConfigStoragePath } from '@/utils/userPaths';

import { books, bookConfigs, bookNotes } from '@/db/schema';
import { handleGet } from '@/app/api/sync';
import type { SyncHandlerContext } from '@/app/api/sync';
import type { DbTx } from '@/db/rls';

import type { Book, BookConfig } from '@/domain/book';

// ---------------------------------------------------------------------------
// Minimal typed Book factory -- no `any`, all required fields present
// ---------------------------------------------------------------------------

function makeBook(overrides: Partial<Book> & { hash: string; title: string }): Book {
  return {
    format: 'EPUB',
    author: 'Author',
    createdAt: 1_000,
    updatedAt: 1_000,
    deletedAt: null,
    downloadedAt: null,
    uploadedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub CoverService -- generateCoverImageUrl returns '' (no file access needed)
// ---------------------------------------------------------------------------

const StubCoverServiceLive = Layer.succeed(CoverService, {
  getCoverImageUrl: (_book: Book) => '',
  getCoverImageBlobUrl: (_book: Book) => Effect.succeed(''),
  getCachedImageUrl: (_pathOrUrl: string) => Effect.succeed(''),
  generateCoverImageUrl: (_book: Book) => Effect.succeed(''),
  updateCoverImage: (_book: Book, _imageUrl?: string, _imageFile?: string) => Effect.void,
} satisfies CoverServiceShape);

// Build layers (shared across the Effect.gen tests in group 1)
const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Ports = Layer.merge(TestFileSystemLive, Base);
const PortsWithCover = Layer.merge(Ports, StubCoverServiceLive);

// Runner: provide all ports and run to Promise
const run = <A>(effect: Effect.Effect<A, unknown, FileSystem | CoverService>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(PortsWithCover)) as Effect.Effect<A, unknown, never>,
  );

// ---------------------------------------------------------------------------
// Group 1: Namespace isolation (Tasks 3 + 4)
// ---------------------------------------------------------------------------

describe('Group 1 - Namespace isolation (core cross-account isolation)', () => {
  afterEach(() => setCurrentUserNamespace(null));

  it(
    'A book saved under user-A is not visible to user-B, ' +
      "and A's data is fully preserved when switching back",
    async () => {
      const BOOK_A = makeBook({ hash: '9cbb1234', title: 'JourneyToWest', uploadedAt: 1_000 });
      const CONFIG_A: BookConfig = {
        updatedAt: 2_000,
        location: 'epubcfi(/2/4)',
        progress: [42, 100],
        booknotes: [
          {
            id: 'n1',
            type: 'bookmark',
            cfi: 'epubcfi(/2/4)',
            note: 'My note',
            createdAt: 1_000,
            updatedAt: 2_000,
          },
        ],
      };

      const [booksForB, booksForA, configForA] = await run(
        Effect.gen(function* () {
          // Step 1: Save A's library and config
          setCurrentUserNamespace('user-A');
          yield* saveLibraryBooks([BOOK_A]);
          // Write config.json for the book under A's namespace
          yield* safeSaveJsonE(getConfigStoragePath(BOOK_A), 'Books', CONFIG_A);

          // Step 2: Switch to B -- should see nothing
          setCurrentUserNamespace('user-B');
          const forB = yield* loadLibraryBooks();

          // Step 3: Switch back to A -- should have book + config intact
          setCurrentUserNamespace('user-A');
          const forA = yield* loadLibraryBooks();

          // Also reload the config from the file to confirm it was persisted
          const fs = yield* FileSystem;
          const rawConfig = yield* fs
            .readFile(getConfigStoragePath(BOOK_A), 'Books', 'text')
            .pipe(Effect.orElseSucceed(() => '{}'));
          const parsedConfig = JSON.parse(rawConfig as string) as BookConfig;

          return [forB, forA, parsedConfig] as const;
        }),
      );

      // B sees nothing of A's data
      expect(booksForB, 'user-B should see empty library').toEqual([]);

      // A's book is intact
      expect(booksForA, 'user-A should see one book').toHaveLength(1);
      expect(booksForA[0]?.hash, 'hash must be preserved').toBe('9cbb1234');
      expect(booksForA[0]?.title, 'title must be preserved').toBe('JourneyToWest');
      expect(booksForA[0]?.uploadedAt, 'uploadedAt must be non-null').not.toBeNull();

      // A's reading progress is intact
      expect(configForA.location, 'reading location preserved').toBe('epubcfi(/2/4)');
      expect(configForA.progress, 'reading progress preserved').toEqual([42, 100]);
      expect(configForA.booknotes, 'booknotes preserved').toHaveLength(1);
      expect(configForA.booknotes?.[0]?.note, 'note text preserved').toBe('My note');
    },
  );
});

// ---------------------------------------------------------------------------
// Group 2: Push owner-guard (Tasks 4 + 6)
// ---------------------------------------------------------------------------

describe('Group 2 - Push owner-guard (no cross-account push)', () => {
  beforeEach(() => {
    setCurrentUserNamespace(null);
    useLibraryStore.setState({
      library: [],
      libraryLoaded: false,
      isSyncing: false,
      syncProgress: 0,
      currentBookshelf: [],
      selectedBooks: new Set(),
      groups: {},
      hashIndex: new Map(),
      visibleLibrary: [],
      loadedNamespace: null,
    });
    useBookDataStore.setState({ booksData: {} });
  });

  afterEach(() => setCurrentUserNamespace(null));

  it(
    'loadedNamespace !== getCurrentUserNamespace() is true mid-switch, ' +
      "preventing A's cached library from being pushed as B",
    () => {
      const BOOK_A = makeBook({ hash: '9cbb1234', title: 'JourneyToWest', uploadedAt: 1_000 });

      // Simulate: library was loaded as user-A
      setCurrentUserNamespace('user-A');
      useLibraryStore.getState().setLibrary([BOOK_A]);

      const stateBefore = useLibraryStore.getState();
      expect(stateBefore.loadedNamespace, 'loadedNamespace stamped as user-A').toBe('user-A');
      expect(stateBefore.library).toHaveLength(1);

      // Now account-switch to B WITHOUT reloading the library (the dangerous window)
      setCurrentUserNamespace('user-B');

      // The guard condition used by useBooksSync must fire:
      // hook bails out of push when loadedNamespace !== getCurrentUserNamespace()
      const stateAfterSwitch = useLibraryStore.getState();
      // The library is still stamped with A's namespace (setLibrary recorded it);
      // asserting the concrete value (not just "!== current") keeps this test from
      // passing tautologically if Task 4 were reverted and loadedNamespace stayed null.
      expect(
        stateAfterSwitch.loadedNamespace,
        'library remains stamped as user-A after the namespace pointer flips to B',
      ).toBe('user-A');
      const guardFires = stateAfterSwitch.loadedNamespace !== getCurrentUserNamespace();
      expect(
        guardFires,
        "guard condition must be true: A's library is loaded but current namespace is B",
      ).toBe(true);

      // Guard blocks the push -- A's books must still be in the store (not yet reset)
      // but the hook would early-return before ever sending them under B's identity.
      expect(stateAfterSwitch.library, "A's books are still resident (not yet reset)").toHaveLength(
        1,
      );
    },
  );

  it("resetForUserSwitch() wipes the store so A's books cannot leak into B's session", () => {
    const BOOK_A = makeBook({ hash: '9cbb1234', title: 'JourneyToWest', uploadedAt: 1_000 });

    setCurrentUserNamespace('user-A');
    useLibraryStore.getState().setLibrary([BOOK_A]);

    // Simulate the auth-switch reset path (Task 6)
    setCurrentUserNamespace('user-B');
    useLibraryStore.getState().resetForUserSwitch();

    const state = useLibraryStore.getState();
    expect(state.library, 'library cleared').toEqual([]);
    expect(state.libraryLoaded, 'libraryLoaded reset').toBe(false);
    expect(state.loadedNamespace, 'loadedNamespace nulled').toBeNull();
    expect(state.visibleLibrary, 'visibleLibrary cleared').toEqual([]);
    expect(state.currentBookshelf, 'currentBookshelf cleared').toEqual([]);
    expect(state.selectedBooks.size, 'selectedBooks cleared').toBe(0);
    expect(Object.keys(state.groups), 'groups cleared').toHaveLength(0);
    expect(state.hashIndex.size, 'hashIndex cleared').toBe(0);
  });

  it("clearAll() on bookDataStore removes A's in-memory configs after account switch", () => {
    // Seed some in-memory book data (simulates A's open-book state)
    useBookDataStore.setState({
      booksData: {
        '9cbb1234': {
          id: '9cbb1234',
          book: makeBook({ hash: '9cbb1234', title: 'JourneyToWest', uploadedAt: 1_000 }),
          file: null,
          config: { updatedAt: 1_000, location: 'epubcfi(/2/4)' },
          bookDoc: null,
          isFixedLayout: false,
        },
      },
    });

    expect(
      useBookDataStore.getState().getBookData('9cbb1234'),
      'data present before reset',
    ).not.toBeNull();

    useBookDataStore.getState().clearAll();

    expect(
      useBookDataStore.getState().getBookData('9cbb1234'),
      'data gone after clearAll',
    ).toBeNull();
    expect(useBookDataStore.getState().booksData, 'booksData is empty object').toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Group 3: Server pull scoping (Task 1)
// ---------------------------------------------------------------------------
// Re-uses the hermetic fake-tx approach from sync-user-scope.test.ts to confirm
// that handleGet ANDs eq(table.userId, ctx.user.id) into every WHERE clause.
// This ensures user B's pull request cannot return user A's database rows.
// ---------------------------------------------------------------------------

/** Walk a Drizzle SQL node's queryChunks to a flat string for assertions. */
function conditionToString(cond: SQL | undefined): string {
  if (!cond) return '';
  const parts: string[] = [];
  for (const chunk of cond.queryChunks) {
    if (typeof chunk === 'string') {
      parts.push(chunk);
    } else if (chunk !== null && typeof chunk === 'object') {
      const c = chunk as Record<string, unknown>;
      if ('value' in c) {
        parts.push(String(c['value']));
      } else if ('name' in c) {
        parts.push(String(c['name']));
      } else if ('queryChunks' in c) {
        parts.push(conditionToString(c as unknown as SQL));
      }
    }
  }
  return parts.join('');
}

function makeFakeTx(capturedWheres: Array<{ tableName: string; cond: SQL | undefined }>): DbTx {
  const makeChain = (tableName: string) => ({
    where(cond: SQL | undefined) {
      capturedWheres.push({ tableName, cond });
      return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
    },
  });

  const fakeTx = {
    select: () => ({
      from: (table: PgTable) => makeChain(getTableName(table)),
    }),
    execute: async () => [],
  };
  return fakeTx as unknown as DbTx;
}

function makeCtx(
  userId: string,
  captured: Array<{ tableName: string; cond: SQL | undefined }>,
): SyncHandlerContext {
  return { user: { id: userId }, tx: makeFakeTx(captured) };
}

const TABLE_BY_NAME: Record<string, typeof books | typeof bookConfigs | typeof bookNotes> = {
  [getTableName(books)]: books,
  [getTableName(bookConfigs)]: bookConfigs,
  [getTableName(bookNotes)]: bookNotes,
};

describe('Group 3 - Server pull scoping (handleGet WHERE includes userId)', () => {
  it(
    'handleGet as user-B produces WHERE containing eq(table.userId, user-B) ' +
      "-- user-A's rows are excluded",
    async () => {
      const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

      const capturedForB: Array<{ tableName: string; cond: SQL | undefined }> = [];
      const ctxB = makeCtx(USER_B, capturedForB);
      const req = new Request('http://localhost/api/sync?since=0');
      await handleGet(req, ctxB);

      // handleGet should query all three tables
      expect(capturedForB, 'all three tables queried').toHaveLength(3);

      for (const { tableName, cond } of capturedForB) {
        const table = TABLE_BY_NAME[tableName];
        expect(table, `unknown table: "${tableName}"`).toBeDefined();

        const condStr = conditionToString(cond);
        const ownerStr = conditionToString(eq(table!.userId, USER_B));

        expect(condStr, `${tableName}: WHERE must include eq(userId, USER_B)`).toContain(ownerStr);

        expect(condStr, `${tableName}: WHERE must contain the value user-B`).toContain(USER_B);

        // Regression: must NOT accidentally embed user-A's id
        expect(condStr, `${tableName}: WHERE must not contain user-A's id`).not.toContain(USER_A);
      }
    },
  );
});
