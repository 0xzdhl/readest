# E6c — CloudService de-adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the nine cloud transfer functions as Effect-native code on the `FileSystem` + `PathResolver` ports, drop `makeLegacyFsAdapter` from those methods in `CloudService.layer.ts`, and delete `src/services/cloudService.ts` — keeping `fetchBookDetails`'s single legacy bridge until E6d.

**Architecture:** A new `src/application/services/cloud/cloudTransfers.ts` holds Effect-native ports of the legacy `cloudService` fns (each `Effect.gen` that `yield*`s the ports, wraps the still-Promise `libs/storage` network calls in `Effect.tryPromise`, swallows the same best-effort branches via `Effect.catchAll`, and maps every failure to `CloudError` with one top-level `Effect.mapError`). `CloudService.layer.ts` becomes a `provide<A,E>` wrapper over the two ports (SettingsRepository.layer pattern). `fetchBookDetails` keeps one commented `makeLegacyFsAdapter` bridge to the not-yet-migrated `bookService`.

**Tech Stack:** TypeScript (strict, ES2022), Effect TS, Vitest. Spec: `docs/superpowers/specs/2026-06-12-effect-e6c-cloud-deadapter-design.md`.

---

## File Structure

- **Create** `src/application/services/cloud/cloudTransfers.ts` — the 9 Effect-native fns + pure `replicaCloudKey`.
- **Rewrite** `src/infra/shared/CloudService.layer.ts` — `provide` helper over `FileSystem` + `PathResolver`; `fetchBookDetails` keeps `makeLegacyFsAdapter`.
- **Repoint** `src/__tests__/services/cloud-service.test.ts` — drive the new Effect-native `deleteBook` through a stub `FileSystem` layer.
- **Delete** `src/services/cloudService.ts`.
- **Unchanged regression guards:** `src/__tests__/application/cloudService.test.ts`, `src/__tests__/services/transfer-manager.test.ts`, `src/__tests__/services/sync/replicaTransferIntegration.test.ts`.

Test-run command (vitest behind a dotenv wrapper): `pnpm test run <path>`.

---

## Task 1: Repoint `cloud-service.test.ts` onto the new module (TDD red)

**Files:**

- Test: `src/__tests__/services/cloud-service.test.ts` (replace entire contents)

- [ ] **Step 1: Replace the test file** so it imports `deleteBook` from the (not-yet-created) new module and drives it through a stub `FileSystem` Effect layer. Every assertion from the old file is preserved.

