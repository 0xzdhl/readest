# Effect Client Migration — E2b: Import/Export usecases + library.json consolidation

**Date:** 2026-06-09
**Branch:** `effect/domain-type-migration`
**Predecessor:** E2a (Book/Library/Cover data layer + ~10 consumers, commits `710a201d..8198ac5a`)
**Status:** design approved

## Context

The client-side Effect TS track is migrating consumers off the legacy
`AppService` god-object onto ports/usecases, incrementally and additively (the
old `getAppService()` boot path stays live until E5). E2a delivered the
Book/Library/Cover data layer: `BookRepository`, `LibraryRepository`,
`CoverService` (ports in `src/application/`, live layers in
`src/infra/shared/*.layer.ts` that reuse the pure `@/services/{bookService,
libraryService}` functions via `makeLegacyFsAdapter`).

E2a left two threads open that E2b closes:

1. **Import/export orchestration** still goes through `appService.importBook`
   and `appService.exportBook`. `bookService.importBook` needs two callbacks
   (`saveBookConfig`, `generateCoverImageUrl`) that map exactly onto
   `BookRepository.saveConfig` + `CoverService.generateCoverImageUrl`.
   `bookService.exportBook` needs three (`resolveFilePath`, `copyFile`,
   `saveFile`) that map onto `PathResolver.absolute` + `FileSystem.copyFile` +
   `Dialog.saveFile`.
2. **`library.json` is dual-written.** Legacy `appService.saveLibraryBooks` is
   still called from `app/library/index`, `Bookshelf`, `GroupingModal`,
   `useBooksSync`, `opds/index`, `StorageManager`, `shareImport`,
   `backupService`; the new `LibraryRepository.save` is used by `useLibrary`,
   `libraryStore`, `bookDataStore`, `SettingsMenu`, `BackupWindow`,
   `StorageManager`, `useOPDSSubscriptions`. Same file, no conflict today, but
   path-specific sync hooks (E4) require a single write path first.

## Scope

**In (Local-UI + OPDS):**

- New `importBooks` usecase (combined import-loop + optional library persist).
- New `exportBook` usecase.
- Consolidate `library.json` writes in the migrated consumers onto
  `LibraryRepository.save`.
- Migrate cluster-3 consumers:
  `app/library/index.tsx` (`importBooks`, `processOpenWithFiles`, demoBooks
  effect), `app/library/components/Bookshelf.tsx`,
  `app/opds/index.tsx` (`handleDownload`, `handleStream`),
  `app/library/hooks/useDemoBooks.ts`,
  `app/library/components/GroupingModal.tsx`,
  `app/library/hooks/useBooksSync.ts`,
  `app/reader/components/annotator/Annotator.tsx`,
  `src/components/metadata/BookDetailModal.tsx`,
  plus the `StorageManager.tsx` leftover `saveLibraryBooks` call.

**Out (deferred to E4 — cloud/share/auto-download):**

- `src/libs/shareImport.ts`
- `src/services/backupService.ts`
- `src/services/opds/autoDownload.ts`

**Non-goals:**

- No new ports or infra layers — `importBooks`/`exportBook` are pure
  orchestration over the ports/repos that already exist and are wired into the
  client runtimes.
- No behavior changes inside `bookService` (faithful reuse).
- Signature cleanup of deferred `_envConfig` store params stays deferred.

## Design

### 1. `importBooks` usecase — `src/application/usecases/book/importBooks.ts`

```ts
export interface ImportBookInput {
  file: string | File;
  path?: string;        // for directory imports: source path of the file
  basePath?: string;    // for directory imports: selected root
}

export interface ImportBooksOptions {
  transient?: boolean;
  saveBook?: boolean;
  saveCover?: boolean;
  overwrite?: boolean;
  concurrency?: number;          // default 4 (matches legacy batch size)
  persist?: boolean;             // default true; save library.json at the end
  // Called synchronously per successfully-imported file, BEFORE it is counted
  // into the batch. The consumer uses it for store-coupled grouping (the
  // legacy getGroupId/getGroupName are libraryStore methods, so grouping
  // cannot live in the usecase).
  onImported?: (book: Book, input: ImportBookInput) => void;
  onBatch?: (imported: Book[]) => void; // incremental UI hook, fired per batch
}

export interface ImportBooksResult {
  library: Book[];
  imported: Book[];
  failed: Array<{ filename: string; error: unknown }>;
}

export const importBooks = (
  books: Book[],
  inputs: ReadonlyArray<ImportBookInput>,
  options?: ImportBooksOptions,
): Effect.Effect<
  ImportBooksResult,
  BookError,
  BookRepository | CoverService | FileSystem | PathResolver | LibraryRepository
>
```

