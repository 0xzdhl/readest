import { Effect, Either } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { BookRepository } from '@/application/repositories/BookRepository';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { CoverService } from '@/application/services/CoverService';
import * as BookImport from '@/application/services/book/bookImport';

export interface ImportBookInput {
  file: string | File;
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
 * Import 1..N books then optionally persist library.json. Reuses the Effect-native
 * bookImport.importBook (which yields CoverService + BookRepository internally).
 * The `books` array is mutated in place (faithful to legacy) and is what gets
 * persisted. Grouping is left to the consumer via `onImported`.
 */
export const importBooks = (
  books: Book[],
  inputs: ReadonlyArray<ImportBookInput>,
  options: ImportBooksOptions = {},
): Effect.Effect<
  ImportBooksResult,
  BookError,
  BookRepository | CoverService | FileSystem | LibraryRepository
> =>
  Effect.gen(function* () {
    const library = yield* LibraryRepository;

    const { transient, saveBook, saveCover, overwrite, onImported, onBatch } = options;
    const concurrency = options.concurrency ?? 4;
    const persist = options.persist ?? true;

    const lookupIndex = BookImport.buildBookLookupIndex(books);
    const imported: Book[] = [];
    const failed: Array<{ filename: string; error: unknown }> = [];

    const importOne = (input: ImportBookInput) =>
      BookImport.importBook(input.file, books, {
        lookupIndex,
        saveBook,
        saveCover,
        overwrite,
        transient,
      }).pipe(
        Effect.either,
        Effect.map((result) => ({ input, result })),
      );

    for (let i = 0; i < inputs.length; i += concurrency) {
      const batch = inputs.slice(i, i + concurrency);
      const results = yield* Effect.all(batch.map(importOne), { concurrency });
      const importedThisBatch: Book[] = [];
      for (const { input, result } of results) {
        if (Either.isLeft(result)) {
          // Record the original thrown error (BookError.cause), not the wrapper.
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
