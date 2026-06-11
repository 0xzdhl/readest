# E4 — Sync/Cloud (CloudService + singleton rewiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the cloud/replica transfer surface off the legacy `getAppService()` god-object onto a new Effect `CloudService` (Tag + live layer reusing the pure `cloudService.ts` fns), migrate all cloud consumers, and rewire the stateful boot singletons (`transferManager`, `replicaTransferIntegration`) off `appService`.

**Architecture:** Strangler-fig, additive at the data layer. `CloudService` is an infra-backed service (like `CoverService`/`FontService`): its live layer builds the legacy `FileSystem` via `makeLegacyFsAdapter(fsPort, resolver)` and reuses `src/services/cloudService.ts` verbatim. The download fns take an `appService` param but only `.writeFile` is ever reached, so the same legacy adapter doubles as the minimal `appService` (`as unknown as AppService`). Consumers call `runEffect(Effect.flatMap(CloudService, c => c.method(...)))`. The legacy `appService` cloud wrappers + `domain/system.ts` entries stay live until E5.

**Tech Stack:** TypeScript (ES2022, strict, no `any`), Effect (`Context.Tag`, `Layer.effect`, `Effect.tryPromise`, `Data.TaggedError`), Vitest, Zustand stores.

**Spec:** `docs/superpowers/specs/2026-06-10-effect-e4-sync-cloud-design.md`

**Conventions (from E2a/E3):**

- Tag: `Context.Tag('app/<Name>')`; separate `<Name>Shape` interface.
- Error: `Data.TaggedError`; map failures with `Effect.tryPromise({ try, catch })`.
- Wire new services into the `ClientServices` union in `clientRuntime.ts` (separate from layer composition) AND into `SharedRepos` in both `client-tauri.ts`/`client-web.ts`.
- Non-React modules call `getClientRuntime().runPromise(...)`; React components use `useRunEffect()`.
- Test-rebridge: migrating a store/module pulls the runtime graph in at collection — fix broken partial-mock tests with `vi.mock('@/runtime/clientRuntime')`.

**Verify after every task that touches code:** `npx tsgo --noEmit` (expect only the pre-existing `scripts/upload-cjk-fonts-r2.ts` error) and the relevant test file(s). Full `pnpm test` at the end (residual failures expected only in the known env-flaky set: opds-req/hardcover/edgeTTS/turso-node).

---

## File Structure

**Create:**

- `src/application/services/CloudService.ts` — Tag + `CloudServiceShape` (10 methods).
- `src/infra/shared/CloudService.layer.ts` — `CloudServiceLive`, reuses `cloudService.ts` via the legacy adapter.
- `src/__tests__/application/cloudService.test.ts` — layer test over a stub FileSystem with `@/libs/storage` mocked.

**Modify:**

- `src/application/errors/AppError.ts` — add `CloudError`, add to `AppError` union.
- `src/runtime/clientRuntime.ts` — `CloudService` import + `ClientServices` union member.
- `src/runtime/client-tauri.ts`, `src/runtime/client-web.ts` — `CloudServiceLive` in `SharedRepos`.
- Consumers: `src/libs/shareImport.ts` (+ callers `src/app/s/ShareLanding.tsx`, `src/hooks/useOpenShareLink.ts`), `src/app/library/components/ShareBookDialog.tsx`, `src/utils/discord.ts` (+ caller `src/hooks/useDiscordPresence.ts`), `src/app/library/hooks/useBooksSync.ts`, `src/app/library/index.tsx`, `src/components/metadata/BookDetailModal.tsx`.
- Deferred files: `src/services/backupService.ts` (+ callers), `src/services/opds/autoDownload.ts` (+ callers), `src/app/opds/index.tsx`.
- Singletons: `src/services/transferManager.ts` (+ `src/hooks/useTransferQueue.ts`), `src/services/sync/replicaTransferIntegration.ts` (+ `src/context/EnvContext.tsx`).

---

## Task 1: `CloudError` contract

**Files:**

- Modify: `src/application/errors/AppError.ts`

- [ ] **Step 1: Add the `CloudError` class.** After the `AssetError` class (around line 34), add:

```ts
export class CloudError extends Data.TaggedError('CloudError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}
```

- [ ] **Step 2: Add `CloudError` to the `AppError` union.** In the `export type AppError = ... | BookError | AssetError` union, add `| CloudError`.

- [ ] **Step 3: Verify types.**

Run: `npx tsgo --noEmit`
Expected: no new errors (only the pre-existing `scripts/upload-cjk-fonts-r2.ts`).

- [ ] **Step 4: Commit.**

```bash
git add src/application/errors/AppError.ts
git commit -m "feat(effect): add CloudError tagged error"
```

---

## Task 2: `CloudService` Tag

**Files:**

- Create: `src/application/services/CloudService.ts`

- [ ] **Step 1: Write the Tag + Shape.** The shape mirrors the pure `cloudService.ts` fns / `appService` cloud wrappers. `ProgressHandler`/`BaseDir`/`Book`/`DeleteAction`/`BookMetadata` come from `@/domain/*`.

