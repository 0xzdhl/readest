# E4 — Sync/Cloud: CloudService + singleton rewiring (Effect migration)

**Branch:** `effect/domain-type-migration`
**Status:** design approved 2026-06-10
**Predecessors:** E1 (portable-consumer migration), E1b (DI-pattern unwind), E2a (Book/Library/Cover data layer), E2b (import/export usecases), E3 (Cover/Font/Image/Dictionary asset services) — all done.

## Goal

Migrate the cloud/replica transfer surface off the legacy `getAppService()` god-object onto the Effect ports/services architecture, reusing the existing pure `src/services/cloudService.ts` functions verbatim via `makeLegacyFsAdapter` — the same pattern E2a/E3 used for `CoverService`/`FontService`. This is the heaviest domain. Strictly additive at the data layer: the legacy `appService` cloud wrappers and their `domain/system.ts` interface entries stay live until E5; but unlike E3, E4 also rewires the stateful boot singletons (`transferManager`, `replicaTransferIntegration`) off `appService` so that E5 has no cloud-related boot coupling left to unwind.

In scope:

- **`CloudService`** — new Effect Tag + live layer covering the full cloud surface (book transfer + replica binary transfer + `fetchBookDetails`), reusing the pure `cloudService.ts` fns.
- **`CloudError`** — new `Data.TaggedError` in `application/errors`.
- **Book-level direct consumers** — migrate `shareImport`, `ShareBookDialog`, `discord`, `useBooksSync`, `library/index` (downloadBook), `BookDetailModal` (fetchBookDetails).
- **Deferred E2b files** — `backupService` (FileSystem-port migration; no cloud calls) and `autoDownload`/`opds` `deleteFile` (→ `FileSystem.removeFile`).
- **Stateful singletons** — rewire `transferManager` (6 cloud calls → CloudService) and `replicaTransferIntegration` (`openFile` → FileSystem port) off `appService`.

Out of scope (stays on legacy — E5 god-object removal):

- The `appService.{uploadBook,downloadBook,downloadBookCovers,downloadCloudFile,uploadFileToCloud,uploadReplicaFile,downloadReplicaFile,deleteReplicaBundle,deleteBook,fetchBookDetails}` wrappers and their `domain/system.ts` interface declarations.
- `EnvContext`/`useTransferQueue` as boot wiring — E4 only removes their `appService` _argument_ to the migrated singletons, not the legacy boot gate itself (that dissolves in E5 when BootApp goes authoritative).
- `replicaBinaryUpload.ts` — already on the FileSystem port (no change).

## Why this shape (decision log)

