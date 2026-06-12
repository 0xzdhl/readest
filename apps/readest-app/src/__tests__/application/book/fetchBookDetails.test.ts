import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { fetchBookDetails } from '@/application/services/book/bookData';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import type { Book } from '@/domain/book';

vi.mock('@/libs/document', () => ({
  DocumentLoader: class {
    constructor(_file: unknown) {}
    async open() {
      return { book: { metadata: { title: 'Mock Title' } } };
    }
  },
}));

const fileStub = () => new File([new Uint8Array(8)], 'b.epub');

// `present` flips to true once downloadBook "downloads" the file.
const makeFs = (present: { value: boolean }): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    exists: () => Effect.sync(() => present.value),
    openFile: () => Effect.succeed(fileStub()),
  } as unknown as FileSystemShape);

const run = <A>(p: Effect.Effect<A, unknown, FileSystem>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(fs)) as Effect.Effect<A, unknown, never>);

const book = (over: Partial<Book> = {}) =>
  ({ hash: 'h1', format: 'EPUB', title: 'T', ...over }) as unknown as Book;

describe('bookData.fetchBookDetails', () => {
  it('returns metadata without downloading when the file is present', async () => {
    const present = { value: true };
    const downloadBook = vi.fn(() => Effect.void);
    const meta = await run(
      fetchBookDetails(book({ uploadedAt: 123 }), downloadBook),
      makeFs(present),
    );
    expect(meta).toEqual({ title: 'Mock Title' });
    expect(downloadBook).not.toHaveBeenCalled();
  });

  it('downloads when the file is absent and the book was uploaded', async () => {
    const present = { value: false };
    const downloadBook = vi.fn((_b: Book) =>
      Effect.sync(() => {
        present.value = true; // the download writes the file
      }),
    );
    const meta = await run(
      fetchBookDetails(book({ uploadedAt: 123 }), downloadBook),
      makeFs(present),
    );
    expect(downloadBook).toHaveBeenCalledTimes(1);
    expect(meta).toEqual({ title: 'Mock Title' });
  });
});