```ts
import { Context, type Effect } from 'effect';
import type { Book, BookMetadata } from '@/domain/book';
import type { BaseDir, DeleteAction } from '@/domain/system';
import type { ProgressHandler } from '@/domain/transfer';
import type { CloudError } from '@/application/errors/AppError';

export interface ReplicaFileOpts {
  readonly kind: string;
  readonly replicaId: string;
  readonly filename: string;
  readonly lfp: string;
  readonly base: BaseDir;
  readonly onProgress: ProgressHandler;
}

export interface ReplicaDownloadOpts {
  readonly kind: string;
  readonly replicaId: string;
  readonly filename: string;
  readonly lfp: string;
  readonly base: BaseDir;
  readonly onProgress?: ProgressHandler;
}

export interface CloudServiceShape {
  readonly uploadBook: (
    book: Book,
    onProgress?: ProgressHandler,
  ) => Effect.Effect<void, CloudError>;
  readonly downloadBook: (
    book: Book,
    onlyCover?: boolean,
    redownload?: boolean,
    onProgress?: ProgressHandler,
  ) => Effect.Effect<void, CloudError>;
  readonly downloadBookCovers: (books: Book[]) => Effect.Effect<void, CloudError>;
  readonly downloadCloudFile: (
    lfp: string,
    cfp: string,
    onProgress: ProgressHandler,
  ) => Effect.Effect<void, CloudError>;
  readonly uploadFileToCloud: (
    lfp: string,
    cfp: string,
    base: BaseDir,
    onProgress: ProgressHandler,
    hash: string,
    temp?: boolean,
  ) => Effect.Effect<string | undefined, CloudError>;
  readonly uploadReplicaFile: (opts: ReplicaFileOpts) => Effect.Effect<void, CloudError>;
  readonly downloadReplicaFile: (opts: ReplicaDownloadOpts) => Effect.Effect<void, CloudError>;
  readonly deleteReplicaBundle: (
    kind: string,
    replicaId: string,
    filenames: string[],
  ) => Effect.Effect<void, CloudError>;
  readonly deleteBook: (book: Book, deleteAction: DeleteAction) => Effect.Effect<void, CloudError>;
  readonly fetchBookDetails: (book: Book) => Effect.Effect<BookMetadata, CloudError>;
}

export class CloudService extends Context.Tag('app/CloudService')<
  CloudService,
  CloudServiceShape
>() {}
```

- [ ] **Step 2: Confirm `BookMetadata` is exported from `@/domain/book`.**

Run: `grep -n 'BookMetadata' src/domain/book.ts`
Expected: a `BookMetadata` export. (If it lives elsewhere, e.g. `@/domain/...`, fix the import.)

- [ ] **Step 3: Verify types.**

Run: `npx tsgo --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit.**

```bash
git add src/application/services/CloudService.ts
git commit -m "feat(effect): add CloudService tag and shape"
```

---

## Task 3: `CloudServiceLive` layer

**Files:**

- Create: `src/infra/shared/CloudService.layer.ts`

- [ ] **Step 1: Write the layer.** Depends only on `FileSystem` + `PathResolver`. `resolveFilePath` mirrors `appService.resolveFilePath` (= `resolver.absolute`). The legacy adapter doubles as `fs` and the minimal `appService` for the download fns.

```ts
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
```

- [ ] **Step 2: Confirm `bookService.fetchBookDetails` signature.**

Run: `sed -n '601,615p' src/services/bookService.ts`
Expected: `fetchBookDetails(fs, book, downloadBook)` where `downloadBook: (book: Book) => Promise<void>`. If the callback arity differs, adjust the inline lambda.

- [ ] **Step 3: Verify types.**

Run: `npx tsgo --noEmit`
Expected: no new errors. (If `CloudSvc.downloadBook`'s `appService`-vs-`fs` param order trips the `as unknown as AppService` cast, recheck against `cloudService.ts` lines 249-257.)

- [ ] **Step 4: Commit.**

```bash
git add src/infra/shared/CloudService.layer.ts
git commit -m "feat(effect): add CloudServiceLive layer reusing pure cloudService fns"
```

---

## Task 4: Runtime wiring

**Files:**

- Modify: `src/runtime/clientRuntime.ts`, `src/runtime/client-tauri.ts`, `src/runtime/client-web.ts`

- [ ] **Step 1: Add `CloudService` to the `ClientServices` union.** In `clientRuntime.ts`, add the import alongside the other service imports (after `DictionaryService`):

```ts
import type { CloudService } from '@/application/services/CloudService';
```

and add `| CloudService` to the `ClientServices` union (after `| DictionaryService`).

- [ ] **Step 2: Wire `CloudServiceLive` into `client-tauri.ts`.** Add the import (after `DictionaryServiceLive`):

```ts
import { CloudServiceLive } from '@/infra/shared/CloudService.layer';
```

and add `CloudServiceLive,` to the `Layer.mergeAll(...)` inside `SharedRepos` (alongside `FontServiceLive`, `ImageServiceLive`, `DictionaryServiceLive`). `CloudServiceLive` needs only `FileSystem` + `PathResolver`, both present in `SharedBaseWithCover`.

- [ ] **Step 3: Wire `CloudServiceLive` into `client-web.ts`.** Same two edits as Step 2, in the web runtime file.

- [ ] **Step 4: Verify the graph closes to `never`.**

Run: `npx tsgo --noEmit`
Expected: no new errors. A leftover requirement would surface as a `Layer<..., ..., R>` mismatch in `ManagedRuntime.make`.

- [ ] **Step 5: Run the runtime smoke test.**

Run: `npx vitest run src/__tests__/infra/clientRuntime.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/runtime/clientRuntime.ts src/runtime/client-tauri.ts src/runtime/client-web.ts
git commit -m "feat(effect): wire CloudService into client runtimes"
```

---

## Task 5: `CloudService` layer test

**Files:**

- Create: `src/__tests__/application/cloudService.test.ts`

- [ ] **Step 1: Write the failing test.** Mock `@/libs/storage` (the pure cloud fns call its network primitives) and run the live layer over a stub FileSystem + `TestPathResolver`. Asserts: `deleteBook` removes local files; `uploadBook` with no local files throws → `CloudError`; `downloadReplicaFile` resolves the dst before calling `downloadFile`; a storage rejection maps to `CloudError`.

```ts
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CloudService } from '@/application/services/CloudService';
import { CloudServiceLive } from '@/infra/shared/CloudService.layer';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { CloudError } from '@/application/errors/AppError';
import type { Book } from '@/domain/book';

