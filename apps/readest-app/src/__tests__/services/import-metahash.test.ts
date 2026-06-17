import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Book, BookLookupIndex } from '@/domain/book';
import { getMetadataHash } from '@/utils/book';
import { setCurrentUserNamespace } from '@/services/userNamespace';

const mockOpen = vi.hoisted(() => vi.fn());
const mockPartialMD5 = vi.hoisted(() => vi.fn());

vi.mock('@/utils/md5', async () => {
  const actual = await vi.importActual<typeof import('@/utils/md5')>('@/utils/md5');
  return { ...actual, partialMd5: mockPartialMD5 };
});

vi.mock('@/libs/document', async () => {
  const actual = await vi.importActual<typeof import('@/libs/document')>('@/libs/document');
  class MockDocumentLoader {
    open() {
      return mockOpen();
    }
  }
  return { ...actual, DocumentLoader: MockDocumentLoader };
});

vi.mock('@/utils/txt', () => ({ TxtToEpubConverter: vi.fn() }));
vi.mock('@/utils/svg', () => ({ svg2png: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/libs/storage', () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  createProgressHandler: vi.fn(),
  batchGetDownloadUrls: vi.fn(),
}));

import { Effect, Layer } from 'effect';
import { FileSystem as FileSystemPort, type FileSystemShape } from '@/application/ports/FileSystem';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import { BookRepositoryLive } from '@/infra/shared/BookRepository.layer';
import {
  buildBookLookupIndex,
  importBook as importBookEffect,
} from '@/application/services/book/bookImport';

// Build the mocked FileSystem that importBook operates against. importBook is a
// pure function taking the fs as its first argument, so we construct it directly
// instead of routing through a god-object.
type MockFs = Record<string, ReturnType<typeof vi.fn>>;

function makeMockFs(): MockFs {
  return {
    openFile: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    copyFile: vi.fn(),
    removeFile: vi.fn(),
    readDir: vi.fn(),
    createDir: vi.fn(),
    removeDir: vi.fn(),
    exists: vi.fn(),
    stats: vi.fn(),
    resolvePath: vi.fn(),
    getURL: vi.fn(),
    getBlobURL: vi.fn().mockResolvedValue(''),
    getImageURL: vi.fn(),
    getPrefix: vi.fn(),
  } as unknown as MockFs;
}

// Wrap the legacy-shape Promise mockFs into an Effect FileSystem layer so the
// existing vi.fn assertions (mockResolvedValue / mockImplementation / .mock.calls)
// all keep working unchanged. Each port method calls the matching mockFs method.
const fsLayerFromMock = (mockFs: MockFs): Layer.Layer<FileSystemPort> => {
  // vi.fn()'s ReturnType is typed as a constructable/procedure union that tsgo
  // treats as not-callable; view the mock as plain callables for invocation.
  const m = mockFs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return Layer.succeed(FileSystemPort, {
    openFile: (p: string, b: string, f?: string) => Effect.tryPromise(() => m.openFile(p, b, f)),
    readFile: (p: string, b: string, mode: string) =>
      Effect.tryPromise(() => m.readFile(p, b, mode)),
    writeFile: (p: string, b: string, c: unknown) => Effect.tryPromise(() => m.writeFile(p, b, c)),
    copyFile: (s: string, sb: string, d: string, db: string) =>
      Effect.tryPromise(() => m.copyFile(s, sb, d, db)),
    removeFile: (p: string, b: string) => Effect.tryPromise(() => m.removeFile(p, b)),
    createDir: (p: string, b: string, r?: boolean) => Effect.tryPromise(() => m.createDir(p, b, r)),
    removeDir: (p: string, b: string, r?: boolean) => Effect.tryPromise(() => m.removeDir(p, b, r)),
    readDir: (p: string, b: string) => Effect.tryPromise(() => m.readDir(p, b)),
    exists: (p: string, b: string) => Effect.tryPromise(() => m.exists(p, b)),
    stat: (p: string, b: string) => Effect.tryPromise(() => m.stats(p, b)),
    getUrl: (p: string) => Effect.sync(() => m.getURL(p)),
    getBlobUrl: (p: string, b: string) => Effect.tryPromise(() => m.getBlobURL(p, b)),
  } as unknown as FileSystemShape);
};

