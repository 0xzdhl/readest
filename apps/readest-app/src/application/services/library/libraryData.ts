import { Effect } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { CoverService } from '@/application/services/CoverService';
import { getLibraryStoragePath } from '@/utils/userPaths';
import { safeLoadJsonE, safeSaveJsonE } from '@/application/services/shared/json';

const COVER_CONCURRENCY = 20;

export const loadLibraryBooks = (): Effect.Effect<Book[], BookError, FileSystem | CoverService> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const cover = yield* CoverService;
    if (!(yield* fs.exists('', 'Books'))) {
      yield* fs.createDir('', 'Books', true);
    }
    const books = yield* safeLoadJsonE<Book[]>(getLibraryStoragePath(), 'Books', []);
    yield* Effect.forEach(
      books,
      (book) =>
        Effect.gen(function* () {
          book.coverImageUrl = yield* cover.generateCoverImageUrl(book);
          book.updatedAt ??= book.lastUpdated || Date.now();
        }),
      { concurrency: COVER_CONCURRENCY, discard: true },
    );
    return books;
  }).pipe(Effect.mapError((cause) => new BookError({ operation: 'loadLibrary', cause })));

export const saveLibraryBooks = (books: Book[]): Effect.Effect<void, BookError, FileSystem> =>
  Effect.gen(function* () {
    const libraryBooks = books.map(({ coverImageUrl: _coverImageUrl, ...rest }) => rest);
    yield* safeSaveJsonE(getLibraryStoragePath(), 'Books', libraryBooks);
  }).pipe(Effect.mapError((cause) => new BookError({ operation: 'saveLibrary', cause })));
