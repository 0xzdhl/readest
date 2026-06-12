# E6c — CloudService de-adapter (design)

**Date:** 2026-06-12
**Branch:** `effect/domain-type-migration`
**Predecessors:** E6a (Settings de-adapter, the template) —
`2026-06-11-effect-e6a-settings-deadapter-design.md`; E6b (Font/Image/Dict) —
`2026-06-12-effect-e6b-font-image-dict-deadapter-design.md`.

## Goal

E6 removes the `makeLegacyFsAdapter` compatibility shim service-by-service. E6c
de-adapters **CloudService**: the cloud transfer functions (currently pure
Promise-based fns in `src/services/cloudService.ts` consumed through
`makeLegacyFsAdapter` in `CloudService.layer.ts`) are rewritten as Effect-native
code that `yield* FileSystem` / `yield* PathResolver`, and the layer drops
`makeLegacyFsAdapter` for those methods, `provideService`-ing the two ports
instead (the SettingsRepository.layer pattern).

CloudService is more involved than the E6a/E6b services because it has two seams
that the asset services did not:

1. **`libs/storage`** (`uploadFile`/`downloadFile`/`uploadReplicaFile`/
   `deleteFile`/`batchGetDownloadUrls`) is the network-IO layer. It stays
   Promise-based and **out of E6 scope**. The Effect-native cloud fns wrap its
   calls in `Effect.tryPromise`. Its `downloadFile` needs a `FileWriter`
   callback (it calls exactly one method, `appService.writeFile`) — supplied as
   a **one-method inline bridge** built from the port
   (`{ writeFile: (p,b,c) => Effect.runPromise(fs.writeFile(p,b,c)) }`), **not**
   `makeLegacyFsAdapter`.

2. **`fetchBookDetails`** delegates to `bookService.fetchBookDetails` +
   `loadBookContent`, which still require a full legacy `FileSystem`. bookService
   de-adaptering is **E6d**, and `BookRepository` exposes no equivalent
   (`refreshMetadata` returns `boolean`, not metadata). So this **one** method
   keeps a single, clearly-commented `makeLegacyFsAdapter` bridge until E6d.
   (Decision: keep the isolated bridge rather than build a throwaway partial
   inline shim — lowest churn, honest about the genuine Cloud→Book coupling. The
   substance of E6c — all cloud IO — still goes Effect-native.)

## Non-goals / explicitly untouched

- `src/infra/shared/fsPortAdapter.ts` (`makeLegacyFsAdapter`), the legacy
  `FileSystem` interface / `FileWriter` in `@/domain/system`, and the
  `@/domain/system` module itself **stay as-is**. After E6c the
  `makeLegacyFsAdapter` import **remains** in `CloudService.layer.ts` but is
  scoped to `fetchBookDetails` only. The `makeLegacyFsAdapter` **consumer** count
  is therefore unchanged at **6** — Book / Library / Cover / Cloud layers +
  `exportBook` / `importBooks` usecases (CloudService.layer still counts, via the
  one `fetchBookDetails` bridge) — plus the `fsPortAdapter.ts` definition itself.
  Full removal is E6d–E6e.
- `src/libs/storage.ts` — the network primitives stay Promise-based and
  unchanged (network IO, not a filesystem adapter). Its `appService: FileWriter`
  param surface is untouched.
- `src/services/bookService.ts` (`fetchBookDetails`, `loadBookContent`) — stays
  legacy; migrated in E6d.
- The application-service **tag** `CloudService`
  (`src/application/services/CloudService.ts`), its `CloudServiceShape`,
  `ReplicaFileOpts` / `ReplicaDownloadOpts`, and `CloudError`
  (`src/application/errors/AppError.ts`) — unchanged. Every method signature and
  error channel (`Effect.Effect<…, CloudError>`) is byte-identical before and
  after; consumers (BookDetailModal, transferManager, replicaTransferIntegration,
  shareImport, …) are untouched.
- `src/services/constants.ts` (`CLOUD_BOOKS_SUBDIR`, `CLOUD_REPLICAS_SUBDIR`) —
  unchanged; the new module imports them.

## Architecture

One new Effect-native module under `src/application/services/cloud/`, mirroring
E6b's `application/services/{fonts,images,dictionaries}/`:

- **`src/application/services/cloud/cloudTransfers.ts`** — the nine cloud fns
  rewritten Effect-native, plus the pure `replicaCloudKey` helper:
  `uploadBook`, `downloadBook`, `downloadBookCovers`, `downloadCloudFile`,
  `uploadFileToCloud`, `uploadReplicaFileToCloud`, `downloadReplicaFileFromCloud`,
  `deleteReplicaBundleFromCloud`, `deleteBook`.

