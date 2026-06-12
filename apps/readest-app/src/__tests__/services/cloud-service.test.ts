import { Effect, Layer } from 'effect';
import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { deleteBook } from '@/application/services/cloud/cloudTransfers';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import type { Book, BookFormat } from '@/domain/book';
import type { DeleteAction } from '@/domain/system';

vi.mock('@/utils/book', () => ({
  getDir: vi.fn((book: Book) => book.hash),
  getLocalBookFilename: vi.fn((book: Book) => `${book.hash}/${book.title}.epub`),
  getRemoteBookFilename: vi.fn((book: Book) => `${book.hash}/${book.hash}.epub`),
  getCoverFilename: vi.fn((book: Book) => `${book.hash}/cover.png`),
}));

vi.mock('@/libs/storage', () => ({
  downloadFile: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn().mockResolvedValue('https://example.com/file'),
  uploadReplicaFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn(),
  createProgressHandler: vi.fn().mockReturnValue(vi.fn()),
  batchGetDownloadUrls: vi.fn().mockResolvedValue([]),
}));
import * as storage from '@/libs/storage';

function createMockBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'abc123',
    format: 'EPUB' as BookFormat,
    title: 'Test Book',
    author: 'Author',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    uploadedAt: null,
    downloadedAt: Date.now(),
    coverDownloadedAt: Date.now(),
    ...overrides,
  };
}

const makeFs = (over: Partial<FileSystemShape> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    exists: () => Effect.succeed(true),
    removeFile: () => Effect.void,
    ...over,
  } as unknown as FileSystemShape);

const runDelete = (book: Book, action: DeleteAction, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(
    deleteBook(book, action).pipe(Effect.provide(fs)) as Effect.Effect<void, unknown, never>,
  );

describe('cloudService.deleteBook (Effect-native, over stub FileSystem)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('local delete action', () => {
    test('removes the local book file', async () => {
      const book = createMockBook();
      const exists = vi.fn(() => Effect.succeed(true));
      const removeFile = vi.fn(() => Effect.void);
      await runDelete(book, 'local', makeFs({ exists, removeFile }));

      expect(exists).toHaveBeenCalledWith(`${book.hash}/${book.title}.epub`, 'Books');
      expect(removeFile).toHaveBeenCalledWith(`${book.hash}/${book.title}.epub`, 'Books');
    });

    test('sets downloadedAt to null', async () => {
      const book = createMockBook({ downloadedAt: 12345 });
      await runDelete(book, 'local', makeFs());
      expect(book.downloadedAt).toBeNull();
    });

    test('does not set deletedAt for local-only delete', async () => {
      const book = createMockBook({ deletedAt: null });
      await runDelete(book, 'local', makeFs());
      expect(book.deletedAt).toBeNull();
    });

    test('skips removal when file does not exist', async () => {
      const removeFile = vi.fn(() => Effect.void);
      const book = createMockBook();
      await runDelete(book, 'local', makeFs({ exists: () => Effect.succeed(false), removeFile }));
      expect(removeFile).not.toHaveBeenCalled();
    });

    test('only deletes book file, not cover (local action)', async () => {
      const book = createMockBook();
      const removeFile = vi.fn(() => Effect.void);
      await runDelete(book, 'local', makeFs({ removeFile }));
      expect(removeFile).toHaveBeenCalledTimes(1);
      expect(removeFile).toHaveBeenCalledWith(`${book.hash}/${book.title}.epub`, 'Books');
    });
  });

  describe('both delete action', () => {
    test('removes book file and cover', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      const removeFile = vi.fn(() => Effect.void);
      await runDelete(book, 'both', makeFs({ removeFile }));
      expect(removeFile).toHaveBeenCalledWith(`${book.hash}/${book.title}.epub`, 'Books');
      expect(removeFile).toHaveBeenCalledWith(`${book.hash}/cover.png`, 'Books');
    });

    test('sets deletedAt, clears downloadedAt and coverDownloadedAt', async () => {
      const book = createMockBook({
        uploadedAt: 1000,
        downloadedAt: 2000,
        coverDownloadedAt: 3000,
      });
      await runDelete(book, 'both', makeFs());
      expect(book.deletedAt).toBeGreaterThan(0);
      expect(book.downloadedAt).toBeNull();
      expect(book.coverDownloadedAt).toBeNull();
    });

    test('clears uploadedAt when uploaded', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      await runDelete(book, 'both', makeFs());
      expect(book.uploadedAt).toBeNull();
    });
  });

  describe('cloud delete action', () => {
    test('does not delete local files', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      const removeFile = vi.fn(() => Effect.void);
      await runDelete(book, 'cloud', makeFs({ removeFile }));
      expect(removeFile).not.toHaveBeenCalled();
    });

    test('clears uploadedAt when previously uploaded', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      await runDelete(book, 'cloud', makeFs());
      expect(book.uploadedAt).toBeNull();
    });

    test('skips cloud delete when not uploaded', async () => {
      const book = createMockBook({ uploadedAt: null });
      await runDelete(book, 'cloud', makeFs());
      expect(storage.deleteFile).not.toHaveBeenCalled();
    });

    test('calls deleteFile for remote book and cover', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      await runDelete(book, 'cloud', makeFs());
      expect(storage.deleteFile).toHaveBeenCalledTimes(2);
    });

    test('does not throw when cloud delete fails', async () => {
      (storage.deleteFile as unknown as Mock).mockImplementation(() => {
        throw new Error('network error');
      });
      const book = createMockBook({ uploadedAt: 1000 });
      await runDelete(book, 'cloud', makeFs());
      expect(book.uploadedAt).toBeNull();
    });
  });
});
