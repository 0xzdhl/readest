import { Effect, Layer } from 'effect';
import { FileSystem } from '@/application/ports/FileSystem';
import {
  BookRepository,
  type BookRepositoryShape,
} from '@/application/repositories/BookRepository';
import * as BookData from '@/application/services/book/bookData';

export const BookRepositoryLive = Layer.effect(
  BookRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem>) =>
      e.pipe(Effect.provideService(FileSystem, fsPort));
    return {
      loadContent: (book) => provide(BookData.loadBookContent(book)),
      loadConfig: (book, settings) => provide(BookData.loadBookConfig(book, settings)),
      saveConfig: (book, config, settings) =>
        provide(BookData.saveBookConfig(book, config, settings)),
      loadNav: (book) => provide(BookData.loadBookNav(book)),
      saveNav: (book, nav) => provide(BookData.saveBookNav(book, nav)),
      getFileSize: (book) => provide(BookData.getBookFileSize(book)),
      isAvailable: (book) => provide(BookData.isBookAvailable(book)),
      refreshMetadata: (book) => provide(BookData.refreshBookMetadata(book)),
    } satisfies BookRepositoryShape;
  }),
);