// The pure cloudService fns call these network primitives — stub them so the
// layer test exercises only the fs/resolveFilePath wiring + error mapping.
vi.mock('@/libs/storage', () => ({
  uploadFile: vi.fn(async () => 'https://cdn/x'),
  uploadReplicaFile: vi.fn(async () => undefined),
  downloadFile: vi.fn(async () => ({})),
  deleteFile: vi.fn(() => undefined),
  createProgressHandler: () => () => {},
  batchGetDownloadUrls: vi.fn(async () => []),
}));
import * as storage from '@/libs/storage';

const baseResolver = Layer.provideMerge(TestPathResolverLive, PathStateLive);

const makeFs = (over: Partial<FileSystemShape> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    exists: () => Effect.succeed(false),
    removeFile: () => Effect.void,
    createDir: () => Effect.void,
    writeFile: () => Effect.void,
    openFile: (path: string) =>
      Effect.succeed(new File([new Uint8Array(8)], path.split('/').pop() ?? 'f')),
    ...over,
  } as unknown as FileSystemShape);

const mkLayer = (fs: Layer.Layer<FileSystem>) =>
  Layer.provide(CloudServiceLive, Layer.merge(fs, baseResolver));
const run = <A>(p: Effect.Effect<A, unknown, CloudService>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(mkLayer(fs))) as Effect.Effect<A, unknown, never>);

const book = { hash: 'h1', title: 'T', uploadedAt: Date.now() } as unknown as Book;

describe('CloudService (live over stub FileSystem, storage mocked)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploadBook throws CloudError when no local files exist', async () => {
    const err = (await run(
      Effect.flatMap(CloudService, (c) => c.uploadBook(book)).pipe(Effect.flip),
      makeFs({ exists: () => Effect.succeed(false) }),
    )) as CloudError;
    expect(err).toBeInstanceOf(CloudError);
    expect(err.operation).toBe('uploadBook');
  });

  it('deleteBook (local) removes the local book file', async () => {
    const removeFile = vi.fn(() => Effect.void);
    await run(
      Effect.flatMap(CloudService, (c) => c.deleteBook(book, 'local')),
      makeFs({ exists: () => Effect.succeed(true), removeFile }),
    );
    expect(removeFile).toHaveBeenCalled();
  });

  it('downloadReplicaFile resolves dst before downloading', async () => {
    await run(
      Effect.flatMap(CloudService, (c) =>
        c.downloadReplicaFile({
          kind: 'dictionary',
          replicaId: 'r1',
          filename: 'd.zip',
          lfp: 'r1/d.zip',
          base: 'Dictionaries',
        }),
      ),
      makeFs(),
    );
    expect(storage.downloadFile).toHaveBeenCalledTimes(1);
    const arg = (storage.downloadFile as unknown as vi.Mock).mock.calls[0]![0];
    expect(typeof arg.dst).toBe('string');
    expect(arg.dst).toContain('r1/d.zip'); // resolveFilePath prefixed it
  });

  it('maps a storage rejection to CloudError', async () => {
    (storage.deleteFile as unknown as vi.Mock).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    // deleteReplicaBundle swallows per-file errors internally, so use a path that
    // surfaces: deleteBook cloud branch calls deleteFile inside a try/catch too —
    // instead assert downloadBookCovers maps a thrown batchGetDownloadUrls.
    (storage.batchGetDownloadUrls as unknown as vi.Mock).mockRejectedValueOnce(new Error('boom'));
    const err = (await run(
      Effect.flatMap(CloudService, (c) => c.downloadBookCovers([book])).pipe(Effect.flip),
      makeFs(),
    )) as CloudError;
    expect(err).toBeInstanceOf(CloudError);
    expect(err.operation).toBe('downloadBookCovers');
  });
});
```

- [ ] **Step 2: Run to verify it passes** (the layer already exists from Task 3).

Run: `npx vitest run src/__tests__/application/cloudService.test.ts`
Expected: PASS (4 tests). If the `removeFile`/`exists` stub channels mismatch (`never` error channel), loosen the stub object type to `Record<string, unknown>` per the E3 dict-test note.

- [ ] **Step 3: Commit.**

```bash
git add src/__tests__/application/cloudService.test.ts
git commit -m "test(effect): cover CloudService layer wiring and error mapping"
```

---

## Task 6: Migrate `shareImport` (full DI unwind) + callers

**Files:**

- Modify: `src/libs/shareImport.ts`, `src/app/s/ShareLanding.tsx`, `src/hooks/useOpenShareLink.ts`

`ensureSharedBookLocal` is a non-React lib taking `appService` as a param. Drop the param; route all its `appService` calls through the runtime: `loadLibraryBooks`/`saveLibraryBooks` → `LibraryRepository.{load,save}`, `isBookAvailable` → `BookRepository.isAvailable`, `downloadBook` → `CloudService.downloadBook`.

- [ ] **Step 1: Add runtime imports to `shareImport.ts`.** At the top:

```ts
import { Effect } from 'effect';
import { getClientRuntime } from '@/runtime/clientRuntime';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { BookRepository } from '@/application/repositories/BookRepository';
import { CloudService } from '@/application/services/CloudService';
```

- [ ] **Step 2: Drop `appService` from the args type + destructure.** Remove the `appService: AppService;` field from `EnsureSharedBookLocalArgs` and the `appService,` from the destructure in `ensureSharedBookLocal({ ... })`. Remove the now-unused `import type { AppService } from '@/domain/system';` if nothing else uses it.

- [ ] **Step 3: Replace the four `appService` calls.** Define a small runner near the top of the fn body and swap:

```ts
const rt = getClientRuntime();
// was: const library = wasLibraryLoaded ? storeState.library : await appService.loadLibraryBooks();
const library = wasLibraryLoaded
  ? storeState.library
  : await rt.runPromise(Effect.flatMap(LibraryRepository, (r) => r.load()));