- **Service, not usecase.** The pure cloud fns take a _legacy_ `FileSystem`, constructible only via `makeLegacyFsAdapter(fsPort, resolver)`, which lives in `infra/`. Usecases must not import `infra/`. So the adapter is built inside an infra layer → `CloudService` is a `Context.Tag` with a live layer, identical to `CoverService`/`FontService`. (The brief's word "usecases" resolves to a service here, as in E3.)
- **One legacy adapter doubles as `fs` and `appService`.** The download fns (`downloadBook`/`downloadBookCovers`/`downloadCloudFile`/`downloadReplicaFileFromCloud`) take an `appService` param, but it is threaded only into `downloadFile` (`libs/storage.ts`), which uses exactly one method: `appService.writeFile(dst, 'None', …)`. `makeLegacyFsAdapter` already produces a legacy `FileSystem` with `writeFile`, so the same adapter object serves as both the `fs` and the minimal `appService` argument, cast `as unknown as AppService` with a comment. No new adapter surface.
- **New `CloudError`, not reused `BookError`.** Cloud transfer failures are network/transfer failures distinct from book-data failures; the pure fns currently throw plain `Error`s (e.g. `'Book file not uploaded'`). One `Data.TaggedError('CloudError')<{operation, cause}>`, mirroring E3's `AssetError` shape (each domain family gets one error). (Considered: reuse `BookError` like `CoverService` — rejected; conflates transfer with data errors across a large surface.)
- **`fetchBookDetails` is a CloudService method, not a separate usecase.** `bookService.fetchBookDetails(fs, book, downloadBook)` needs both a legacy `fs` and a `downloadBook` callback. The `CloudService` layer already has both (the adapter + its own `downloadBook`), so the method injects its own `downloadBook` — no extra usecase/port. This is the "fetchBookDetails's downloadBook" coupling from the brief.
- **Migrate the singletons now (vs defer to E5).** User-chosen. `transferManager` is the only consumer of the replica-binary methods; `replicaTransferIntegration` the only `openFile` cloud consumer. Both couple to `appService` _only_ for these calls, so the E1b unwind ("drop the param, call the bridge internally") applies cleanly. Doing it here keeps E5 a pure deletion (no cloud rewiring under the boot flip). Coexistence stays safe because `appService` wrappers and `CloudService` wrap the identical pure fns.
- **`replicaBinaryUpload` untouched.** It already does `getClientRuntime().runPromise(Effect.flatMap(FileSystem, fs => fs.openFile(...)))` (migrated in E1). The actual replica upload happens later in `transferManager.executeReplicaTransfer`, which this slice migrates.

## Components

### 1. Error contract — `src/application/errors/AppError.ts`

```ts
export class CloudError extends Data.TaggedError('CloudError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}
```

### 2. `CloudService` Tag — `src/application/services/CloudService.ts`

`Context.Tag('app/CloudService')` with a separate `CloudServiceShape` interface. Methods return `Effect<…, CloudError>` (R = never once layered). Signatures mirror the pure fns / `appService` wrappers:

| Method                                                                               | Reuses (`cloudService.ts`)                                                                         | Notes                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `uploadBook(book, onProgress?)`                                                      | `uploadBook(fs, resolveFilePath, book, onProgress?)`                                               | throws `'Book file not uploaded'` → `CloudError`      |
| `downloadBook(book, onlyCover?, redownload?, onProgress?)`                           | `downloadBook(appService, fs, localBooksDir, …)`                                                   | legacy adapter = both `fs` & `appService`             |
| `downloadBookCovers(books)`                                                          | `downloadBookCovers(appService, fs, localBooksDir, books)`                                         |                                                       |
| `downloadCloudFile(lfp, cfp, onProgress)`                                            | `downloadCloudFile(appService, localBooksDir, …)`                                                  |                                                       |
| `uploadFileToCloud(lfp, cfp, base, onProgress, hash, temp?)` → `string \| undefined` | `uploadFileToCloud(…)`                                                                             | `discord` calls with `temp=true`                      |
| `uploadReplicaFile(opts)`                                                            | `uploadReplicaFileToCloud(fs, resolveFilePath, opts)`                                              | `opts: {kind,replicaId,filename,lfp,base,onProgress}` |
| `downloadReplicaFile(opts)`                                                          | resolve `dst = resolveFilePath(lfp, base)` then `downloadReplicaFileFromCloud(appService, {…dst})` | replicates `appService.ts:311` dst-resolve step       |
| `deleteReplicaBundle(kind, replicaId, filenames)`                                    | `deleteReplicaBundleFromCloud(…)`                                                                  | no `fs`                                               |
| `deleteBook(book, deleteAction)`                                                     | `deleteBook(fs, book, deleteAction)`                                                               | cloud + local                                         |
| `fetchBookDetails(book)` → `BookMetadata`                                            | `bookService.fetchBookDetails(fs, book, downloadBook)`                                             | injects the layer's own `downloadBook`                |

### 3. Live layer — `src/infra/shared/cloudService.layer.ts`

Mirrors `CoverServiceLive`: depends on **FileSystem + PathResolver + Platform**. Builds `legacy = makeLegacyFsAdapter(fsPort, resolver)`, `resolveFilePath = (path, base) => resolver.absolute(...)`, and snapshots `localBooksDir` from `resolver.prefix('Books')` + `platform.info` (same as Cover). Each method = `Effect.tryPromise({ try: () => <pureFn>(...), catch: (cause) => new CloudError({ operation, cause }) })`. The download methods pass `legacy as unknown as AppService` (only `.writeFile` is reached) and `legacy` as `fs`.

### 4. Runtime wiring

- Add `CloudService` to the `ClientServices` union in `src/runtime/clientRuntime.ts` (consumers' `runEffect`/`runPromise` are typed by this union, separate from layer composition — E2a gotcha).
- Add `CloudServiceLive` to `SharedRepos` in both `src/runtime/client-tauri.ts` and `client-web.ts`. It needs Platform/PathResolver/FileSystem already present; confirm composition resolves to `never` via tsgo.

### 5. Book-level consumer migration

Pattern: `runEffect(Effect.flatMap(CloudService, c => c.method(...)))` (via `useRunEffect()` in components; `getClientRuntime().runPromise(...)` in non-React modules).

- `libs/shareImport.ts:78` → `downloadBook`
- `app/library/components/ShareBookDialog.tsx:100` → `uploadBook`
- `utils/discord.ts:57,80` → `uploadFileToCloud` (`temp=true`). discord currently receives `appService`; unwind (E1b): drop the param, call the runtime internally, update callers.
- `app/library/hooks/useBooksSync.ts:135,163` → `downloadBookCovers`
- `app/library/index.tsx:707` → `downloadBook`
- `components/metadata/BookDetailModal.tsx:106` → `fetchBookDetails`

### 6. Deferred-E2b file migration

- `services/backupService.ts` — no cloud calls; migrate its local `appService` file I/O to the FileSystem port (E1 style).
- `services/opds/autoDownload.ts:83` + `app/opds/index.tsx:493` — `deleteFile(dst, 'None')` → `FileSystem.removeFile` (not cloud).

### 7. Singleton rewiring

- **`services/transferManager.ts`**: remove `private appService`. Replace the 6 calls (`uploadBook` 421, `downloadBook` 425, `deleteBook` 429, `deleteReplicaBundle` 444, `uploadReplicaFile` 479, `downloadReplicaFile` 502) with `getClientRuntime().runPromise(Effect.flatMap(CloudService, c => c.X(...)))`. `initialize()` drops its `appService` param. Readiness guards: `isReady()` (65) → `isInitialized`; `executeTransfer` guard (303) → `getLibrary && updateBook`. Update the sole caller `hooks/useTransferQueue.ts:25`.
- **`services/sync/replicaTransferIntegration.ts`**: remove `appServiceRef`. `handleReplicaUpload`'s `appServiceRef.openFile(f.lfp, base)` (52) → `getClientRuntime().runPromise(Effect.flatMap(FileSystem, fs => fs.openFile(f.lfp, base)))`. `startReplicaTransferIntegration()` drops its param. Update boot site `context/EnvContext.tsx:34`.

## Decomposition (commits)

1. `CloudError` + `CloudService` Tag (application).
2. `cloudService.layer.ts` (infra) + runtime wiring (union + both client runtimes) + layer tests.
3. Migrate book-level direct consumers (shareImport, ShareBookDialog, discord, useBooksSync, library/index, BookDetailModal) — cluster commits as natural.
4. backupService + autoDownload/opds `deleteFile` → FileSystem port.
5. Singleton rewiring: `transferManager` (+ `useTransferQueue`).
6. Singleton rewiring: `replicaTransferIntegration` (+ `EnvContext`).
7. Verify.

## Testing

- **Layer test** (`src/__tests__/...cloudService.layer.test.ts`): `Layer.succeed(FileSystem, stub)` over `TestPathResolver` + `PathState` (+ Platform). Per-method success path + failure mapping (`FsError`/rejected promise → `CloudError`). Cover specifically: `downloadReplicaFile`'s dst-resolve branch; `uploadBook`'s `'Book file not uploaded'` throw → `CloudError`; `deleteBook` cloud-vs-local branches. Stub override param `Partial<FileSystemShape>` (loosen to `Record<string,unknown>` if an `exists`/`never`-channel mismatch arises, per E3); failure mocks use `FsError`, not bare `Error`.
- **Test-rebridge**: migrating `transferManager`/stores pulls the runtime graph (`client-*` → `cloudService` → `errors` → `opdsReq`) in at collection, breaking partial-mock tests — fix by `vi.mock('@/runtime/clientRuntime')` (faithful fake-layer doubles with `vi.hoisted` spies, or a no-op stub where the path isn't exercised), per E2a.
- Run the new + runtime + migrated tests deterministically; full-suite residual failures expected to be the known env-flaky set (opds-req/hardcover/edgeTTS/turso-node), all outside this change set.

## Risks / faithful-behavior notes

- **transferManager readiness.** Keep the "not ready until `initialize()`" semantics so queued transfers don't fire pre-boot; the guard simply stops keying off `appService` presence.
- **Progress callbacks.** `onProgress` handlers are plain fn args threaded into the pure fns — they pass through `Effect.tryPromise` unchanged.
- **deleteReplicaBundle / downloadBookCovers swallow per-file errors** internally (try/catch in the pure fns); the `CloudError` wrap only catches a top-level throw — faithful to legacy.
- **`EnvContext`/`useTransferQueue`** are legacy boot wiring that fully dissolves in E5; E4 only drops the `appService` argument passed to the migrated singletons.

## Verification (done-conditions)

`pnpm test`, `pnpm lint` (Biome + tsgo) — baseline carries the known pre-existing `scripts/upload-cjk-fonts-r2.ts` tsgo error and any base-branch biome residue; no _new_ errors. No Rust/Lua files touched.