const CoverStub = Layer.succeed(CoverService, {
  getCoverImageUrl: () => '',
  getCoverImageBlobUrl: () => Effect.succeed(''),
  getCachedImageUrl: () => Effect.succeed(''),
  generateCoverImageUrl: () => Effect.succeed(''),
  updateCoverImage: () => Effect.void,
} as unknown as CoverServiceShape);

// Drive the Effect-native importBook through the adapter layer. saveConfig is the
// REAL BookRepository.saveConfig over the same FileSystem (writes config via
// mockFs.writeFile), faithful to the legacy injected saveBookConfig.
function importBook(
  fs: MockFs,
  file: string | File,
  books: Book[],
  options: {
    transient?: boolean;
    saveBook?: boolean;
    saveCover?: boolean;
    overwrite?: boolean;
    lookupIndex?: BookLookupIndex;
  } = {},
): Promise<Book | null> {
  const FsLayer = fsLayerFromMock(fs);
  const layers = Layer.mergeAll(FsLayer, CoverStub, Layer.provide(BookRepositoryLive, FsLayer));
  return Effect.runPromise(
    importBookEffect(file, books, options).pipe(Effect.provide(layers)) as Effect.Effect<
      Book | null,
      unknown,
      never
    >,
  );
}

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'old-hash-123',
    format: 'EPUB' as Book['format'],
    title: 'Test Book',
    sourceTitle: 'Test Book',
    author: 'Test Author',
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    downloadedAt: Date.now() - 10000,
    deletedAt: null,
    ...overrides,
  };
}

const TEST_METADATA = {
  title: 'Test Book',
  author: 'Test Author',
  language: 'en',
  identifier: 'isbn-123',
};

function setupMockBookDoc(metadata: Record<string, unknown> = TEST_METADATA) {
  const bookDoc = {
    metadata,
    getCover: vi.fn().mockResolvedValue(null),
  };
  mockOpen.mockResolvedValue({ book: bookDoc, format: 'EPUB' });
}

