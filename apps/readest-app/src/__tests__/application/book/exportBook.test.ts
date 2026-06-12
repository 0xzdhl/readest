import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect, Layer, ManagedRuntime, Option } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { Dialog, type DialogShape } from '@/application/ports/Dialog';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PlatformError } from '@/application/errors/AppError';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import type { Book } from '@/domain/book';

// The usecase loads the book file via BookData.loadBookContent; stub it so we
// exercise the resolveFilePath/copyFile/saveFile wiring, not real doc loading.
vi.mock('@/application/services/book/bookData', () => ({
  loadBookContent: vi.fn(() =>
    Effect.succeed({
      book: {} as Book,
      file: new File([new Uint8Array(8)], 'b.epub', { type: 'application/epub+zip' }),
    }),
  ),
}));

import { exportBook } from '@/application/usecases/book/exportBook';

const book = { hash: 'h1', format: 'EPUB', title: 'T' } as unknown as Book;

const FsStub = Layer.succeed(FileSystem, {
  copyFile: () => Effect.void,
} as unknown as FileSystemShape);

const makeRuntime = (dialog: Layer.Layer<Dialog>) => {
  const Ports = Layer.mergeAll(FsStub, Layer.provideMerge(TestPathResolverLive, PathStateLive));
  return ManagedRuntime.make(Layer.merge(Ports, dialog));
};

const dialogWith = (saveFile: DialogShape['saveFile']): Layer.Layer<Dialog> =>
  Layer.succeed(Dialog, {
    ask: () => Effect.succeed(true),
    selectDirectory: () => Effect.succeed(Option.none()),
    selectFiles: () => Effect.succeed([]),
    saveFile,
  } satisfies DialogShape);

describe('exportBook usecase', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when the dialog saved (Option.some)', async () => {
    const rt = makeRuntime(dialogWith(() => Effect.succeed(Option.some('/saved/out.epub'))));
    expect(await rt.runPromise(exportBook(book))).toBe(true);
  });

  it('returns false when the dialog was cancelled (Option.none)', async () => {
    const rt = makeRuntime(dialogWith(() => Effect.succeed(Option.none())));
    expect(await rt.runPromise(exportBook(book))).toBe(false);
  });

  it('rejects when the dialog saveFile fails with a PlatformError', async () => {
    const rt = makeRuntime(
      dialogWith(() =>
        Effect.fail(new PlatformError({ operation: 'saveFile', cause: new Error('disk full') })),
      ),
    );
    await expect(rt.runPromise(exportBook(book))).rejects.toThrow();
  });
});
