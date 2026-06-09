import { Effect, Option } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Dialog, type SaveFileOptions } from '@/application/ports/Dialog';
import { makeLegacyFsAdapter } from '@/infra/shared/fsPortAdapter';
import * as BookSvc from '@/services/bookService';

/**
 * Export a book file via the platform save dialog. Reuses bookService.exportBook,
 * mapping its three legacy callbacks onto ports: resolveFilePath -> PathResolver,
 * copyFile -> FileSystem, saveFile -> Dialog (Option.isSome => boolean "saved?").
 */
export const exportBook = (
  book: Book,
): Effect.Effect<boolean, BookError, FileSystem | PathResolver | Dialog> =>
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const dialog = yield* Dialog;
    const fs = makeLegacyFsAdapter(fsPort, resolver);

    const resolveFilePath = (path: string, base: Parameters<typeof resolver.absolute>[1]) =>
      Effect.runPromise(resolver.absolute(path, base));

    const copyFile = (
      srcPath: string,
      srcBase: Parameters<typeof fsPort.copyFile>[1],
      dstPath: string,
      dstBase: Parameters<typeof fsPort.copyFile>[3],
    ) => Effect.runPromise(fsPort.copyFile(srcPath, srcBase, dstPath, dstBase));

    const saveFile = (filename: string, content: ArrayBuffer, options?: SaveFileOptions) =>
      Effect.runPromise(
        dialog.saveFile(filename, content, options).pipe(Effect.map(Option.isSome)),
      );

    return yield* Effect.tryPromise({
      try: () => BookSvc.exportBook(fs, book, resolveFilePath, copyFile, saveFile),
      catch: (cause) => new BookError({ operation: 'exportBook', bookId: book.hash, cause }),
    });
  });