describe('importBook metaHash deduplication', () => {
  let fs: MockFs;

  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentUserNamespace(null); // pin to 'local' for deterministic paths
    fs = makeMockFs();
    fs.exists.mockResolvedValue(false);
    fs.createDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.removeDir.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue('{}');
  });

  it('should detect metaHash match and override existing book with new hash', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const existingBook = makeBook({ hash: 'old-hash-123', metaHash });
    const books: Book[] = [existingBook];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc();

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await importBook(fs, mockFile, books);

    // Should return the existing book, not a new one
    expect(result).toBe(existingBook);
    // Library should still have only one book
    expect(books.length).toBe(1);
    // Hash should be updated to new file's content hash
    expect(existingBook.hash).toBe('new-hash-456');
    // Metadata should be overridden
    expect(existingBook.metadata).toEqual(TEST_METADATA);
    // metaHash should be set
    expect(existingBook.metaHash).toBe(metaHash);
  });

  it('should not match metaHash for deleted books', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const deletedBook = makeBook({
      hash: 'old-hash-123',
      metaHash,
      deletedAt: Date.now(),
    });
    const books: Book[] = [deletedBook];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc();

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await importBook(fs, mockFile, books);

    // Should create a new book since the existing one is deleted
    expect(result).not.toBe(deletedBook);
    expect(books.length).toBe(2);
  });

  it('should migrate config to new directory with updated bookHash and metaHash', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);
    const existingBook = makeBook({ hash: 'old-hash-123', metaHash });
    const books: Book[] = [existingBook];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc();

    fs.exists.mockImplementation(async (path: string) => {
      // namespaced candidate-scan path returns false → falls through to legacy fallback
      if (path === 'users/local/old-hash-123/config.json') return false;
      if (path === 'old-hash-123/config.json') return true;
      if (path === 'old-hash-123') return true;
      return false;
    });
    fs.readFile.mockResolvedValue('{"readProgress":0.5}');

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    await importBook(fs, mockFile, books);

    // Should have read config from old (canonical) directory via legacy fallback
    expect(fs.readFile).toHaveBeenCalledWith('old-hash-123/config.json', 'Books', 'text');
    // Should have written config to namespaced new directory with updated bookHash and metaHash
    const writeCalls = fs.writeFile.mock.calls;
    const configWrite = writeCalls.find(
      (c: unknown[]) => c[0] === 'users/local/new-hash-456/config.json',
    );
    expect(configWrite).toBeDefined();
    const writtenConfig = JSON.parse(configWrite![2] as string);
    expect(writtenConfig.bookHash).toBe('new-hash-456');
    expect(writtenConfig.metaHash).toBe(metaHash);
    expect(writtenConfig.readProgress).toBe(0.5);
    // Should have removed old directory
    expect(fs.removeDir).toHaveBeenCalledWith('old-hash-123', 'Books', true);
  });

  it('should prefer exact file hash match over metaHash match', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const exactMatchBook = makeBook({ hash: 'same-hash', metaHash });
    const metaMatchBook = makeBook({ hash: 'different-hash', metaHash });
    const books: Book[] = [exactMatchBook, metaMatchBook];

    mockPartialMD5.mockResolvedValue('same-hash');
    setupMockBookDoc();

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await importBook(fs, mockFile, books);

    // Should return the exact hash match, not the metaHash match
    expect(result).toBe(exactMatchBook);
    // metaHash duplicate should be soft-deleted during aggregation
    expect(metaMatchBook.deletedAt).toBeTruthy();
    expect(exactMatchBook.deletedAt).toBeNull();
  });

  it('should not check metaHash for transient imports', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);
    const existingBook = makeBook({ hash: 'old-hash', metaHash });
    const books: Book[] = [existingBook];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();

    fs.openFile.mockResolvedValue(new File(['content'], 'test.epub'));

    // Transient import requires string file path
    const result = await importBook(fs, '/path/to/test.epub', books, { transient: true });

    // Should create a new entry, not override existing
    expect(result).not.toBe(existingBook);
  });

  it('should promote extracted ISBN into metadata.isbn during import', async () => {
    const books: Book[] = [];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc({
      ...TEST_METADATA,
      identifier: 'calibre:abc123',
      altIdentifier: ['urn:isbn:9780316033664', 'mobi-asin:B004J4XGN6'],
    });

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await importBook(fs, mockFile, books);
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('Expected importBook to return an imported book');
    }

    expect(result.metadata?.isbn).toBe('9780316033664');
  });
});