Implementation:

- `const fs = makeLegacyFsAdapter(yield* FileSystem, yield* PathResolver)`.
- `const bookRepo = yield* BookRepository; const cover = yield* CoverService;
const library = yield* LibraryRepository`.
- Build the injected callbacks from the **resolved** shapes (R = `never`, so
  `Effect.runPromise` is valid — the exact pattern E2a's `LibraryRepositoryLive`
  uses for its cover callback):
  - `saveBookConfig = (b, c) => Effect.runPromise(bookRepo.saveConfig(b, c))`
  - `generateCoverImageUrl = (b) => Effect.runPromise(cover.generateCoverImageUrl(b))`
- Build the lookup index once: `buildBookLookupIndex(books)`.
- Loop over `inputs` in batches of `concurrency`. Each file is wrapped in
  `Effect.tryPromise({ try: () => bookService.importBook(fs, file, books,
{ lookupIndex, saveBook, saveCover, overwrite, transient, saveBookConfig,
generateCoverImageUrl }), catch: err })`, run via
  `Effect.either` so a single failure records into `failed` without aborting the
  batch (faithful to the legacy per-file try/catch).
- After each book imports successfully, call `onImported?.(book, input)` (the
  consumer applies grouping here, since `getGroupId`/`getGroupName` are
  `libraryStore` methods).
- After each batch, call `onBatch?.(importedThisBatch)`.
- After all batches, if `persist !== false && imported.length > 0`:
  `yield* library.save(books)`.
- Return `{ library: books, imported, failed }`.

Notes:

- `books` is mutated in place and pushed to by `bookService.importBook` — this
  is faithful to legacy; the usecase owns that array and persists _it_.
- Concurrency=4 over a shared `books`/`lookupIndex` mirrors the legacy
  `Promise.all` batch (the legacy code already accepts that intra-batch race).
- `transferManager.queueUpload` (autoUpload) is a session concern and stays in
  the consumer, which post-processes `result.imported`.

### 2. `exportBook` usecase — `src/application/usecases/book/exportBook.ts`

```ts
export const exportBook = (
  book: Book,
): Effect.Effect<boolean, BookError, FileSystem | PathResolver | Dialog>
```

Implementation:

- `const fs = makeLegacyFsAdapter(yield* FileSystem, yield* PathResolver)`.
- `const fsPort = yield* FileSystem; const resolver = yield* PathResolver;
const dialog = yield* Dialog`.
- Callbacks:
  - `resolveFilePath = (path, base) => Effect.runPromise(resolver.absolute(path, base))`
  - `copyFile = (s, sb, d, db) => Effect.runPromise(fsPort.copyFile(s, sb, d, db))`
  - `saveFile = (filename, content, opts) => Effect.runPromise(
dialog.saveFile(filename, content, opts).pipe(Effect.map(Option.isSome)))`
    (`Dialog.saveFile` returns `Option<string>`; legacy `exportBook` expects a
    `boolean` "saved?" — `Option.isSome` is the faithful mapping.)
- Wrap `bookService.exportBook(fs, book, resolveFilePath, copyFile, saveFile)`
  in `Effect.tryPromise({ try, catch: err })` → `BookError`. Inner
  `PlatformError` rejections (from the Dialog/FS `runPromise` calls) surface as
  rejected promises that `tryPromise` folds into `BookError`.

### 3. library.json consolidation

