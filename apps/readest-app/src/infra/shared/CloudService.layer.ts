import { Effect, Layer } from 'effect';
import { CloudError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { CloudService, type CloudServiceShape } from '@/application/services/CloudService';
import * as CloudTransfers from '@/application/services/cloud/cloudTransfers';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as BookSvc from '@/services/bookService';

export const CloudServiceLive = Layer.effect(
  CloudService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem | PathResolver>) =>
      e.pipe(
        Effect.provideService(FileSystem, fsPort),
        Effect.provideService(PathResolver, resolver),
      );
    const err = (operation: string) => (cause: unknown) => new CloudError({ operation, cause });

    // fetchBookDetails ONLY: temporary bridge to the not-yet-migrated bookService
    // (bookService.fetchBookDetails + loadBookContent need a full legacy
    // FileSystem). Removed in E6d when bookService de-adapters. This is the sole
    // remaining makeLegacyFsAdapter use in CloudService.
    const legacyFs = makeLegacyFsAdapter(fsPort, resolver);

    return {
      uploadBook: (book, onProgress) => provide(CloudTransfers.uploadBook(book, onProgress)),
      downloadBook: (book, onlyCover, redownload, onProgress) =>
        provide(CloudTransfers.downloadBook(book, onlyCover, redownload, onProgress)),
      downloadBookCovers: (books) => provide(CloudTransfers.downloadBookCovers(books)),
      downloadCloudFile: (lfp, cfp, onProgress) =>
        provide(CloudTransfers.downloadCloudFile(lfp, cfp, onProgress)),
      uploadFileToCloud: (lfp, cfp, base, onProgress, hash, temp) =>
        provide(CloudTransfers.uploadFileToCloud(lfp, cfp, base, onProgress, hash, temp)),
      uploadReplicaFile: (opts) => provide(CloudTransfers.uploadReplicaFileToCloud(opts)),
      downloadReplicaFile: (opts) => provide(CloudTransfers.downloadReplicaFileFromCloud(opts)),
      deleteReplicaBundle: (kind, replicaId, filenames) =>
        provide(CloudTransfers.deleteReplicaBundleFromCloud(kind, replicaId, filenames)),
      deleteBook: (book, deleteAction) => provide(CloudTransfers.deleteBook(book, deleteAction)),
      fetchBookDetails: (book) =>
        Effect.tryPromise({
          // bookService.fetchBookDetails needs a Promise downloadBook callback;
          // inject this layer's new Effect-native downloadBook run through the
          // resolved ports (R=never → Effect.runPromise valid).
          try: () =>
            BookSvc.fetchBookDetails(legacyFs, book, (b) =>
              Effect.runPromise(provide(CloudTransfers.downloadBook(b))),
            ),
          catch: err('fetchBookDetails'),
        }),
    } satisfies CloudServiceShape;
  }),
);
