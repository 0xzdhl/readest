import { Effect } from 'effect';
import type { Book } from '@/domain/book';
import type { BaseDir, DeleteAction, FileWriter } from '@/domain/system';
import type { ProgressHandler } from '@/domain/transfer';
import type { ClosableFile } from '@/utils/file';
import { CloudError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import type { ReplicaFileOpts, ReplicaDownloadOpts } from '@/application/services/CloudService';
import {
  getDir,
  getLocalBookFilename,
  getRemoteBookFilename,
  getCoverFilename,
} from '@/utils/book';
import {
  downloadFile,
  uploadFile,
  uploadReplicaFile,
  deleteFile as deleteCloudFile,
  createProgressHandler,
  batchGetDownloadUrls,
} from '@/libs/storage';
import { CLOUD_BOOKS_SUBDIR, CLOUD_REPLICAS_SUBDIR } from '@/services/constants';

// Cloud key for a replica binary. Centralized so adapters and the download
// path share the same path-construction rule.
export const replicaCloudKey = (kind: string, replicaId: string, filename: string): string =>
  `${CLOUD_REPLICAS_SUBDIR}/${kind}/${replicaId}/${filename}`;

export const deleteBook = (
  book: Book,
  deleteAction: DeleteAction,
): Effect.Effect<void, CloudError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (deleteAction === 'local' || deleteAction === 'both') {
      const localDeleteFps =
        deleteAction === 'local'
          ? [getLocalBookFilename(book)]
          : [getLocalBookFilename(book), getCoverFilename(book)];
      yield* Effect.forEach(localDeleteFps, (fp) =>
        Effect.gen(function* () {
          if (yield* fs.exists(fp, 'Books')) {
            yield* fs.removeFile(fp, 'Books');
          }
        }),
      );
      if (deleteAction === 'local') {
        book.downloadedAt = null;
      } else {
        book.deletedAt = Date.now();
        book.downloadedAt = null;
        book.coverDownloadedAt = null;
      }
    }
    if ((deleteAction === 'cloud' || deleteAction === 'both') && book.uploadedAt) {
      const fps = [getRemoteBookFilename(book), getCoverFilename(book)];
      // Best-effort, like legacy. Legacy called deleteCloudFile WITHOUT await
      // (fire-and-forget); here we await + swallow, so a rejection is handled
      // rather than leaked as an unhandled rejection (faithful-or-better).
      yield* Effect.forEach(
        fps,
        (fp) => {
          const cfp = `${CLOUD_BOOKS_SUBDIR}/${fp}`;
          return Effect.tryPromise(() => deleteCloudFile(cfp)).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => console.log('Failed to delete uploaded file:', error)),
            ),
          );
        },
        { discard: true },
      );
      book.uploadedAt = null;
    }
  }).pipe(Effect.mapError((cause) => new CloudError({ operation: 'deleteBook', cause })));

export const uploadFileToCloud = (
  lfp: string,
  cfp: string,
  base: BaseDir,
  handleProgress: ProgressHandler,
  hash: string,
  temp = false,
): Effect.Effect<string | undefined, CloudError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    console.log('Uploading file:', lfp, 'to', cfp);
    const file = yield* fs.openFile(lfp, base, cfp);
    const localFullpath = yield* resolver.absolute(lfp, base);
    const downloadUrl = yield* Effect.tryPromise(() =>
      uploadFile(file, localFullpath, handleProgress, hash, temp),
    );
    const f = file as ClosableFile;
    if (f && f.close) {
      yield* Effect.tryPromise(() => f.close());
    }
    return downloadUrl;
  }).pipe(Effect.mapError((cause) => new CloudError({ operation: 'uploadFileToCloud', cause })));