```typescript
import { Effect, Layer } from 'effect';
import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { deleteBook } from '@/application/services/cloud/cloudTransfers';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import type { Book, BookFormat } from '@/domain/book';
import type { DeleteAction } from '@/domain/system';

vi.mock('@/utils/book', () => ({
  getDir: vi.fn((book: Book) => book.hash),
  getLocalBookFilename: vi.fn((book: Book) => `${book.hash}/${book.title}.epub`),
  getRemoteBookFilename: vi.fn((book: Book) => `${book.hash}/${book.hash}.epub`),
  getCoverFilename: vi.fn((book: Book) => `${book.hash}/cover.png`),
}));

vi.mock('@/libs/storage', () => ({
  downloadFile: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn().mockResolvedValue('https://example.com/file'),
  uploadReplicaFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn(),
  createProgressHandler: vi.fn().mockReturnValue(vi.fn()),
  batchGetDownloadUrls: vi.fn().mockResolvedValue([]),
}));
import * as storage from '@/libs/storage';

function createMockBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'abc123',
    format: 'EPUB' as BookFormat,
    title: 'Test Book',
    author: 'Author',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    uploadedAt: null,
    downloadedAt: Date.now(),
    coverDownloadedAt: Date.now(),
    ...overrides,
  };
}

const makeFs = (over: Partial<FileSystemShape> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    exists: () => Effect.succeed(true),
    removeFile: () => Effect.void,
    ...over,
  } as unknown as FileSystemShape);

const runDelete = (book: Book, action: DeleteAction, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(
    deleteBook(book, action).pipe(Effect.provide(fs)) as Effect.Effect<void, unknown, never>,
  );

describe('cloudService.deleteBook (Effect-native, over stub FileSystem)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('local delete action', () => {
    test('removes the local book file', async () => {
      const book = createMockBook();
      const exists = vi.fn(() => Effect.succeed(true));
      const removeFile = vi.fn(() => Effect.void);
      await runDelete(book, 'local', makeFs({ exists, removeFile }));

      expect(exists).toHaveBeenCalledWith(`${book.hash}/${book.title}.epub`, 'Books');
      expect(removeFile).toHaveBeenCalledWith(`${book.hash}/${book.title}.epub`, 'Books');
    });

    test('sets downloadedAt to null', async () => {
      const book = createMockBook({ downloadedAt: 12345 });
      await runDelete(book, 'local', makeFs());
      expect(book.downloadedAt).toBeNull();
    });

    test('does not set deletedAt for local-only delete', async () => {
      const book = createMockBook({ deletedAt: null });
      await runDelete(book, 'local', makeFs());
      expect(book.deletedAt).toBeNull();
    });

    test('skips removal when file does not exist', async () => {
      const removeFile = vi.fn(() => Effect.void);
      const book = createMockBook();
      await runDelete(book, 'local', makeFs({ exists: () => Effect.succeed(false), removeFile }));
      expect(removeFile).not.toHaveBeenCalled();
    });

    test('only deletes book file, not cover (local action)', async () => {
      const book = createMockBook();
      const removeFile = vi.fn(() => Effect.void);
      await runDelete(book, 'local', makeFs({ removeFile }));
      expect(removeFile).toHaveBeenCalledTimes(1);
      expect(removeFile).toHaveBeenCalledWith(`${book.hash}/${book.title}.epub`, 'Books');
    });
  });

  describe('both delete action', () => {
    test('removes book file and cover', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      const removeFile = vi.fn(() => Effect.void);
      await runDelete(book, 'both', makeFs({ removeFile }));
      expect(removeFile).toHaveBeenCalledWith(`${book.hash}/${book.title}.epub`, 'Books');
      expect(removeFile).toHaveBeenCalledWith(`${book.hash}/cover.png`, 'Books');
    });

    test('sets deletedAt, clears downloadedAt and coverDownloadedAt', async () => {
      const book = createMockBook({
        uploadedAt: 1000,
        downloadedAt: 2000,
        coverDownloadedAt: 3000,
      });
      await runDelete(book, 'both', makeFs());
      expect(book.deletedAt).toBeGreaterThan(0);
      expect(book.downloadedAt).toBeNull();
      expect(book.coverDownloadedAt).toBeNull();
    });

    test('clears uploadedAt when uploaded', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      await runDelete(book, 'both', makeFs());
      expect(book.uploadedAt).toBeNull();
    });
  });

  describe('cloud delete action', () => {
    test('does not delete local files', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      const removeFile = vi.fn(() => Effect.void);
      await runDelete(book, 'cloud', makeFs({ removeFile }));
      expect(removeFile).not.toHaveBeenCalled();
    });

    test('clears uploadedAt when previously uploaded', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      await runDelete(book, 'cloud', makeFs());
      expect(book.uploadedAt).toBeNull();
    });

    test('skips cloud delete when not uploaded', async () => {
      const book = createMockBook({ uploadedAt: null });
      await runDelete(book, 'cloud', makeFs());
      expect(storage.deleteFile).not.toHaveBeenCalled();
    });

    test('calls deleteFile for remote book and cover', async () => {
      const book = createMockBook({ uploadedAt: 1000 });
      await runDelete(book, 'cloud', makeFs());
      expect(storage.deleteFile).toHaveBeenCalledTimes(2);
    });

    test('does not throw when cloud delete fails', async () => {
      (storage.deleteFile as unknown as Mock).mockImplementation(() => {
        throw new Error('network error');
      });
      const book = createMockBook({ uploadedAt: 1000 });
      await runDelete(book, 'cloud', makeFs());
      expect(book.uploadedAt).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (module missing)**

Run: `pnpm test run src/__tests__/services/cloud-service.test.ts`
Expected: FAIL — `Failed to resolve import "@/application/services/cloud/cloudTransfers"`.

- [ ] **Step 3: Commit the red test**

```bash
git add src/__tests__/services/cloud-service.test.ts
CI=true git commit -m "test(effect): E6c repoint cloud-service.test onto Effect-native deleteBook (red)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Create `cloudTransfers.ts` (Effect-native ports)

**Files:**

- Create: `src/application/services/cloud/cloudTransfers.ts`

- [ ] **Step 1: Write the module.** Faithful, mechanical port of `src/services/cloudService.ts` — same control flow, timestamp mutations, console logs, best-effort swallows, and `Promise.all` parallelism (now `Effect.all({ concurrency: 'unbounded' })`).

```typescript
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
```

Notes for the implementer:

- `deleteCloudFile` (storage `deleteFile`) is `async`. `Effect.tryPromise` catches BOTH a synchronous throw from the thunk (the "does not throw when cloud delete fails" test mocks a sync throw) and a promise rejection, routing either to the error channel where `catchAll` swallows + logs it. This is faithful-or-better than the legacy fire-and-forget (which awaited nothing and leaked unhandled rejections).
- `deleteReplicaBundleFromCloud` has `R = never`; the layer's `provide` (which supplies both ports) accepts it — extra services are harmless. If tsgo objects, add a leading `const _fs = yield* FileSystem;` inside an `Effect.gen` wrapper — but it should type-check as written.
- Do NOT change `src/services/cloudService.ts` yet (still imported by the live layer); it is deleted in Task 4.