// ...
const persistLibrary = async () => {
  await rt.runPromise(Effect.flatMap(LibraryRepository, (r) => r.save(library)));
  if (wasLibraryLoaded) setLibrary(library);
};
// was: const bytesPresent = !!existing.downloadedAt && (await appService.isBookAvailable(existing));
const bytesPresent =
  !!existing.downloadedAt &&
  (await rt.runPromise(Effect.flatMap(BookRepository, (r) => r.isAvailable(existing))));
// was: await appService.downloadBook(existing, false, false, reportProgress);
await rt.runPromise(
  Effect.flatMap(CloudService, (c) => c.downloadBook(existing, false, false, reportProgress)),
);
// was: if (!(await appService.isBookAvailable(existing))) { ... }
if (!(await rt.runPromise(Effect.flatMap(BookRepository, (r) => r.isAvailable(existing))))) {
  throw new Error('Could not download shared book');
}
```

Apply the same `isAvailable`/`downloadBook`/`importBook`/`saveLibraryBooks` swaps to any remaining branches further down the file (the "import from another device" branch). For the `appService.importBook(...)` call in that branch, use the `importBooks` usecase: `await rt.runPromise(importBooksUsecase(library, [{ file: <path> }], { persist: false }))` and read its result — match the existing E2b call shape in `library/index.tsx:599`. Grep the file for every remaining `appService.` and convert each.

Run: `grep -n 'appService' src/libs/shareImport.ts`
Expected after edits: no matches.

- [ ] **Step 4: Update callers to drop the `appService` arg.**
  - `src/app/s/ShareLanding.tsx:93` — `await ensureSharedBookLocal({ token, importResult: result });` (remove `appService`).
  - `src/hooks/useOpenShareLink.ts:69` — `await ensureSharedBookLocal({ token, importResult: result });` (remove `appService`). Remove the now-unused `appService` source if it was only used here.

- [ ] **Step 5: Verify types + tests.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -5`
Expected: no new type errors. If a `shareImport` test mocked `appService.*`, rebridge it with `vi.mock('@/runtime/clientRuntime')` (faithful fake-layer doubles).

- [ ] **Step 6: Commit.**

```bash
git add src/libs/shareImport.ts src/app/s/ShareLanding.tsx src/hooks/useOpenShareLink.ts
git commit -m "refactor(effect): migrate shareImport off appService to CloudService/ports"
```

---

## Task 7: Migrate `ShareBookDialog` (cloud call only)

**Files:**

- Modify: `src/app/library/components/ShareBookDialog.tsx`

Partial: only `uploadBook` moves to `CloudService`. Keep `appService` for `getBookFileSize`/`isMobileApp`/`hasWindow` (out of scope).

- [ ] **Step 1: Add the runtime hook + imports.**

```ts
import { Effect } from 'effect';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { CloudService } from '@/application/services/CloudService';
```

and inside the component: `const runEffect = useRunEffect();`

- [ ] **Step 2: Replace the `uploadBook` call** (line ~100):

```ts
// was: if (!book.uploadedAt && appService) { await appService.uploadBook(book, (p)=>...) }
if (!book.uploadedAt) {
  try {
    await runEffect(
      Effect.flatMap(CloudService, (c) =>
        c.uploadBook(book, (progress) => {
          setUploadProgress((progress.progress / progress.total) * 100);
        }),
      ),
    );
  } finally {
    setUploadProgress(null);
  }
}
```

- [ ] **Step 3: Verify + commit.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -3`
Expected: no new errors.

```bash
git add src/app/library/components/ShareBookDialog.tsx
git commit -m "refactor(effect): route ShareBookDialog upload through CloudService"
```

---

## Task 8: Migrate `useBooksSync` + `library/index` downloadBook (cloud calls only)

**Files:**

- Modify: `src/app/library/hooks/useBooksSync.ts`, `src/app/library/index.tsx`

Both already have `runEffect`/`useRunEffect` and import other services — add `CloudService`.

- [ ] **Step 1: `useBooksSync.ts` — import `CloudService`** (alongside the existing `CoverService` import) and replace both `appService?.downloadBookCovers(batch)` calls (lines ~135, ~163):

```ts
// was: await appService?.downloadBookCovers(batch);
await runEffect(Effect.flatMap(CloudService, (c) => c.downloadBookCovers(batch)));
```

If `appService` becomes unused in the file, remove it from the `useEnv()` destructure; if still used elsewhere, leave it.

Run: `grep -n 'appService' src/app/library/hooks/useBooksSync.ts`
Expected: only remaining genuinely-non-cloud uses (or none).

- [ ] **Step 2: `library/index.tsx` — import `CloudService`** and replace the `downloadBook` call (line ~707) inside `handleBookDownload`:

```ts
// was: await appService?.downloadBook(book, false, redownload, (progress)=>...)
await runEffect(
  Effect.flatMap(CloudService, (c) =>
    c.downloadBook(book, false, redownload, (progress) => {
      updateBookTransferProgress(book.hash, progress);
    }),
  ),
);
```

Keep `appService` (still used elsewhere in `library/index.tsx`).

- [ ] **Step 3: Verify + commit.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -3`
Expected: no new errors. Rebridge any broken `useBooksSync`/library tests via `vi.mock('@/runtime/clientRuntime')`.