export const uploadBook = (
  book: Book,
  onProgress?: ProgressHandler,
): Effect.Effect<void, CloudError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    let uploaded = false;
    const completedFiles = { count: 0 };
    let toUploadFpCount = 0;
    const coverExist = yield* fs.exists(getCoverFilename(book), 'Books');
    let bookFileExist = yield* fs.exists(getLocalBookFilename(book), 'Books');
    if (coverExist) {
      toUploadFpCount++;
    }
    if (bookFileExist) {
      toUploadFpCount++;
    }
    if (!bookFileExist && book.url) {
      const fileobj = yield* fs.openFile(book.url, 'None');
      const buf = yield* Effect.tryPromise(() => fileobj.arrayBuffer());
      yield* fs.writeFile(getLocalBookFilename(book), 'Books', buf);
      bookFileExist = true;
    }

    const handleProgress = createProgressHandler(toUploadFpCount, completedFiles, onProgress);

    if (coverExist) {
      const lfp = getCoverFilename(book);
      const cfp = `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`;
      yield* uploadFileToCloud(lfp, cfp, 'Books', handleProgress, book.hash);
      uploaded = true;
      completedFiles.count++;
    }

    if (bookFileExist) {
      const lfp = getLocalBookFilename(book);
      const cfp = `${CLOUD_BOOKS_SUBDIR}/${getRemoteBookFilename(book)}`;
      yield* uploadFileToCloud(lfp, cfp, 'Books', handleProgress, book.hash);
      uploaded = true;
      completedFiles.count++;
    }

    if (uploaded) {
      book.deletedAt = null;
      book.updatedAt = Date.now();
      book.uploadedAt = Date.now();
      book.downloadedAt = Date.now();
      book.coverDownloadedAt = Date.now();
    } else {
      return yield* Effect.fail(new Error('Book file not uploaded'));
    }
  }).pipe(Effect.mapError((cause) => new CloudError({ operation: 'uploadBook', cause })));

export const downloadCloudFile = (
  lfp: string,
  cfp: string,
  onProgress: ProgressHandler,
): Effect.Effect<void, CloudError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const localBooksDir = yield* resolver.prefix('Books');
    const writer: FileWriter = {
      writeFile: (path, b, content) => Effect.runPromise(fs.writeFile(path, b, content)),
    };
    console.log('Downloading file:', cfp, 'to', lfp);
    const dstPath = `${localBooksDir}/${lfp}`;
    yield* Effect.tryPromise(() =>
      downloadFile({ appService: writer, cfp, dst: dstPath, onProgress }),
    );
  }).pipe(Effect.mapError((cause) => new CloudError({ operation: 'downloadCloudFile', cause })));

export const downloadBookCovers = (
  books: Book[],
): Effect.Effect<void, CloudError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const localBooksDir = yield* resolver.prefix('Books');
    const writer: FileWriter = {
      writeFile: (path, b, content) => Effect.runPromise(fs.writeFile(path, b, content)),
    };
    const booksLfps = new Map(books.map((book) => [getCoverFilename(book), book] as const));
    const filePaths = books.map((book) => ({
      lfp: getCoverFilename(book),
      cfp: `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`,
    }));
    const downloadUrls = yield* Effect.tryPromise(() => batchGetDownloadUrls(filePaths));
    yield* Effect.all(
      books.map((book) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(getDir(book), 'Books'))) {
            yield* fs.createDir(getDir(book), 'Books');
          }
        }),
      ),
      { concurrency: 'unbounded', discard: true },
    );
    yield* Effect.all(
      downloadUrls.map((file) =>
        Effect.tryPromise(async () => {
          const dst = `${localBooksDir}/${file.lfp}`;
          if (!file.downloadUrl) return;
          await downloadFile({ appService: writer, dst, cfp: file.cfp, url: file.downloadUrl });
          const book = booksLfps.get(file.lfp);
          if (book && !book.coverDownloadedAt) {
            book.coverDownloadedAt = Date.now();
          }
        }).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() =>
              console.log(`Failed to download cover file for book: '${file.lfp}'`, error),
            ),
          ),
        ),
      ),
      { concurrency: 'unbounded', discard: true },
    );
  }).pipe(Effect.mapError((cause) => new CloudError({ operation: 'downloadBookCovers', cause })));

