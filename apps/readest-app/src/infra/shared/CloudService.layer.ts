import { Effect, Layer } from 'effect';
import type { Book } from '@/domain/book';
import type { AppService, BaseDir } from '@/domain/system';
import { CloudError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import {
  CloudService,
  type CloudServiceShape,
  type ReplicaFileOpts,
  type ReplicaDownloadOpts,
} from '@/application/services/CloudService';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as CloudSvc from '@/services/cloudService';
import * as BookSvc from '@/services/bookService';

export const CloudServiceLive = Layer.effect(
  CloudService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const localBooksDir = yield* resolver.prefix('Books'); // cached snapshot
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    // The cloud download fns thread `appService` only into libs/storage.downloadFile,
    // which uses exactly one method: appService.writeFile. The legacy adapter has it,
    // so the same object satisfies both the `fs` and the `appService` params.
    const appService = fs as unknown as AppService;
    const resolveFilePath = (path: string, base: BaseDir) =>
      Effect.runPromise(resolver.absolute(path, base));
    const err = (operation: string) => (cause: unknown) => new CloudError({ operation, cause });

    return {
      uploadBook: (book, onProgress) =>
        Effect.tryPromise({
          try: () => CloudSvc.uploadBook(fs, resolveFilePath, book, onProgress),
          catch: err('uploadBook'),
        }),
      downloadBook: (book, onlyCover, redownload, onProgress) =>
        Effect.tryPromise({
          try: () =>
            CloudSvc.downloadBook(
              appService,
              fs,
              localBooksDir,
              book,
              onlyCover,
              redownload,
              onProgress,
            ),
          catch: err('downloadBook'),
        }),
      downloadBookCovers: (books: Book[]) =>
        Effect.tryPromise({
          try: () => CloudSvc.downloadBookCovers(appService, fs, localBooksDir, books),
          catch: err('downloadBookCovers'),
        }),
      downloadCloudFile: (lfp, cfp, onProgress) =>
        Effect.tryPromise({
          try: () => CloudSvc.downloadCloudFile(appService, localBooksDir, lfp, cfp, onProgress),
          catch: err('downloadCloudFile'),
        }),
      uploadFileToCloud: (lfp, cfp, base, onProgress, hash, temp) =>
        Effect.tryPromise({
          try: () =>
            CloudSvc.uploadFileToCloud(fs, resolveFilePath, lfp, cfp, base, onProgress, hash, temp),
          catch: err('uploadFileToCloud'),
        }),
      uploadReplicaFile: (opts: ReplicaFileOpts) =>
        Effect.tryPromise({
          try: () => CloudSvc.uploadReplicaFileToCloud(fs, resolveFilePath, opts),
          catch: err('uploadReplicaFile'),
        }),
      downloadReplicaFile: (opts: ReplicaDownloadOpts) =>
        Effect.tryPromise({
          // Mirror appService.downloadReplicaFile: resolve `<bundleDir>/<filename>`
          // lfp against the replica base BEFORE downloading, else bytes land at the
          // literal lfp and subsequent openFile(lfp, base) fails.
          try: async () => {
            const dst = await resolveFilePath(opts.lfp, opts.base);
            return CloudSvc.downloadReplicaFileFromCloud(appService, {
              kind: opts.kind,
              replicaId: opts.replicaId,
              filename: opts.filename,
              dst,
              onProgress: opts.onProgress,
            });
          },
          catch: err('downloadReplicaFile'),
        }),
      deleteReplicaBundle: (kind, replicaId, filenames) =>
        Effect.tryPromise({
          try: () => CloudSvc.deleteReplicaBundleFromCloud(kind, replicaId, filenames),
          catch: err('deleteReplicaBundle'),
        }),
      deleteBook: (book, deleteAction) =>
        Effect.tryPromise({
          try: () => CloudSvc.deleteBook(fs, book, deleteAction),
          catch: err('deleteBook'),
        }),
      fetchBookDetails: (book) =>
        Effect.tryPromise({
          // bookService.fetchBookDetails needs a downloadBook callback; inject this
          // layer's own download path (R=never; the promise rejects on failure and
          // Effect.tryPromise maps it to CloudError).
          try: () =>
            BookSvc.fetchBookDetails(fs, book, (b) =>
              CloudSvc.downloadBook(appService, fs, localBooksDir, b),
            ),
          catch: err('fetchBookDetails'),
        }),
    } satisfies CloudServiceShape;
  }),
);
