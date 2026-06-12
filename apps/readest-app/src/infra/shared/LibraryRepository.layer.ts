import { Effect, Layer } from 'effect';
import type { Book } from '@/domain/book';
import { FileSystem } from '@/application/ports/FileSystem';
import { CoverService } from '@/application/services/CoverService';
import {
  LibraryRepository,
  type LibraryRepositoryShape,
} from '@/application/repositories/LibraryRepository';
import * as LibraryData from '@/application/services/library/libraryData';

export const LibraryRepositoryLive = Layer.effect(
  LibraryRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const cover = yield* CoverService;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem | CoverService>) =>
      e.pipe(Effect.provideService(FileSystem, fsPort), Effect.provideService(CoverService, cover));
    return {
      load: provide(LibraryData.loadLibraryBooks()),
      save: (books) => provide(LibraryData.saveLibraryBooks(books as Book[])),
    } satisfies LibraryRepositoryShape;
  }),
);