export const downloadBook = (
  book: Book,
  onlyCover = false,
  redownload = false,
  onProgress?: ProgressHandler,
): Effect.Effect<void, CloudError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const localBooksDir = yield* resolver.prefix('Books');
    let bookDownloaded = false;
    let bookCoverDownloaded = false;
    const completedFiles = { count: 0 };
    let toDownloadFpCount = 0;
    const needDownCover = !(yield* fs.exists(getCoverFilename(book), 'Books')) || redownload;
    const needDownBook =
      (!onlyCover && !(yield* fs.exists(getLocalBookFilename(book), 'Books'))) || redownload;
    if (needDownCover) {
      toDownloadFpCount++;
    }
    if (needDownBook) {
      toDownloadFpCount++;
    }

    const handleProgress = createProgressHandler(toDownloadFpCount, completedFiles, onProgress);

    if (!(yield* fs.exists(getDir(book), 'Books'))) {
      yield* fs.createDir(getDir(book), 'Books');
    }

    // Cover download is best-effort (some books have no cover): swallow + log,
    // and increment the completed counter regardless (legacy try/catch/finally).
    if (needDownCover) {
      const lfp = getCoverFilename(book);
      const cfp = `${CLOUD_BOOKS_SUBDIR}/${lfp}`;
      yield* downloadCloudFile(lfp, cfp, handleProgress).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            bookCoverDownloaded = true;
          }),
        ),
        Effect.catchAll((error) =>
          Effect.sync(() =>
            console.log(`Failed to download cover file for book: '${book.title}'`, error),
          ),
        ),
      );
      completedFiles.count++;
    }

    if (needDownBook) {
      const lfp = getLocalBookFilename(book);
      const cfp = `${CLOUD_BOOKS_SUBDIR}/${getRemoteBookFilename(book)}`;
      yield* downloadCloudFile(lfp, cfp, handleProgress);
      const localFullpath = `${localBooksDir}/${lfp}`;
      bookDownloaded = yield* fs.exists(localFullpath, 'None');
      completedFiles.count++;
    }
    // some books may not have cover image, so we check if the book is downloaded
    if (bookDownloaded || (!onlyCover && !needDownBook)) {
      book.downloadedAt = Date.now();
    }
    if ((bookCoverDownloaded || !needDownCover) && !book.coverDownloadedAt) {
      book.coverDownloadedAt = Date.now();
    }
  }).pipe(Effect.mapError((cause) => new CloudError({ operation: 'downloadBook', cause })));

export const uploadReplicaFileToCloud = (
  opts: ReplicaFileOpts,
): Effect.Effect<void, CloudError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const cfp = `${CLOUD_REPLICAS_SUBDIR}/${opts.kind}/${opts.replicaId}/${opts.filename}`;
    console.log('Uploading replica file:', opts.lfp, 'to', cfp);
    const file = yield* fs.openFile(opts.lfp, opts.base, opts.filename);
    const localFullpath = yield* resolver.absolute(opts.lfp, opts.base);
    yield* Effect.tryPromise(() =>
      uploadReplicaFile(file, localFullpath, cfp, opts.kind, opts.replicaId, opts.onProgress),
    );
    const f = file as ClosableFile;
    if (f && f.close) {
      yield* Effect.tryPromise(() => f.close());
    }
  }).pipe(Effect.mapError((cause) => new CloudError({ operation: 'uploadReplicaFile', cause })));

export const downloadReplicaFileFromCloud = (
  opts: ReplicaDownloadOpts,
): Effect.Effect<void, CloudError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const writer: FileWriter = {
      writeFile: (path, b, content) => Effect.runPromise(fs.writeFile(path, b, content)),
    };
    // Mirror appService.downloadReplicaFile: resolve `<bundleDir>/<filename>`
    // against the replica base BEFORE downloading, else bytes land at the
    // literal lfp and subsequent openFile(lfp, base) fails.
    const dst = yield* resolver.absolute(opts.lfp, opts.base);
    const cfp = replicaCloudKey(opts.kind, opts.replicaId, opts.filename);
    yield* Effect.tryPromise(() =>
      downloadFile({ appService: writer, cfp, dst, onProgress: opts.onProgress }),
    );
  }).pipe(Effect.mapError((cause) => new CloudError({ operation: 'downloadReplicaFile', cause })));

export const deleteReplicaBundleFromCloud = (
  kind: string,
  replicaId: string,
  filenames: string[],
): Effect.Effect<void, CloudError> =>
  Effect.forEach(
    filenames,
    (filename) => {
      const cfp = replicaCloudKey(kind, replicaId, filename);
      return Effect.tryPromise(() => deleteCloudFile(cfp)).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => console.log(`Failed to delete replica file ${cfp}:`, error)),
        ),
      );
    },
    { discard: true },
  ).pipe(Effect.mapError((cause) => new CloudError({ operation: 'deleteReplicaBundle', cause })));