```bash
git add src/app/library/hooks/useBooksSync.ts src/app/library/index.tsx
git commit -m "refactor(effect): route book-sync covers + library download through CloudService"
```

---

## Task 9: Migrate `BookDetailModal` fetchBookDetails

**Files:**

- Modify: `src/components/metadata/BookDetailModal.tsx`

- [ ] **Step 1: Replace the inline `getAppService().fetchBookDetails`** (lines ~102-106). The component already has `runEffect` (it uses `BookRepository`). Import `CloudService` and:

```ts
// was:
//   const appService = await envConfig.getAppService();
//   let details = book.metadata || null;
//   if (!details && book.downloadedAt) { details = await appService.fetchBookDetails(book); }
let details = book.metadata || null;
if (!details && book.downloadedAt) {
  details = await runEffect(Effect.flatMap(CloudService, (c) => c.fetchBookDetails(book)));
}
```

Remove the now-unused `const appService = await envConfig.getAppService();` line if `appService` is unused in the effect (verify the surrounding lines).

- [ ] **Step 2: Verify + commit.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -3`
Expected: no new errors.

```bash
git add src/components/metadata/BookDetailModal.tsx
git commit -m "refactor(effect): route BookDetailModal fetchBookDetails through CloudService"
```

---

## Task 10: Migrate `discord` util (full DI unwind) + caller

**Files:**

- Modify: `src/utils/discord.ts`, `src/hooks/useDiscordPresence.ts`

`updateDiscordPresence` receives `appService`. It uses `exists`/`writeFile`/`getImageURL` (FileSystem), `resolveFilePath` (PathResolver), `uploadFileToCloud` (CloudService). Drop the `appService` param; call the runtime internally (E1b util pattern). `getImageURL` is the sync `getUrl` port → use `Effect.runSync`.

- [ ] **Step 1: Add runtime imports + a small helper to `discord.ts`.**

```ts
import { Effect } from 'effect';
import { getClientRuntime } from '@/runtime/clientRuntime';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { CloudService } from '@/application/services/CloudService';
```

Remove `import type { AppService } from '@/domain/system';` (now unused).

- [ ] **Step 2: Drop `appService` from `updateDiscordPresence`/`getCoverUrlForDiscord` signatures** and convert each call inside `getCoverUrlForDiscord`:

```ts
const rt = getClientRuntime();
// was: const exists = await appService.exists(fp, 'Books');
const exists = await rt.runPromise(Effect.flatMap(FileSystem, (fs) => fs.exists(fp, 'Books')));
// was: const cachedExists = await appService.exists(cacheKey, 'Cache');
const cachedExists = await rt.runPromise(
  Effect.flatMap(FileSystem, (fs) => fs.exists(cacheKey, 'Cache')),
);
// was: const downloadUrl = await appService.uploadFileToCloud(cacheKey, cacheKey, 'Cache', () => {}, book.hash, true);
const downloadUrl = await rt.runPromise(
  Effect.flatMap(CloudService, (c) =>
    c.uploadFileToCloud(cacheKey, cacheKey, 'Cache', () => {}, book.hash, true),
  ),
);
// was: const fullPath = await appService.resolveFilePath(fp, 'Books');
const fullPath = await rt.runPromise(Effect.flatMap(PathResolver, (r) => r.absolute(fp, 'Books')));
// was: const coverUrl = await appService.getImageURL(fullPath);
const coverUrl = rt.runSync(Effect.flatMap(FileSystem, (fs) => fs.getUrl(fullPath)));
// was: await appService.writeFile(cacheKey, 'Cache', arrayBuffer);
await rt.runPromise(
  Effect.flatMap(FileSystem, (fs) => fs.writeFile(cacheKey, 'Cache', arrayBuffer)),
);
```

Apply the same `uploadFileToCloud` swap to the second occurrence (line ~80).

Run: `grep -n 'appService' src/utils/discord.ts`
Expected: no matches.

- [ ] **Step 3: Update the caller.** `src/hooks/useDiscordPresence.ts:48` — `await updateDiscordPresence(book, sessionStartRef.current);` (drop `appService`). Remove the unused `appService` source if it was only used here.

- [ ] **Step 4: Verify + commit.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -3`
Expected: no new errors. `rt.runSync` requires the `getUrl` port to be synchronous (`Effect.try`) — it is on both platforms (see `fsPortAdapter.getURL`).

```bash
git add src/utils/discord.ts src/hooks/useDiscordPresence.ts
git commit -m "refactor(effect): migrate discord presence off appService to ports/CloudService"
```

---

## Task 11: Migrate `autoDownload` (full unwind) + callers

**Files:**

- Modify: `src/services/opds/autoDownload.ts`, plus its callers (search below)

`downloadAndImport(item, catalog, appService, books)` uses `resolveFilePath` (PathResolver), `downloadFile({appService})` (storage — needs `writeFile`), `copyFile`/`deleteFile` (FileSystem), `importBook` (importBooks usecase). Drop `appService` from all fns in this file; thread the runtime instead.

- [ ] **Step 1: Add imports.**

```ts
import { Effect } from 'effect';
import { getClientRuntime } from '@/runtime/clientRuntime';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { importBooks as importBooksUsecase } from '@/application/usecases/book';
```

