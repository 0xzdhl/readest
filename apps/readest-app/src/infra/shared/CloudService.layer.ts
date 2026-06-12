import { Effect, Layer } from 'effect';
import { CloudError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { CloudService, type CloudServiceShape } from '@/application/services/CloudService';
import * as CloudTransfers from '@/application/services/cloud/cloudTransfers';
import * as BookData from '@/application/services/book/bookData';

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
      // Effect-native fetchBookDetails (E6d-1 retires the E6c legacy-fs bridge):
      // inject this layer's own downloadBook. Unwrap the BookError so CloudError.cause
      // is the original error — single-wrap, matching the other 9 methods.
      fetchBookDetails: (book) =>
        provide(BookData.fetchBookDetails(book, (b) => CloudTransfers.downloadBook(b))).pipe(
          Effect.mapError((e) => new CloudError({ operation: 'fetchBookDetails', cause: e.cause })),
        ),
    } satisfies CloudServiceShape;
  }),
);