`src/services/cloudService.ts` is **deleted** — its only importers are
`CloudService.layer.ts` (rewired) and `src/__tests__/services/cloud-service.test.ts`
(repointed). `replicaCloudKey` has no external consumers (verified by grep), so
it moves into the new module.

### Effect-native rewrite pattern (per E6b)

Each fn is `(...) => Effect.gen(function* () { const fs = yield* FileSystem; … })`,
requiring `FileSystem | PathResolver` in its `R`. Faithful, mechanical mapping of
the existing `src/services/cloudService.ts` logic:

- Port fs ops become `yield*`: `fs.exists` / `fs.removeFile` / `fs.createDir` /
  `fs.openFile` / `fs.writeFile`.
- `resolveFilePath(path, base)` → `yield* resolver.absolute(path, base)`.
- `localBooksDir` → `yield* resolver.prefix('Books')` (each fn that needs it
  yields it itself; faithful to the layer's cached snapshot).
- **`libs/storage` calls stay Promise-based**, wrapped in `Effect.tryPromise`:
  `uploadFile`, `uploadReplicaFile`, `batchGetDownloadUrls`, and `downloadFile`.
  `deleteFile` (sync-ish network) stays inside the best-effort branches.
- **`downloadFile`'s `FileWriter`** is built inline from the yielded port:
  `const writer: FileWriter = { writeFile: (p,b,c) => Effect.runPromise(fs.writeFile(p,b,c)) }`.
  This is the intrinsic write seam to the Promise storage layer (the same
  `Effect.runPromise(fs.writeFile)` that `makeLegacyFsAdapter.writeFile` did),
  reduced to the single method `downloadFile` actually calls.
- Non-port async (`File.arrayBuffer()`, `ClosableFile.close()`) → `Effect.promise`
  / `Effect.tryPromise`.
- **Parallelism**: legacy `Promise.all` (in `downloadBookCovers` — the
  create-dir pass and the per-file download pass) → `Effect.all(…, { concurrency: 'unbounded' })`.

### Faithfulness nuances (preserve exactly)

- **Best-effort swallows** must NOT become `CloudError`. Legacy `try/catch`
  log-and-continue branches become `Effect.catchAll((e) => Effect.sync(() => console.log(…, e)))`
  inside the fn (so they stay swallowed before the top-level `mapError`):
  - `deleteBook` cloud-delete loop (`Failed to delete uploaded file`).
  - `downloadBook` cover-download branch (`Failed to download cover file for
book: <title>` — book download still proceeds; `finally` increments
    `completedFiles.count` when `needDownCover`).
  - `downloadBookCovers` per-file download loop (`Failed to download cover file
for book: <lfp>`).
  - `deleteReplicaBundleFromCloud` per-file loop (`Failed to delete replica
file <cfp>`).
- **`uploadBook` "not uploaded" failure**: legacy `throw new Error('Book file
not uploaded')` → `Effect.fail(new Error(…))` (or yield\* a failing effect),
  which the top-level `mapError` turns into `CloudError({operation:'uploadBook'})`
  — identical to today, where `Effect.tryPromise` already maps the throw to
  CloudError.
- **Mutation of the `book` object** (timestamps: `downloadedAt`, `uploadedAt`,
  `coverDownloadedAt`, `deletedAt`, `updatedAt`) is preserved verbatim — these
  fns mutate the passed `Book` in place; consumers depend on it.
- **Error mapping**: one top-level `.pipe(Effect.mapError(err('<op>')))` per fn,
  where `err = (operation) => (cause) => new CloudError({ operation, cause })`.
  Mirrors E6b's single top-level `mapError`.
- `console.log` progress/info lines (`Uploading file:`, `Downloading file:`,
  `Uploading replica file:`) are preserved (legacy parity), matching how E6a
  intentionally dropped logs only when typed errors replaced them — here the
  network seam is unchanged, so the logs stay.

## Layer rewrite — `src/infra/shared/CloudService.layer.ts`

```
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

    // fetchBookDetails only: temporary bridge to the not-yet-migrated
    // bookService (loadBookContent needs a full legacy FileSystem). Removed in
    // E6d when bookService de-adapters.
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
      uploadReplicaFile: (opts) => provide(CloudTransfers.uploadReplicaFile(opts)),
      downloadReplicaFile: (opts) => provide(CloudTransfers.downloadReplicaFile(opts)),
      deleteReplicaBundle: (kind, replicaId, filenames) =>
        provide(CloudTransfers.deleteReplicaBundle(kind, replicaId, filenames)),
      deleteBook: (book, deleteAction) => provide(CloudTransfers.deleteBook(book, deleteAction)),
      fetchBookDetails: (book) =>
        Effect.tryPromise({
          try: () =>
            BookSvc.fetchBookDetails(legacyFs, book, (b) =>
              // run the new Effect-native downloadBook through the resolved ports
              Effect.runPromise(provide(CloudTransfers.downloadBook(b))),
            ),
          catch: err('fetchBookDetails'),
        }),
    } satisfies CloudServiceShape;
  }),
);
```

Notes:

- The 9 cloud methods are now `provide(fn(...))`. The layer no longer threads
  `fs` / `resolveFilePath` / `writer` into Promise fns — that wiring moves inside
  each Effect-native fn.
- `downloadReplicaFile`'s dst-resolve-before-download (current layer comment, the
  `resolveFilePath(opts.lfp, opts.base)` step) moves **inside**
  `CloudTransfers.downloadReplicaFile`: `const dst = yield* resolver.absolute(opts.lfp, opts.base)`
  then call the network download — same ordering, faithful.
