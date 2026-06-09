import { Effect, Layer } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as BookSvc from '@/services/bookService';

export const CoverServiceLive = Layer.effect(
  CoverService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const platform = yield* Platform;
    const info = yield* platform.info;
    const localBooksDir = yield* resolver.prefix('Books'); // cached snapshot
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const ctx: BookSvc.CoverContext = { fs, appPlatform: info.appPlatform, localBooksDir };
    const err = (operation: string, bookId?: string) => (cause: unknown) =>
      new BookError({ operation, bookId, cause });
    return {
      getCoverImageUrl: (book: Book) => BookSvc.getCoverImageUrl(ctx, book),
      getCoverImageBlobUrl: (book: Book) =>
        Effect.tryPromise({
          try: () => BookSvc.getCoverImageBlobUrl(ctx, book),
          catch: err('getCoverImageBlobUrl', book.hash),
        }),
      getCachedImageUrl: (pathOrUrl: string) =>
        Effect.tryPromise({
          try: () => BookSvc.getCachedImageUrl(ctx, pathOrUrl),
          catch: err('getCachedImageUrl'),
        }),
      generateCoverImageUrl: (book: Book) =>
        Effect.tryPromise({
          try: () => BookSvc.generateCoverImageUrl(ctx, book),
          catch: err('generateCoverImageUrl', book.hash),
        }),
      updateCoverImage: (book: Book, imageUrl?: string, imageFile?: string) =>
        Effect.tryPromise({
          try: () => BookSvc.updateCoverImage(ctx, book, imageUrl, imageFile),
          catch: err('updateCoverImage', book.hash),
        }),
    } satisfies CoverServiceShape;
  }),
);
