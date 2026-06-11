import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import {
  BookRepository,
  type BookRepositoryShape,
} from '@/application/repositories/BookRepository';
import {
  LibraryRepository,
  type LibraryRepositoryShape,
} from '@/application/repositories/LibraryRepository';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import type { Book } from '@/domain/book';

const mkBook = (hash: string): Book => ({ hash, format: 'EPUB', title: hash }) as unknown as Book;

// Mock bookService.importBook to exercise the usecase's loop/persist/callbacks
// without real document parsing. Keep buildBookLookupIndex real.
vi.mock('@/services/bookService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bookService')>();
  return {
    ...actual,
    importBook: vi.fn(
      async (
        _fs: unknown,
        file: string | File,
        books: Book[],
        opts: {
          generateCoverImageUrl: (b: Book) => Promise<string>;
          saveBookConfig: (b: Book, c: unknown) => Promise<void>;
        },
      ) => {
        const name = typeof file === 'string' ? file : file.name;
        if (name === 'fail') throw new Error('boom');
        const b = mkBook(name);
        await opts.saveBookConfig(b, {});
        b.coverImageUrl = await opts.generateCoverImageUrl(b);
        books.push(b);
        return b;
      },
    ),
  };
});

import { importBooks } from '@/application/usecases/book/importBooks';

const saved: Book[][] = [];
const savedConfigs: string[] = [];

const makeRuntime = () => {
  saved.length = 0;
  savedConfigs.length = 0;
  const BookRepoStub = Layer.succeed(BookRepository, {
    loadContent: () => Effect.die('unused'),
    loadConfig: () => Effect.die('unused'),
    saveConfig: (b: Book) => Effect.sync(() => void savedConfigs.push(b.hash)),
    loadNav: () => Effect.die('unused'),
    saveNav: () => Effect.die('unused'),
    getFileSize: () => Effect.die('unused'),
    isAvailable: () => Effect.die('unused'),
    refreshMetadata: () => Effect.die('unused'),
  } as unknown as BookRepositoryShape);
  const CoverStub = Layer.succeed(CoverService, {
    getCoverImageUrl: () => 'cover://x',
    getCoverImageBlobUrl: () => Effect.succeed('cover://x'),
    getCachedImageUrl: () => Effect.succeed('cover://x'),
    generateCoverImageUrl: (b: Book) => Effect.succeed(`cover://${b.hash}`),
    updateCoverImage: () => Effect.void,
  } as unknown as CoverServiceShape);
  const LibraryStub = Layer.succeed(LibraryRepository, {
    load: Effect.succeed([] as Book[]),
    save: (books: readonly Book[]) => Effect.sync(() => void saved.push([...books])),
  } satisfies LibraryRepositoryShape);
  const Ports = Layer.mergeAll(
    TestFileSystemLive,
    Layer.provideMerge(TestPathResolverLive, PathStateLive),
  );
  return ManagedRuntime.make(Layer.mergeAll(Ports, BookRepoStub, CoverStub, LibraryStub));
};

describe('importBooks usecase', () => {
  beforeEach(() => vi.clearAllMocks());

  it('imports all inputs, wires saveConfig + cover, and persists once by default', async () => {
    const rt = makeRuntime();
    const books: Book[] = [];
    const res = await rt.runPromise(importBooks(books, [{ file: 'a' }, { file: 'b' }]));
    expect(res.imported.map((b) => b.hash)).toEqual(['a', 'b']);
    expect(res.imported[0]!.coverImageUrl).toBe('cover://a');
    expect(savedConfigs).toEqual(['a', 'b']);
    expect(res.failed).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.map((b) => b.hash)).toEqual(['a', 'b']);
  });

  it('records failures without aborting the batch', async () => {
    const rt = makeRuntime();
    const res = await rt.runPromise(importBooks([], [{ file: 'a' }, { file: 'fail' }]));
    expect(res.imported.map((b) => b.hash)).toEqual(['a']);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.filename).toBe('fail');
    expect(res.failed[0]!.error).toBeInstanceOf(Error);
    expect((res.failed[0]!.error as Error).message).toBe('boom');
  });

  it('skips persistence when persist:false', async () => {
    const rt = makeRuntime();
    const res = await rt.runPromise(importBooks([], [{ file: 'a' }], { persist: false }));
    expect(res.imported).toHaveLength(1);
    expect(saved).toHaveLength(0);
  });

  it('does not persist when nothing imported', async () => {
    const rt = makeRuntime();
    const res = await rt.runPromise(importBooks([], [{ file: 'fail' }]));
    expect(res.imported).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('fires onImported per file and onBatch per batch', async () => {
    const rt = makeRuntime();
    const importedCb: string[] = [];
    const batches: number[] = [];
    await rt.runPromise(
      importBooks([], [{ file: 'a' }, { file: 'b' }], {
        concurrency: 1,
        onImported: (b) => void importedCb.push(b.hash),
        onBatch: (bs) => void batches.push(bs.length),
      }),
    );
    expect(importedCb).toEqual(['a', 'b']);
    expect(batches).toEqual([1, 1]);
  });
});