describe('importBook metaHash aggregation', () => {
  let fs: MockFs;

  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentUserNamespace(null); // pin to 'local' for deterministic paths
    fs = makeMockFs();
    fs.exists.mockResolvedValue(false);
    fs.createDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.removeDir.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue('{}');
  });

  it('should remove all duplicates with same metaHash and format', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const book1 = makeBook({ hash: 'hash-1', metaHash });
    const book2 = makeBook({ hash: 'hash-2', metaHash });
    const book3 = makeBook({ hash: 'hash-3', metaHash });
    const unrelated = makeBook({ hash: 'other', metaHash: 'different' });
    const books: Book[] = [book1, book2, book3, unrelated];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await importBook(fs, mockFile, books);

    // Duplicates should be soft-deleted, survivor updated, unrelated untouched
    const active = books.filter((b) => b.metaHash === metaHash && !b.deletedAt);
    expect(active).toHaveLength(1);
    expect(active[0]!.hash).toBe('new-hash');
    expect(book2.deletedAt).toBeTruthy();
    expect(book3.deletedAt).toBeTruthy();
    expect(unrelated.deletedAt).toBeNull();
  });

  it('should select base config with largest progress pagenum', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const book1 = makeBook({ hash: 'hash-1', metaHash });
    const book2 = makeBook({ hash: 'hash-2', metaHash });
    const book3 = makeBook({ hash: 'hash-3', metaHash });
    const books: Book[] = [book1, book2, book3];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();

    fs.exists.mockImplementation(async (path: string) => {
      if (path === 'users/local/hash-1/config.json') return true;
      if (path === 'users/local/hash-2/config.json') return true;
      if (path === 'users/local/hash-3/config.json') return true;
      if (['hash-1', 'hash-2', 'hash-3'].includes(path)) return true;
      return false;
    });
    fs.readFile.mockImplementation(async (path: string) => {
      if (path === 'users/local/hash-1/config.json')
        return JSON.stringify({ updatedAt: 3000, progress: [10, 200], location: 'loc1' });
      if (path === 'users/local/hash-2/config.json')
        return JSON.stringify({ updatedAt: 1000, progress: [50, 200], location: 'loc2' });
      if (path === 'users/local/hash-3/config.json')
        return JSON.stringify({ updatedAt: 2000, progress: [30, 200], location: 'loc3' });
      return '{}';
    });

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await importBook(fs, mockFile, books);

    const writeCalls = fs.writeFile.mock.calls;
    const configWrite = writeCalls.find(
      (c: unknown[]) => (c[0] as string) === 'users/local/new-hash/config.json',
    );
    expect(configWrite).toBeDefined();
    const writtenConfig = JSON.parse(configWrite![2] as string);
    // Base config should be from hash-2 (largest progress page 50)
    expect(writtenConfig.location).toBe('loc2');
    expect(writtenConfig.progress).toEqual([50, 200]);
  });

  it('should merge booknotes with unique id from all configs', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const book1 = makeBook({ hash: 'hash-1', metaHash });
    const book2 = makeBook({ hash: 'hash-2', metaHash });
    const books: Book[] = [book1, book2];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();

    fs.exists.mockImplementation(async (path: string) => {
      if (path === 'users/local/hash-1/config.json') return true;
      if (path === 'users/local/hash-2/config.json') return true;
      if (['hash-1', 'hash-2'].includes(path)) return true;
      return false;
    });
    fs.readFile.mockImplementation(async (path: string) => {
      if (path === 'users/local/hash-1/config.json')
        return JSON.stringify({
          updatedAt: 1000,
          progress: [80, 200],
          booknotes: [
            {
              id: 'note-a',
              type: 'annotation',
              cfi: 'cfi-a',
              note: 'A',
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'note-shared',
              type: 'annotation',
              cfi: 'cfi-s',
              note: 'old',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        });
      if (path === 'users/local/hash-2/config.json')
        return JSON.stringify({
          updatedAt: 2000,
          progress: [20, 200],
          booknotes: [
            { id: 'note-b', type: 'bookmark', cfi: 'cfi-b', note: 'B', createdAt: 2, updatedAt: 2 },
            {
              id: 'note-shared',
              type: 'annotation',
              cfi: 'cfi-s',
              note: 'newer',
              createdAt: 1,
              updatedAt: 5,
            },
          ],
        });
      return '{}';
    });

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await importBook(fs, mockFile, books);

    const writeCalls = fs.writeFile.mock.calls;
    const configWrite = writeCalls.find(
      (c: unknown[]) => (c[0] as string) === 'users/local/new-hash/config.json',
    );
    expect(configWrite).toBeDefined();
    const writtenConfig = JSON.parse(configWrite![2] as string);
    // Base should be hash-1 (progress page 80 > 20)
    expect(writtenConfig.progress).toEqual([80, 200]);
    // Booknotes should be merged: note-a, note-b, and note-shared (latest updatedAt wins)
    const notes = writtenConfig.booknotes as Array<{ id: string; note: string; updatedAt: number }>;
    expect(notes).toHaveLength(3);
    expect(notes.find((n) => n.id === 'note-a')).toBeDefined();
    expect(notes.find((n) => n.id === 'note-b')).toBeDefined();
    const shared = notes.find((n) => n.id === 'note-shared');
    expect(shared!.note).toBe('newer');
    expect(shared!.updatedAt).toBe(5);
  });

  it('should handle configs with missing progress when merging', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const book1 = makeBook({ hash: 'hash-1', metaHash });
    const book2 = makeBook({ hash: 'hash-2', metaHash });
    const books: Book[] = [book1, book2];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();

    fs.exists.mockImplementation(async (path: string) => {
      if (path === 'users/local/hash-1/config.json') return true;
      if (path === 'users/local/hash-2/config.json') return true;
      if (['hash-1', 'hash-2'].includes(path)) return true;
      return false;
    });
    fs.readFile.mockImplementation(async (path: string) => {
      if (path === 'users/local/hash-1/config.json')
        return JSON.stringify({ updatedAt: 1000, location: 'loc1' });
      if (path === 'users/local/hash-2/config.json')
        return JSON.stringify({ updatedAt: 2000, progress: [5, 100], location: 'loc2' });
      return '{}';
    });

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await importBook(fs, mockFile, books);

    const writeCalls = fs.writeFile.mock.calls;
    const configWrite = writeCalls.find(
      (c: unknown[]) => (c[0] as string) === 'users/local/new-hash/config.json',
    );
    expect(configWrite).toBeDefined();
    const writtenConfig = JSON.parse(configWrite![2] as string);
    // hash-2 has progress [5, 100], hash-1 has none (treated as 0) — hash-2 wins
    expect(writtenConfig.progress).toEqual([5, 100]);
    expect(writtenConfig.location).toBe('loc2');
  });

  it('should not aggregate books with different formats', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const epubBook = makeBook({ hash: 'epub-hash', metaHash });
    const pdfBook = makeBook({
      hash: 'pdf-hash',
      metaHash,
      format: 'PDF' as Book['format'],
    });
    const books: Book[] = [epubBook, pdfBook];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc(); // Opens as EPUB

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await importBook(fs, mockFile, books);

    // PDF book should not be soft-deleted (different format)
    expect(pdfBook.deletedAt).toBeNull();
    // EPUB book should survive (promoted as existing, not a duplicate of itself)
    expect(epubBook.deletedAt).toBeNull();
  });

  it('should clean up directories of removed duplicates', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const book1 = makeBook({ hash: 'hash-1', metaHash });
    const book2 = makeBook({ hash: 'hash-2', metaHash });
    const book3 = makeBook({ hash: 'hash-3', metaHash });
    const books: Book[] = [book1, book2, book3];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();

    fs.exists.mockImplementation(async (path: string) => {
      return ['hash-2', 'hash-3'].includes(path);
    });

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await importBook(fs, mockFile, books);

    // Duplicates should be soft-deleted and their directories cleaned up
    expect(book2.deletedAt).toBeTruthy();
    expect(book3.deletedAt).toBeTruthy();
    const removeDirPaths = fs.removeDir.mock.calls.map((c: unknown[]) => c[0]);
    expect(removeDirPaths).toContain('hash-2');
    expect(removeDirPaths).toContain('hash-3');
  });

  it('should remove metaHash duplicates even with exact hash match', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const exactMatch = makeBook({ hash: 'exact-hash', metaHash });
    const dup1 = makeBook({ hash: 'dup-1', metaHash });
    const dup2 = makeBook({ hash: 'dup-2', metaHash });
    const books: Book[] = [exactMatch, dup1, dup2];

    mockPartialMD5.mockResolvedValue('exact-hash');
    setupMockBookDoc();

    fs.exists.mockImplementation(async (path: string) => {
      return ['dup-1', 'dup-2'].includes(path);
    });

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await importBook(fs, mockFile, books);

    expect(result).toBe(exactMatch);
    expect(exactMatch.deletedAt).toBeNull();
    expect(dup1.deletedAt).toBeTruthy();
    expect(dup2.deletedAt).toBeTruthy();
  });

  it('should merge configs on exact hash match with duplicates', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const exactMatch = makeBook({ hash: 'exact-hash', metaHash });
    const dup = makeBook({ hash: 'dup-hash', metaHash });
    const books: Book[] = [exactMatch, dup];

    mockPartialMD5.mockResolvedValue('exact-hash');
    setupMockBookDoc();

    fs.exists.mockImplementation(async (path: string) => {
      if (path === 'users/local/exact-hash/config.json') return true;
      if (path === 'users/local/dup-hash/config.json') return true;
      if (path === 'dup-hash') return true;
      return false;
    });
    fs.readFile.mockImplementation(async (path: string) => {
      if (path === 'users/local/exact-hash/config.json')
        return JSON.stringify({
          updatedAt: 1000,
          progress: [10, 100],
          booknotes: [
            { id: 'n1', type: 'annotation', cfi: 'c1', note: 'x', createdAt: 1, updatedAt: 1 },
          ],
        });
      if (path === 'users/local/dup-hash/config.json')
        return JSON.stringify({
          updatedAt: 5000,
          progress: [70, 100],
          location: 'newer',
          booknotes: [
            { id: 'n2', type: 'bookmark', cfi: 'c2', note: 'y', createdAt: 2, updatedAt: 2 },
          ],
        });
      return '{}';
    });

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await importBook(fs, mockFile, books);

    const writeCalls = fs.writeFile.mock.calls;
    const configWrite = writeCalls.find(
      (c: unknown[]) => (c[0] as string) === 'users/local/exact-hash/config.json',
    );
    expect(configWrite).toBeDefined();
    const writtenConfig = JSON.parse(configWrite![2] as string);
    // Base config from dup (progress page 70 > 10)
    expect(writtenConfig.progress).toEqual([70, 100]);
    expect(writtenConfig.location).toBe('newer');
    expect(writtenConfig.bookHash).toBe('exact-hash');
    // Merged booknotes from both
    expect(writtenConfig.booknotes).toHaveLength(2);
  });
});