- [ ] **Step 2: Run the repointed test to verify it passes**

Run: `pnpm test run src/__tests__/services/cloud-service.test.ts`
Expected: PASS (all 13 cases).

- [ ] **Step 3: Type-check the new module compiles**

Run: `pnpm exec tsgo --noEmit`
Expected: no NEW errors (only the pre-existing `scripts/upload-cjk-fonts-r2.ts` baseline error).

- [ ] **Step 4: Commit**

```bash
git add src/application/services/cloud/cloudTransfers.ts src/__tests__/services/cloud-service.test.ts
CI=true git commit -m "feat(effect): E6c Effect-native cloud transfers module (green)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rewrite `CloudService.layer.ts` over the ports

**Files:**

- Rewrite: `src/infra/shared/CloudService.layer.ts`
- Regression guard (do not edit): `src/__tests__/application/cloudService.test.ts`

- [ ] **Step 1: Replace the layer file** with the `provide`-helper form. The 9 cloud methods delegate to the new module; `fetchBookDetails` keeps the one `makeLegacyFsAdapter` bridge.

```typescript
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
```

- [ ] **Step 2: Run the live-layer regression guard**

Run: `pnpm test run src/__tests__/application/cloudService.test.ts`
Expected: PASS (4 cases: uploadBook→CloudError, deleteBook local removeFile, downloadReplicaFile resolves dst, storage rejection→CloudError).

- [ ] **Step 3: Run the singleton regression guards** (mock at the clientRuntime boundary; must be unaffected)

Run: `pnpm test run src/__tests__/services/transfer-manager.test.ts src/__tests__/services/sync/replicaTransferIntegration.test.ts`
Expected: PASS (transfer-manager 46, replicaTransferIntegration 13).

- [ ] **Step 4: Commit**

```bash
git add src/infra/shared/CloudService.layer.ts
CI=true git commit -m "refactor(effect): E6c CloudService.layer over ports; legacy bridge only for fetchBookDetails

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Delete `services/cloudService.ts` + full verification

**Files:**

- Delete: `src/services/cloudService.ts`

- [ ] **Step 1: Confirm no importers remain** before deleting.

Run: `rg -n "@/services/cloudService" src`
Expected: NO output (Task 2/3 repointed the test and the layer).

- [ ] **Step 2: Delete the file**

```bash
git rm src/services/cloudService.ts
```

- [ ] **Step 3: Grep gates**

Run: `rg -n "@/services/cloudService" src` → expected EMPTY.
Run: `rg -c "makeLegacyFsAdapter" src/infra/shared/CloudService.layer.ts` → expected `1` (the `fetchBookDetails` bridge).
Run: `rg -ln "makeLegacyFsAdapter" src --glob '!**/*.test.*'` → expected 7 files (CloudService/CoverService/LibraryRepository/BookRepository layers + exportBook + importBooks + fsPortAdapter.ts def) — consumer count unchanged at 6 + the def.

- [ ] **Step 4: Lint (tsgo + biome)**

Run: `pnpm lint`
Expected: tsgo only the pre-existing `scripts/upload-cjk-fonts-r2.ts` baseline error; Biome only the pre-existing `SettingsDialog.tsx` lazy baseline. No new errors.

- [ ] **Step 5: Full cloud test surface + suite**

Run: `pnpm test run src/__tests__/services/cloud-service.test.ts src/__tests__/application/cloudService.test.ts src/__tests__/services/transfer-manager.test.ts src/__tests__/services/sync/replicaTransferIntegration.test.ts`
Expected: all PASS.

Run: `pnpm test run` (full suite)
Expected: green except the known env/timer-flaky set (auth-page, useBookShortcuts, theme-store import-time env, ProgressBar/ReadingRuler timer, clientRuntime/edgeTTS/opds-req sandbox, hardcover) — none E6c-touched. Confirm no NEW failures.

- [ ] **Step 6: Commit**

```bash
git add -A
CI=true git commit -m "refactor(effect): E6c delete services/cloudService.ts (de-adapter complete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done-conditions (whole slice)

1. `src/services/cloudService.ts` deleted; `rg "@/services/cloudService" src` empty.
2. `CloudService.layer.ts` uses `makeLegacyFsAdapter` exactly once (`fetchBookDetails`); the 9 cloud-IO methods are `provide(...)` over the ports.
3. `CloudServiceShape` unchanged (no consumer churn).
4. Regression guards green: `application/cloudService.test.ts`, `transfer-manager.test.ts`, `replicaTransferIntegration.test.ts`; repointed `cloud-service.test.ts` green.
5. `pnpm lint` 0-new; full suite green minus the known flaky set.
