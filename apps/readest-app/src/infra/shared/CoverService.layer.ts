import { Effect, Layer } from 'effect';
import type { Book } from '@/domain/book';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import { getCoverFilename } from '@/utils/book';
import * as CoverImages from '@/application/services/cover/coverImages';

export const CoverServiceLive = Layer.effect(
  CoverService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const platform = yield* Platform;
    const localBooksDir = yield* resolver.prefix('Books'); // cached snapshot
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem | PathResolver | Platform>) =>
      e.pipe(
        Effect.provideService(FileSystem, fsPort),
        Effect.provideService(PathResolver, resolver),
        Effect.provideService(Platform, platform),
      );
    return {
      // Sync: getUrl is a sync Effect; run it over the snapshotted localBooksDir
      // (Tauri resolver.prefix is async, so it can't be re-run under runSync).
      getCoverImageUrl: (book: Book) =>
        Effect.runSync(fsPort.getUrl(`${localBooksDir}/${getCoverFilename(book)}`)),
      getCoverImageBlobUrl: (book: Book) => provide(CoverImages.getCoverImageBlobUrl(book)),
      getCachedImageUrl: (pathOrUrl: string) => provide(CoverImages.getCachedImageUrl(pathOrUrl)),
      generateCoverImageUrl: (book: Book) => provide(CoverImages.generateCoverImageUrl(book)),
      updateCoverImage: (book: Book, imageUrl?: string, imageFile?: string) =>
        provide(CoverImages.updateCoverImage(book, imageUrl, imageFile)),
    } satisfies CoverServiceShape;
  }),
);