describe('importBook with BookLookupIndex', () => {
  let fs: MockFs;

  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentUserNamespace(null); // pin to 'local' for deterministic paths
    fs = makeMockFs();
    fs.exists.mockResolvedValue(false);
    fs.createDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.removeDir.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue('{}');
  });

  it('updates the lookup index after a successful new-book import', async () => {
    const books: Book[] = [];
    const lookupIndex = buildBookLookupIndex(books);

    mockPartialMD5.mockResolvedValue('imported-hash');
    setupMockBookDoc();

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await importBook(fs, mockFile, books, { lookupIndex });

    expect(result).not.toBeNull();
    expect(result?.hash).toBe('imported-hash');
    // The lookup index must contain the freshly imported book
    expect(lookupIndex.byHash.get('imported-hash')).toBe(result);
    if (result?.metaHash) {
      const key = `${result.metaHash}:${result.format}`;
      expect(lookupIndex.byMetaKey.get(key)).toContain(result);
    }
  });

  it('finds existing book via lookup index without scanning books array', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);
    const existingBook = makeBook({ hash: 'existing', metaHash });
    // Pass an EMPTY books array but a lookup index that already contains the book.
    // If the implementation falls back to books.find(), it will fail to find the
    // existing book and create a new one. If it consults the lookup index, it
    // will discover the existing book and update it.
    const books: Book[] = [];
    const lookupIndex = buildBookLookupIndex([existingBook]);

    mockPartialMD5.mockResolvedValue('existing'); // same hash as existing
    setupMockBookDoc();

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await importBook(fs, mockFile, books, { lookupIndex });

    // Should reuse the existing book object via lookup index
    expect(result).toBe(existingBook);
  });
});
