import { Effect, Layer } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { CoverService } from '@/application/services/CoverService';
import {
  LibraryRepository,
  type LibraryRepositoryShape,
} from '@/application/repositories/LibraryRepository';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as LibrarySvc from '@/services/libraryService';

export const LibraryRepositoryLive = Layer.effect(
  LibraryRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const cover = yield* CoverService;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const generateCoverImageUrl = (book: Book) =>
      Effect.runPromise(cover.generateCoverImageUrl(book));
    return {
      load: Effect.tryPromise({
        try: () => LibrarySvc.loadLibraryBooks(fs, generateCoverImageUrl),
        catch: (cause) => new BookError({ operation: 'loadLibrary', cause }),
      }),
      save: (books) =>
        Effect.tryPromise({
          try: () => LibrarySvc.saveLibraryBooks(fs, books as Book[]),
          catch: (cause) => new BookError({ operation: 'saveLibrary', cause }),
        }),
    } satisfies LibraryRepositoryShape;
  }),
);