| Consumer                                   | Today                                                              | After E2b                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library/index.tsx` `importBooks`          | loop `appService.importBook` + final `appService.saveLibraryBooks` | `importBooks(..., {persist:false, onImported: grouping, onBatch: updateBooks skipSave})` then own `LibraryRepository.save(useLibraryStore.getState().library)` |
| `library/index.tsx` `processOpenWithFiles` | loop import + `saveLibraryBooks`                                   | `importBooks(..., {transient, persist:true})`                                                                                                                  |
| `library/index.tsx` demoBooks effect       | `saveLibraryBooks(newLibrary)`                                     | `LibraryRepository.save(newLibrary)`                                                                                                                           |
| `Bookshelf.tsx`                            | import + `saveLibraryBooks`                                        | `importBooks([{file:url}], {persist:true})`                                                                                                                    |
| `opds/index.tsx` `handleDownload`          | import + `saveLibraryBooks`                                        | `importBooks([{file}], {persist:true})`                                                                                                                        |
| `opds/index.tsx` `handleStream`            | import transient (no save)                                         | `importBooks([{file}], {transient:true, persist:false})`                                                                                                       |
| `useDemoBooks.ts`                          | `importBook(url, [], {saveBook:false})` ×N                         | `importBooks([], urls, {saveBook:false, persist:false})`                                                                                                       |
| `GroupingModal.tsx`                        | `saveLibraryBooks`                                                 | `LibraryRepository.save`                                                                                                                                       |
| `useBooksSync.ts`                          | `saveLibraryBooks`                                                 | `LibraryRepository.save`                                                                                                                                       |
| `StorageManager.tsx` leftover              | `saveLibraryBooks`                                                 | `LibraryRepository.save`                                                                                                                                       |
| `Annotator.tsx`                            | `appService.exportBook`                                            | `exportBook` usecase                                                                                                                                           |
| `BookDetailModal.tsx`                      | `appService.exportBook`                                            | `exportBook` usecase                                                                                                                                           |

The `library/index.importBooks` `persist:false` escape exists because the legacy
code persists `useLibraryStore.getState().library` (post-`updateBooks` store
state), which diverges from the `books` array the usecase mutates: `updateBooks`
**replaces** the store array (`Array.from(new Map([...library, ...books]))`),
not mutates it in place. The explicit consumer-side save of store state
preserves exact behavior. Either way the write routes through
`LibraryRepository.save`, never `appService`.

### 4. Running the effects

React consumers run usecases via `useRunEffect` from `EffectRuntimeProvider`
(falls back to the `getClientRuntime()` singleton outside the provider). The
usecases' requirement unions are all members of `ClientServices`
(`BookRepository | CoverService | FileSystem | PathResolver | LibraryRepository |
Dialog`), already wired into `client-tauri`/`client-web` runtimes in E2a/E1.

## Testing

Test-first per repo rule:

- **`importBooks`**: drive against the test runtime with fake
  `BookRepository`/`CoverService`/`LibraryRepository`/`FileSystem`/`PathResolver`
  layers. Cover: single import + persist, batch import with `onBatch`,
  `persist:false` skips `LibraryRepository.save`, a failing file records into
  `failed` without aborting the batch, `onImported`/`onBatch` fire with the
  right books, `transient` flow.
- **`exportBook`**: fake `Dialog.saveFile` returning `some`/`none` →
  `true`/`false`; `PlatformError` from saveFile folds to `BookError`.
- **Consumer rebridge**: migrated React consumers pull the runtime graph at test
  collection (E2a gotcha). Add `vi.mock('@/runtime/clientRuntime')` where
  collection breaks — faithful fake repo layers with `vi.hoisted` spies, or a
  no-op stub when the test doesn't exercise the path.

Verification gates (from `.claude/rules/verification.md`): `pnpm test`,
`pnpm lint`. No `src-tauri/` or koplugin Lua changes expected.

## Risks

- **Intra-batch race** on shared `books`/`lookupIndex` at concurrency 4 — present
  in legacy already; mirrored, not introduced.
- **Store/usecase library divergence** in `library/index` — mitigated by the
  `persist:false` + consumer-side save of store state.
- **Test collection graph pull** — known E2a pattern; `vi.mock` the bridge.

```

```
