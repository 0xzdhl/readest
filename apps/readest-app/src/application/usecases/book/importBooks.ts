import { Effect, Either } from 'effect';
import type { Book, BookConfig } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { BookRepository } from '@/application/repositories/BookRepository';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { CoverService } from '@/application/services/CoverService';
import { makeLegacyFsAdapter } from '@/infra/shared/fsPortAdapter';
import * as BookSvc from '@/services/bookService';

export interface ImportBookInput {
  file: string | File;
  // path/basePath are not read by the usecase; they're forwarded verbatim to
  // onImported(book, input) so the consumer can derive groups from the dir path.
  path?: string;
  basePath?: string;
}

export interface ImportBooksOptions {
  transient?: boolean;
  saveBook?: boolean;
  saveCover?: boolean;
  overwrite?: boolean;
  concurrency?: number;
  persist?: boolean;
  onImported?: (book: Book, input: ImportBookInput) => void;
  onBatch?: (imported: Book[]) => void;
}

export interface ImportBooksResult {
  library: Book[];
  imported: Book[];
  failed: Array<{ filename: string; error: unknown }>;
}

const filenameOf = (file: string | File): string => (typeof file === 'string' ? file : file.name);

/**
 * Import 1..N books then optionally persist library.json. Reuses
 * bookService.importBook, injecting BookRepository.saveConfig +
 * CoverService.generateCoverImageUrl as the legacy callbacks. The `books` array
 * is mutated in place (faithful to legacy) and is what gets persisted. Grouping
 * is left to the consumer via `onImported` (getGroupId/getGroupName are store
 * methods).
 */
export const importBooks = (
  books: Book[],
  inputs: ReadonlyArray<ImportBookInput>,
  options: ImportBooksOptions = {},
): Effect.Effect<
  ImportBooksResult,
  BookError,
  BookRepository | CoverService | FileSystem | PathResolver | LibraryRepository
> =>
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const bookRepo = yield* BookRepository;
    const cover = yield* CoverService;
    const library = yield* LibraryRepository;
    const fs = makeLegacyFsAdapter(fsPort, resolver);

    const { transient, saveBook, saveCover, overwrite, onImported, onBatch } = options;
    const concurrency = options.concurrency ?? 4;
    const persist = options.persist ?? true;

    const saveBookConfig = (b: Book, c: BookConfig) => Effect.runPromise(bookRepo.saveConfig(b, c));
    const generateCoverImageUrl = (b: Book) => Effect.runPromise(cover.generateCoverImageUrl(b));

    const lookupIndex = BookSvc.buildBookLookupIndex(books);
    const imported: Book[] = [];
    const failed: Array<{ filename: string; error: unknown }> = [];

    const importOne = (input: ImportBookInput) =>
      Effect.tryPromise({
        try: () =>
          BookSvc.importBook(fs, input.file, books, {
            lookupIndex,
            saveBook,
            saveCover,
            overwrite,
            transient,
            saveBookConfig,
            generateCoverImageUrl,
          }),
        catch: (cause) => new BookError({ operation: 'importBook', cause }),
      }).pipe(
        Effect.either,
        Effect.map((result) => ({ input, result })),
      );

    // Slice into batches so onBatch fires once per group (≤ concurrency). Each
    // importOne already boxes failures via Effect.either, so the batch never aborts.
    for (let i = 0; i < inputs.length; i += concurrency) {
      const batch = inputs.slice(i, i + concurrency);
      const results = yield* Effect.all(batch.map(importOne), { concurrency });
      const importedThisBatch: Book[] = [];
      for (const { input, result } of results) {
        if (Either.isLeft(result)) {
          // Record the original thrown error (BookError.cause), not the wrapper, so
          // consumers can localize from the underlying message (faithful to legacy).
          failed.push({ filename: filenameOf(input.file), error: result.left.cause });
        } else if (result.right) {
          imported.push(result.right);
          importedThisBatch.push(result.right);
          onImported?.(result.right, input);
        }
      }
      if (importedThisBatch.length > 0) onBatch?.(importedThisBatch);
    }

    if (persist && imported.length > 0) {
      yield* library.save(books);
    }

    return { library: books, imported, failed };
  });
