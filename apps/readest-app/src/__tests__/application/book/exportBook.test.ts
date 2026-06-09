import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect, Layer, ManagedRuntime, Option } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { Dialog, type DialogShape } from '@/application/ports/Dialog';
import { PlatformError } from '@/application/errors/AppError';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import type { Book } from '@/domain/book';

// Mock bookService.exportBook so we exercise the usecase's callback wiring
// (resolveFilePath/copyFile/saveFile), not real document loading.
vi.mock('@/services/bookService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bookService')>();
  return {
    ...actual,
    exportBook: vi.fn(
      async (
        _fs: unknown,
        _book: Book,
        _resolveFilePath: unknown,
        _copyFile: unknown,
        saveFile: (f: string, c: ArrayBuffer) => Promise<boolean>,
      ) => saveFile('out.epub', new ArrayBuffer(8)),
    ),
  };
});

import { exportBook } from '@/application/usecases/book/exportBook';

const book = { hash: 'h1', format: 'EPUB', title: 'T' } as unknown as Book;

const makeRuntime = (saveResult: Option.Option<string>) => {
  const DialogStub = Layer.succeed(Dialog, {
    ask: () => Effect.succeed(true),
    selectDirectory: () => Effect.succeed(Option.none()),
    selectFiles: () => Effect.succeed([]),
    saveFile: () => Effect.succeed(saveResult),
  } satisfies DialogShape);
  const Ports = Layer.mergeAll(
    TestFileSystemLive,
    Layer.provideMerge(TestPathResolverLive, PathStateLive),
  );
  return ManagedRuntime.make(Layer.merge(Ports, DialogStub));
};

describe('exportBook usecase', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when the dialog saved (Option.some)', async () => {
    const rt = makeRuntime(Option.some('/saved/out.epub'));
    expect(await rt.runPromise(exportBook(book))).toBe(true);
  });

  it('returns false when the dialog was cancelled (Option.none)', async () => {
    const rt = makeRuntime(Option.none());
    expect(await rt.runPromise(exportBook(book))).toBe(false);
  });

  it('rejects when the dialog saveFile fails with a PlatformError', async () => {
    const DialogFailing = Layer.succeed(Dialog, {
      ask: () => Effect.succeed(true),
      selectDirectory: () => Effect.succeed(Option.none()),
      selectFiles: () => Effect.succeed([]),
      saveFile: () =>
        Effect.fail(new PlatformError({ operation: 'saveFile', cause: new Error('disk full') })),
    } satisfies DialogShape);
    const Ports = Layer.mergeAll(
      TestFileSystemLive,
      Layer.provideMerge(TestPathResolverLive, PathStateLive),
    );
    const rt = ManagedRuntime.make(Layer.merge(Ports, DialogFailing));
    await expect(rt.runPromise(exportBook(book))).rejects.toThrow();
  });
});