- [ ] **Step 2: Build the minimal storage writer.** `libs/storage.downloadFile` needs only `appService.writeFile`. Near the top of `downloadAndImport`:

```ts
const rt = getClientRuntime();
// downloadFile (libs/storage) reaches only appService.writeFile; back it by the runtime.
const writer = {
  writeFile: (path: string, base: BaseDir, content: ArrayBuffer) =>
    rt.runPromise(Effect.flatMap(FileSystem, (fs) => fs.writeFile(path, base, content))),
} as unknown as AppService;
```

Keep `import type { AppService, BaseDir } from '@/domain/system';` (still referenced by the cast + `BaseDir`).

- [ ] **Step 3: Convert the calls.**

```ts
// was: let dstFilePath = await appService.resolveFilePath(filename, 'Cache');
let dstFilePath = await rt.runPromise(
  Effect.flatMap(PathResolver, (r) => r.absolute(filename, 'Cache')),
);
// downloadFile:
const responseHeaders = await downloadFile({
  appService: writer,
  dst: dstFilePath,
  cfp: '',
  url: downloadUrl,
  headers,
  singleThreaded: true,
});
// probed-filename branch:
const newFilePath = await rt.runPromise(
  Effect.flatMap(PathResolver, (r) => r.absolute(probedFilename, 'Cache')),
);
await rt.runPromise(
  Effect.flatMap(FileSystem, (fs) => fs.copyFile(dstFilePath, 'None', newFilePath, 'None')),
);
await rt.runPromise(Effect.flatMap(FileSystem, (fs) => fs.removeFile(dstFilePath, 'None')));
dstFilePath = newFilePath;
// importBook -> importBooks usecase (single input, no persist; mirror library/index:599 shape):
const { imported, failed } = await rt.runPromise(
  importBooksUsecase(books, [{ file: dstFilePath }], { persist: false, saveBook: false }),
);
const book = imported[0];
if (!book)
  throw new Error(failed[0]?.error?.message ?? `importBook returned null for ${item.title}`);
```

Confirm the `ImportBookInput`/`ImportBooksResult` field names against `src/application/usecases/book/importBooks.ts` (Step in Task 13 references the same usecase) — adjust `{ file: ... }`/`imported`/`failed` to the actual property names.

Run: `grep -n 'appService' src/services/opds/autoDownload.ts`
Expected: only the `writer`-cast comment / `AppService` type usage; no `appService.` method calls.

- [ ] **Step 4: Update callers to drop the `appService` arg.**

Run: `grep -rn 'downloadAndImport\|autoDownload\|processSubscription' src --include=*.ts --include=*.tsx | grep -v 'autoDownload.ts:'`
For each call site that passes `appService` into a now-changed function, remove that argument. Also drop `appService` from the other exported fns in `autoDownload.ts` (lines ~127, ~229) that only thread it down to `downloadAndImport`.

- [ ] **Step 5: Verify + commit.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -5`
Expected: no new errors. Rebridge `autoDownload`/OPDS tests via `vi.mock('@/runtime/clientRuntime')` if they mocked `appService`.

```bash
git add src/services/opds/autoDownload.ts <changed-callers>
git commit -m "refactor(effect): migrate opds autoDownload off appService to ports/usecase"
```

---

## Task 12: Migrate `opds/index` deleteFile

**Files:**

- Modify: `src/app/opds/index.tsx`

- [ ] **Step 1: Replace the temp-file delete** (line ~493). The component already has a runtime path (it uses usecases). Replace `appService?.deleteFile(dstFilePath, 'None')` with:

```ts
await runEffect(Effect.flatMap(FileSystem, (fs) => fs.removeFile(dstFilePath, 'None')));
```

Add the `FileSystem` import if missing. Keep `appService` if used elsewhere in the file.

- [ ] **Step 2: Verify + commit.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -3`
Expected: no new errors.

```bash
git add src/app/opds/index.tsx
git commit -m "refactor(effect): route opds temp-file delete through FileSystem port"
```

---

## Task 13: Migrate `backupService` (full unwind, no cloud) + callers

**Files:**

- Modify: `src/services/backupService.ts`, plus callers (search below)

`backupService` has **no cloud calls** — it's a multi-port FileSystem/usecase migration. Map each `appService` method:

| `appService.X`                  | Replacement (via `getClientRuntime().runPromise`)                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `loadLibraryBooks()`            | `Effect.flatMap(LibraryRepository, (r) => r.load())`                                            |
| `saveLibraryBooks(b)`           | `Effect.flatMap(LibraryRepository, (r) => r.save(b))`                                           |
| `resolveFilePath(p, base)`      | `Effect.flatMap(PathResolver, (r) => r.absolute(p, base))`                                      |
| `readDirectory(p, base)`        | `Effect.flatMap(FileSystem, (fs) => fs.readDir(p, base))`                                       |
| `readFile(p, base, mode)`       | `Effect.flatMap(FileSystem, (fs) => fs.readFile(p, base, mode))`                                |
| `writeFile(p, base, c)`         | `Effect.flatMap(FileSystem, (fs) => fs.writeFile(p, base, c))`                                  |
| `exists(p, base)`               | `Effect.flatMap(FileSystem, (fs) => fs.exists(p, base))`                                        |
| `createDir(p, base)`            | `Effect.flatMap(FileSystem, (fs) => fs.createDir(p, base))`                                     |
| `importBook(path, books, opts)` | `importBooksUsecase(books, [{ file: path }], { ...opts, persist: false })` → read `imported[0]` |
| `saveFile(name, data, opts)`    | `Effect.flatMap(Dialog, (d) => d.saveFile(name, data, opts))`                                   |