- `fetchBookDetails` keeps `Effect.tryPromise` + `legacyFs` + `BookSvc`. Its
  injected downloadBook callback now runs the new Effect-native `downloadBook`
  via `provide` (`R=never` → `Effect.runPromise` valid), replacing the old
  `CloudSvc.downloadBook(writer, fs, localBooksDir, b)` Promise call.

## Tests

- **`src/__tests__/application/cloudService.test.ts`** (live layer over a stub
  `FileSystem` port, `@/libs/storage` mocked) — the **primary regression guard**.
  It tests through `CloudServiceShape`, which is unchanged, so it is expected to
  **pass unchanged**. Its four cases (`uploadBook` no-files → CloudError;
  `deleteBook` local removeFile; `downloadReplicaFile` resolves dst before
  download; storage rejection → CloudError) directly exercise the rewrite.
- **`src/__tests__/services/transfer-manager.test.ts`** and
  **`src/__tests__/services/sync/replicaTransferIntegration.test.ts`** — mock at
  the `@/runtime/clientRuntime` boundary with fake `CloudService` / `FileSystem`
  layers; agnostic to `CloudService.layer` internals → **pass unchanged**.
- **`src/__tests__/services/cloud-service.test.ts`** — currently imports
  `deleteBook` from `@/services/cloudService` and drives it with a legacy
  `FileSystem` mock. Since that module is deleted, this test is **repointed** to
  exercise the new Effect-native `deleteBook` through a stub `FileSystem` layer
  (Layer.succeed(FileSystem, stub) over TestPathResolver, the E6b layer-test
  pattern), preserving **every** assertion (local/both/cloud delete actions,
  timestamp mutations, best-effort swallow on cloud-delete failure). Storage
  primitives (`deleteFile`) mocked as today.
- Optionally extend `application/cloudService.test.ts` with a case for the
  `downloadBook` cover-swallow branch (best-effort), to lock the catchAll
  behavior — only if it falls out cheaply; not required for parity.

## Verification (done-conditions)

1. `pnpm lint` — tsgo **0-new** (only the pre-existing `scripts/upload-cjk-fonts-r2.ts`
   baseline error); Biome clean (only the pre-existing `SettingsDialog.tsx` lazy
   baseline).
2. `pnpm test` — the cloud test surface
   (`application/cloudService.test.ts` + repointed `services/cloud-service.test.ts`
   - `transfer-manager.test.ts` + `replicaTransferIntegration.test.ts`) green;
     full suite green minus the known env/timer-flaky set (auth-page,
     useBookShortcuts, theme-store import-time env, ProgressBar/ReadingRuler timer,
     clientRuntime/edgeTTS/opds-req sandbox, hardcover) — none E6c-touched.
3. **Grep gate**: `rg "@/services/cloudService" src` → empty (file deleted, all
   importers repointed). `rg "makeLegacyFsAdapter" src/infra/shared/CloudService.layer.ts`
   → exactly 1 hit (the `fetchBookDetails` bridge), commented.
4. `CloudServiceShape` unchanged (diff the tag file — should be no change).

## Execution

Subagent-driven-development per the E6a/E6b template: per-task implementer →
spec-review → code-quality-review; whole-slice review before SHIP. TDD where it
fits (the repointed `cloud-service.test.ts` is written/repointed first and run to
confirm it exercises the new fn). Kept as-is on `effect/domain-type-migration`,
not pushed.

## Sequencing context

E6c is the third E6 slice. After it: **E6d** (Book / Library / Cover layers —
which also retires the `fetchBookDetails` legacy bridge and the 3 layers'
`makeLegacyFsAdapter`) and **E6e** (delete `makeLegacyFsAdapter` + `fsPortAdapter.ts`

- `persistence.ts` + `LegacyFileSystem`, plus the `exportBook` / `importBooks`
  usecases' adapter usage).
