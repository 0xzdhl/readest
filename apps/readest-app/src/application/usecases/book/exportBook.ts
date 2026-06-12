import { Effect, Option } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Dialog } from '@/application/ports/Dialog';
import * as BookData from '@/application/services/book/bookData';
import { getLocalBookFilename } from '@/utils/book';
import { makeSafeFilename } from '@/utils/misc';
import { getFilename } from '@/utils/path';

/**
 * Export a book file via the platform save dialog. Effect-native port of the
 * legacy bookService.exportBook + its usecase callbacks: loadBookContent (BookData),
 * resolveFilePath -> PathResolver, copyFile -> FileSystem, saveFile -> Dialog
 * (Option.isSome => boolean "saved?").
 */
export const exportBook = (
  book: Book,
): Effect.Effect<boolean, BookError, FileSystem | PathResolver | Dialog> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const dialog = yield* Dialog;

    const { file } = yield* BookData.loadBookContent(book);
    const content = yield* Effect.tryPromise(() => file.arrayBuffer());
    const filename = `${makeSafeFilename(book.title)}.${book.format.toLowerCase()}`;
    let filePath = yield* resolver.absolute(getLocalBookFilename(book), 'Books');
    const mimeType = file.type || 'application/octet-stream';
    if (getFilename(filePath) !== filename) {
      yield* fs.copyFile(filePath, 'None', filename, 'Temp');
      filePath = yield* resolver.absolute(filename, 'Temp');
    }
    return yield* dialog
      .saveFile(filename, content, { filePath, mimeType })
      .pipe(Effect.map(Option.isSome));
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'exportBook', bookId: book.hash, cause }),
    ),
  );