- [ ] **Step 1: Add imports.**

```ts
import { Effect } from 'effect';
import { getClientRuntime } from '@/runtime/clientRuntime';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Dialog } from '@/application/ports/Dialog';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { importBooks as importBooksUsecase } from '@/application/usecases/book';
```

- [ ] **Step 2: Drop the `appService: AppService` param** from every exported fn in the file, and add `const rt = getClientRuntime();` at the top of each fn body. Convert each `appService.X(...)` per the table (e.g. `const books = await rt.runPromise(Effect.flatMap(LibraryRepository, (r) => r.load()));`). For `readFile` with the `'text'`/`'binary'` mode + cast, preserve the existing `as string` / `as ArrayBuffer` casts on the result.

For the `importBook` call (line ~304): match the `importBooks` usecase result shape (confirm field names in `src/application/usecases/book/importBooks.ts`). The legacy call returns a single `Book | undefined`; adapt to `(await rt.runPromise(importBooksUsecase(currentBooks, [{ file: filePath }], { overwrite: true, persist: false }))).imported[0]`. If `ImportBooksOptions` has no `overwrite`, thread it via the input object — check the interface.

Run: `grep -n 'appService' src/services/backupService.ts`
Expected: no matches (the `import type { AppService }` line removed too).

- [ ] **Step 3: Update callers to drop the `appService` arg.**

Run: `grep -rn 'restoreFromBackup\|createBackup\|backupService\|exportBackup\|importBackup' src --include=*.ts --include=*.tsx | grep -v 'backupService.ts:'`
Remove `appService` from each call site (e.g. `BackupWindow`/settings). Drop now-unused `appService` sources.

