import { Effect, Layer } from 'effect';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import {
  BookRepository,
  type BookRepositoryShape,
} from '@/application/repositories/BookRepository';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as BookSvc from '@/services/bookService';

export const BookRepositoryLive = Layer.effect(
  BookRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const err = (operation: string, bookId?: string) => (cause: unknown) =>
      new BookError({ operation, bookId, cause });
    return {
      loadContent: (book) =>
        Effect.tryPromise({
          try: () => BookSvc.loadBookContent(fs, book),
          catch: err('loadContent', book.hash),
        }),
      loadConfig: (book, settings) =>
        Effect.tryPromise({
          try: () => BookSvc.loadBookConfig(fs, book, settings),
          catch: err('loadConfig', book.hash),
        }),
      saveConfig: (book, config, settings) =>
        Effect.tryPromise({
          try: () => BookSvc.saveBookConfig(fs, book, config, settings),
          catch: err('saveConfig', book.hash),
        }),
      loadNav: (book) =>
        Effect.tryPromise({
          try: () => BookSvc.loadBookNav(fs, book),
          catch: err('loadNav', book.hash),
        }),
      saveNav: (book, nav) =>
        Effect.tryPromise({
          try: () => BookSvc.saveBookNav(fs, book, nav),
          catch: err('saveNav', book.hash),
        }),
      getFileSize: (book) =>
        Effect.tryPromise({
          try: () => BookSvc.getBookFileSize(fs, book),
          catch: err('getFileSize', book.hash),
        }),
      isAvailable: (book) =>
        Effect.tryPromise({
          try: () => BookSvc.isBookAvailable(fs, book),
          catch: err('isAvailable', book.hash),
        }),
      refreshMetadata: (book) =>
        Effect.tryPromise({
          try: () => BookSvc.refreshBookMetadata(fs, book),
          catch: err('refreshMetadata', book.hash),
        }),
    } satisfies BookRepositoryShape;
  }),
);