- [ ] **Step 4: Verify + commit.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -5`
Expected: no new errors. Rebridge `backupService` tests via `vi.mock('@/runtime/clientRuntime')` if present.

```bash
git add src/services/backupService.ts <changed-callers>
git commit -m "refactor(effect): migrate backupService off appService to ports/usecase"
```

---

## Task 14: Rewire `transferManager` off appService

**Files:**

- Modify: `src/services/transferManager.ts`, `src/hooks/useTransferQueue.ts`

`transferManager` uses `appService` ONLY for 6 cloud calls + readiness guards. Route the 6 through `CloudService`; switch the guards to `isInitialized`/`getLibrary && updateBook`.

- [ ] **Step 1: Add imports to `transferManager.ts`.**

```ts
import { Effect } from 'effect';
import { getClientRuntime } from '@/runtime/clientRuntime';
import { CloudService } from '@/application/services/CloudService';
```

- [ ] **Step 2: Remove the `appService` field + initialize param.**
  - Delete `private appService: AppService | null = null;` (line ~23).
  - `initialize(getLibrary, updateBook, translationFn)` — drop the `appService: AppService` param and the `this.appService = appService;` line.
  - `isReady()` → `return this.isInitialized;` (line ~65).
  - `executeTransfer` guard (line ~303) → `if (!this.getLibrary || !this.updateBook) {`.
  - Remove the now-unused `AppService` import if nothing else in the file references it (`BaseDir` is still used).

- [ ] **Step 3: Replace the 6 cloud calls** with `getClientRuntime().runPromise(Effect.flatMap(CloudService, ...))`:

```ts
// upload (was: await this.appService!.uploadBook(book, progressHandler);)
await getClientRuntime().runPromise(
  Effect.flatMap(CloudService, (c) => c.uploadBook(book, progressHandler)),
);
// download (was: await this.appService!.downloadBook(book, false, false, progressHandler);)
await getClientRuntime().runPromise(
  Effect.flatMap(CloudService, (c) => c.downloadBook(book, false, false, progressHandler)),
);
// delete book (was: await this.appService!.deleteBook(book, 'cloud');)
await getClientRuntime().runPromise(
  Effect.flatMap(CloudService, (c) => c.deleteBook(book, 'cloud')),
);
// delete replica bundle (was: await this.appService!.deleteReplicaBundle(kind, replicaId, files.map(f=>f.logical));)
await getClientRuntime().runPromise(
  Effect.flatMap(CloudService, (c) =>
    c.deleteReplicaBundle(
      kind,
      replicaId,
      files.map((f) => f.logical),
    ),
  ),
);
// upload replica (was: await this.appService!.uploadReplicaFile(kind, replicaId, file.logical, file.lfp, base, fileProgressHandler(file.byteSize));)
await getClientRuntime().runPromise(
  Effect.flatMap(CloudService, (c) =>
    c.uploadReplicaFile({
      kind,
      replicaId,
      filename: file.logical,
      lfp: file.lfp,
      base,
      onProgress: fileProgressHandler(file.byteSize),
    }),
  ),
);
// download replica (was: await this.appService!.downloadReplicaFile(kind, replicaId, file.logical, file.lfp, base, fileProgressHandler(file.byteSize));)
await getClientRuntime().runPromise(
  Effect.flatMap(CloudService, (c) =>
    c.downloadReplicaFile({
      kind,
      replicaId,
      filename: file.logical,
      lfp: file.lfp,
      base,
      onProgress: fileProgressHandler(file.byteSize),
    }),
  ),
);
```

(Note: the `uploadReplicaFile`/`downloadReplicaFile` opts object replaces the old positional args — the method takes a single opts param.)

- [ ] **Step 4: Update `useTransferQueue.ts:25`** — drop the `appService` arg:

```ts
await transferManager.initialize(getLibrary, updateBookFn, translationFn);
```

Leave the surrounding `if (appService && envConfig)` guard as-is (it still gates init on boot readiness; `appService` from `useEnv` remains a valid signal during legacy boot).

- [ ] **Step 5: Verify + tests.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -5`
Expected: no new errors. The `transferManager` test (if any) and any test that calls `initialize(...)` must drop the `appService` arg and `vi.mock('@/runtime/clientRuntime')` to supply a fake `CloudService` (faithful fake-layer double, per E2a).

Run: `grep -rln "transferManager" src/__tests__`
For each hit, update `initialize` calls + add the clientRuntime mock.

- [ ] **Step 6: Commit.**

```bash
git add src/services/transferManager.ts src/hooks/useTransferQueue.ts <changed-tests>
git commit -m "refactor(effect): rewire transferManager cloud ops through CloudService"
```

---

## Task 15: Rewire `replicaTransferIntegration` off appService

**Files:**

- Modify: `src/services/sync/replicaTransferIntegration.ts`, `src/context/EnvContext.tsx`

Only `appServiceRef.openFile` is used — a pure FileSystem-port swap.

- [ ] **Step 1: Add imports.**

```ts
import { Effect } from 'effect';
import { getClientRuntime } from '@/runtime/clientRuntime';
import { FileSystem } from '@/application/ports/FileSystem';
```

Remove `import type { AppService } from '@/domain/system';` if unused after the edits.

- [ ] **Step 2: Drop the `appServiceRef` module var + guard.**
  - Delete `let appServiceRef: AppService | null = null;`.
  - In `handleReplicaUpload`, delete `if (!appServiceRef) return;`.
  - Replace `const file = await appServiceRef!.openFile(f.lfp, base);` with:

```ts
const file = await getClientRuntime().runPromise(
  Effect.flatMap(FileSystem, (fs) => fs.openFile(f.lfp, base)),
);
```

- [ ] **Step 3: Drop the param from `startReplicaTransferIntegration`** — `export const startReplicaTransferIntegration = (): void => {` and remove `appServiceRef = appService;`. In `__resetReplicaTransferIntegrationForTests`, remove `appServiceRef = null;`.

- [ ] **Step 4: Update the boot site** `src/context/EnvContext.tsx:34` — `startReplicaTransferIntegration();` (drop `service`).

- [ ] **Step 5: Verify + tests.**

Run: `npx tsgo --noEmit && npx vitest run src/__tests__ --silent 2>&1 | tail -5`
Expected: no new errors. Any `replicaTransferIntegration` test that called `startReplicaTransferIntegration(fakeAppService)` drops the arg and (if it asserted on `openFile`) mocks `@/runtime/clientRuntime`.

Run: `grep -rln "replicaTransferIntegration\|startReplicaTransferIntegration" src/__tests__`
Update each hit.

- [ ] **Step 6: Commit.**

```bash
git add src/services/sync/replicaTransferIntegration.ts src/context/EnvContext.tsx <changed-tests>
git commit -m "refactor(effect): rewire replicaTransferIntegration openFile through FileSystem port"
```

---

## Task 16: Full verification + memory update

- [ ] **Step 1: Full lint + type check.**

Run: `pnpm lint`
Expected: Biome clean (or only base-branch pre-existing residue) + tsgo only the pre-existing `scripts/upload-cjk-fonts-r2.ts` error. No Rust/Lua files touched, so `fmt:check`/`clippy:check`/`test:lua` are not required.

- [ ] **Step 2: Full test suite.**

Run: `pnpm test`
Expected: all pass except the known env-flaky set (opds-req/hardcover/edgeTTS/turso-node). Investigate any NEW failure — likely a missed test-rebridge.

- [ ] **Step 3: Confirm cloud consumers are off `getAppService` for cloud ops.**

Run: `grep -rn 'appService.*\(uploadBook\|downloadBook\|downloadBookCovers\|uploadFileToCloud\|uploadReplicaFile\|downloadReplicaFile\|deleteReplicaBundle\|fetchBookDetails\)' src --include=*.ts --include=*.tsx | grep -v 'appService.ts\|cloudService.ts\|domain/system.ts'`
Expected: no matches (the wrappers in `appService.ts`/`cloudService.ts` + the `domain/system.ts` interface remain — they are E5's to delete).

- [ ] **Step 4: Update project memory.** Append an `E4 DONE` paragraph to `project_effect_client_foundation.md` (commits, decisions, gotchas) and refresh the "NOT done" line to point at E5 only.

- [ ] **Step 5: Final commit (if memory/docs changed).**

```bash
git add docs/superpowers
git commit -m "docs(effect): record E4 completion"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Tasks 1-5 = CloudService + error + wiring + test (spec §1-4, §Testing). Tasks 6-9 = clean book-level consumers (spec §5). Tasks 10 = discord (spec §5). Tasks 11-13 = deferred E2b files, full migration (spec §6, user-confirmed). Tasks 14-15 = singleton rewiring (spec §7). Task 16 = verification (spec §Verification).
- **Type consistency:** `CloudServiceShape` method names + the `ReplicaFileOpts`/`ReplicaDownloadOpts` opts objects defined in Task 2 are reused verbatim in Tasks 3 and 14. `importBooksUsecase` result fields (`imported`/`failed`) referenced in Tasks 11/13 must be confirmed against `src/application/usecases/book/importBooks.ts` before relying on them.
- **Watch items:** the `as unknown as AppService` casts (Task 3 layer, Task 11 writer) are the only "trust me" seams — both are justified because only `.writeFile` is reached. Every full-DI-unwind task (6, 10, 11, 13, 14, 15) ends with a `grep` gate proving the file no longer calls `appService.*`.

```

```
