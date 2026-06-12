# E6d-2 — Import/Export + Library de-adapter (design)

**Date:** 2026-06-12
**Branch:** `effect/domain-type-migration`
**Predecessors:** E6a (Settings, the template); E6b (Font/Image/Dict); E6c (Cloud);
E6d-1 (Cover + Book-data) — `2026-06-12-effect-e6d1-cover-bookdata-deadapter-design.md`.

## Goal

E6 removes the `makeLegacyFsAdapter` compat shim service-by-service. E6d-2 is the
second half of the Book/Library/Cover work (E6d-1 did Cover + Book-data). It
de-adapters the **final three** `makeLegacyFsAdapter` consumers —
`importBooks` usecase, `exportBook` usecase, `LibraryRepository.layer` — to
Effect-native code, then **deletes `bookService.ts` and `libraryService.ts`**.

After E6d-2: `makeLegacyFsAdapter` has **zero** consumers (only its definition in
`fsPortAdapter.ts`), and `persistence.ts` has zero users — both deleted in **E6e**
(the cleanup slice), per the agreed sequencing.

## Non-goals / explicitly untouched

- `src/infra/shared/fsPortAdapter.ts` (`makeLegacyFsAdapter`), `src/services/persistence.ts`,
  the legacy `FileSystem`/`FileWriter` in `@/domain/system` — **left as-is** (E6e
  deletes them once E6d-2 removes their last users: `persistence.ts`'s last user
  is `libraryService.ts`, deleted here; `makeLegacyFsAdapter`'s last 3 consumers
  are cleared here).
- The application tags/shapes — `CoverService`, `BookRepository`,
  `LibraryRepository`/`LibraryRepositoryShape`, `Dialog`, `BookError` — **unchanged**.
  The `importBooks`/`exportBook` usecase **public method signatures** (params +
  success/error types) are unchanged (`importBooks(books, inputs, options)` →
  `Effect<ImportBooksResult, BookError, …>`; `exportBook(book)` → `Effect<boolean, BookError, …>`).
  Their `R` requirement set may **narrow** (e.g. `importBooks` drops `PathResolver`,
  since the de-adaptered `importBook` needs only `FileSystem | CoverService | BookRepository`);
  narrowing is safe — the runtime provides all ports. `exportBook`'s `R`
  (`FileSystem | PathResolver | Dialog`) is unchanged.
- The E6d-1 modules (`cover/coverImages.ts`, `book/bookData.ts`) — unchanged;
  `bookData.loadBookContent` is reused by the new `exportBook`.

## Architecture

### New modules

**`src/application/services/book/bookImport.ts`** — Effect-native port of the
import path (legacy `bookService.ts:42-55, 147-208, 223-485`):

- `buildBookLookupIndex(books)` — pure, **moved verbatim** (no fs). Consumed by
  the `importBooks` usecase (repointed) + `import-metahash.test` (repointed).
- `mergeBooks(books, book, lookupIndex?)` — internal Effect-native helper yielding
  `FileSystem` (`exists`/`readFile`/`removeDir`). Per-config `JSON.parse` corrupt
  guard → `Effect.either`/`catchAll`-ignore (faithful to legacy `try{}catch{}`);
  best-progress reduce + booknote dedup + soft-delete duplicates preserved.
- `importBook(file, books, options)` — the ~260-line port. **Per the E6d framing,
  it `yield*`s `FileSystem` + `CoverService` + `BookRepository` directly** instead
  of taking the legacy `saveBookConfig`/`generateCoverImageUrl` callbacks:
  - the `saveBookConfigFn(book, INIT_BOOK_CONFIG)` calls → `yield* bookRepo.saveConfig(book, INIT_BOOK_CONFIG)`,
  - the `generateCoverImageUrlFn(book)` call → `yield* cover.generateCoverImageUrl(book)`,
  - all direct fs ops (openFile/exists/createDir/writeFile/copyFile/removeDir,
    incl. the migrate-config `fs.writeFile(getConfigFilename, JSON.stringify(...))`
    branches) → `yield* fs.*`,
  - non-port async (`DocumentLoader.open`, `partialMd5`, `file.arrayBuffer`,
    `getCover`, `svg2png`, `TxtToEpubConverter.convert`, `ClosableFile.close`) →
    `Effect.tryPromise`.
    `options` keeps `{ saveBook?, saveCover?, overwrite?, transient?, lookupIndex? }`
    (the callbacks are removed). The fn maps to `BookError({operation:'importBook', bookId, cause})`
    at its boundary (faithful to the usecase's current `catch`). **No dependency
    cycle**: `BookRepository.layer`/`CoverService.layer` do not import `bookImport`.

**`src/application/services/library/libraryData.ts`** — Effect-native port of
`libraryService.ts`:

- `loadLibraryBooks` → `Effect<Book[], …, FileSystem | CoverService>`: `exists('','Books')`→`createDir`;
  `safeLoadJsonE<Book[]>(getLibraryFilename(), 'Books', [])`; then for each book
  (concurrency 20, mirroring legacy `processInBatches`) `book.coverImageUrl = yield* cover.generateCoverImageUrl(book)` +
  `book.updatedAt ??= book.lastUpdated || Date.now()`.
- `saveLibraryBooks(books)` → `Effect<void, …, FileSystem>`: strip `coverImageUrl`,
  `safeSaveJsonE(getLibraryFilename(), 'Books', libraryBooks)`.

### Relocate the json helpers

`safeLoadJsonE`/`safeSaveJsonE` (the E6a `persistence.ts` Effect mirror) move
`src/application/services/settings/json.ts` → **`src/application/services/shared/json.ts`**
(`git mv`), since both Settings and Library now consume them. Update the two
importers: `settings/systemSettings.ts` (`./json` → `@/application/services/shared/json`)
and `__tests__/application/settingsJson.test.ts`. Behavior/exports unchanged.

### Layer & usecase rewrites

- **`importBooks` usecase** (`application/usecases/book/importBooks.ts`): drop
  `makeLegacyFsAdapter` + the `saveBookConfig`/`generateCoverImageUrl` callback
  wrappers + `fsPort`/`resolver`/`fs`. `buildBookLookupIndex` from `bookImport`.
  `importOne` becomes `BookImport.importBook(input.file, books, {…}).pipe(Effect.either, …)`
  (importBook is already an `Effect`, so the `Effect.tryPromise` wrapper is gone;
  the `Either` failure-boxing + `failed.push(result.left.cause)` recording is
  preserved — `result.left` is now a `BookError`, so `.cause` still unwraps the
  original). The usecase's `R` gains nothing new (it already requires
  `BookRepository | CoverService | FileSystem | LibraryRepository`; `PathResolver`
  drops if nothing else needs it — verify).
- **`exportBook` usecase** (`application/usecases/book/exportBook.ts`): rewrite
  Effect-native, **eliminating `bookService.exportBook`**. `const { file } = yield* BookData.loadBookContent(book)`;
  `content = yield* Effect.tryPromise(() => file.arrayBuffer())`; `filename = ${makeSafeFilename(book.title)}.${format.toLowerCase()}`;
  `filePath = yield* resolver.absolute(getLocalBookFilename(book), 'Books')`;
  if `getFilename(filePath) !== filename` → `yield* fs.copyFile(filePath, 'None', filename, 'Temp')` + `filePath = yield* resolver.absolute(filename, 'Temp')`;
  `saved = yield* dialog.saveFile(filename, content, {filePath, mimeType}).pipe(Effect.map(Option.isSome))`.
  Drop `makeLegacyFsAdapter` + `BookSvc`. Maps to `BookError({operation:'exportBook', bookId, cause})`.
  Requires `FileSystem | PathResolver | Dialog` (unchanged).
- **`LibraryRepository.layer`** (`infra/shared/LibraryRepository.layer.ts`): drop
  `makeLegacyFsAdapter` + the `generateCoverImageUrl` runPromise wrapper. `provide`
  over `FileSystem | CoverService`. `load` → `provide(LibraryData.loadLibraryBooks)`,
  `save` → `provide(LibraryData.saveLibraryBooks(books))`, each `.pipe(mapError → BookError('loadLibrary'/'saveLibrary'))`
  (faithful to today's `catch`). Keeps `yield* CoverService` (libraryData.load needs it).

### Deletes

- `src/services/bookService.ts` — after `importBooks` + `exportBook` are off it
  (its last two production importers) and `buildBookLookupIndex` is moved.
- `src/services/libraryService.ts` — after `LibraryRepository.layer` is off it.

(`persistence.ts` becomes dead — its only user `libraryService.ts` is gone — but
it is deleted in **E6e** per the agreed sequencing, not here.)

## Tests

- **`src/__tests__/services/import-metahash.test.ts`** (16 assertions, heaviest
  repoint) — repoint onto the Effect-native `importBook`. Replace the `mockFs`
  (legacy-shape vi.fns) + local `importBook` callback-wrapper with: a stub
  `FileSystem` port layer (vi.fn methods returning Effects — the E6c
  `cloud-service.test` pattern), a stub `CoverService` (`generateCoverImageUrl`→`''`),
  and a stub `BookRepository` (`saveConfig` spy that writes config via the
  FileSystem stub, mirroring the old real `saveBookConfig`). Drive
  `BookImport.importBook(file, books, opts)` through these layers. Preserve every
  assertion (metaHash match/override, new-hash update, single-entry library,
  soft-delete, dir cleanup). DocumentLoader/`partialMd5` mocks unchanged.
- **`src/__tests__/application/book/importBooks.test.ts`** — repoint the `vi.mock`
  target `@/services/bookService` → `@/application/services/book/bookImport`. The
  mock `importBook` becomes an `Effect.gen` that `yield*`s `BookRepository` +
  `CoverService` (calling `saveConfig`/`generateCoverImageUrl`) and pushes the
  book — so the usecase's loop/persist/batch/failure/onImported/onBatch assertions
  still hold. `buildBookLookupIndex` also re-exported from the new module (keep it
  real). The usecase no longer injects callbacks.
- **`src/__tests__/application/book/exportBook.test.ts`** — repoint: the usecase
  no longer calls `bookService.exportBook`. Mock `@/application/services/book/bookData`'s
  `loadBookContent` to return a stub `{ book, file }` (an in-memory `File`); test
  the usecase's `resolveFilePath`/`copyFile`/`saveFile` wiring over `Dialog` +
  `FileSystem` + `PathResolver` stubs. Preserve the 3 assertions (saved
  `Option.some`→true; cancelled `Option.none`→false; `saveFile` `PlatformError`→reject).
- **`src/__tests__/application/libraryRepository.test.ts`** — unchanged; it already
  provides `CoverService` and tests `LibraryRepositoryShape` (unchanged) → stays
  green as the regression guard.
- **`src/__tests__/application/settingsJson.test.ts`** — update the import path to
  `@/application/services/shared/json` (relocation only; assertions unchanged).

## Verification (done-conditions)

1. `pnpm lint` — tsgo 0-new (only `scripts/upload-cjk-fonts-r2.ts` baseline);
   Biome only the `SettingsDialog.tsx` `lazy` baseline.
2. `pnpm test` — the repointed import/export/library tests + the settingsJson +
   the layer guards green; full suite green minus the known env/timer/sandbox flaky
   set (auth-page/useBookShortcuts/theme-store/api-routes/storage-config import-time
   env; ProgressBar/ReadingRuler timer; clientRuntime/edgeTTS/opds-req sandbox;
   hardcover) — none E6d-2-touched.
3. **Grep gates:**
   - `rg "@/services/bookService" src` → **empty**; `rg "@/services/libraryService" src` → **empty**.
   - `ls src/services/bookService.ts src/services/libraryService.ts` → both gone.
   - `rg -ln "makeLegacyFsAdapter" src --glob '!**/*.test.*'` → **exactly 1 file**:
     `src/infra/shared/fsPortAdapter.ts` (the definition only; **0 consumers**).
   - `rg "services/settings/json|settings/json" src` → empty (relocated);
     `rg -l "services/shared/json" src` → systemSettings + libraryData + settingsJson.test.
4. `LibraryRepositoryShape` / usecase public signatures unchanged (diff the tag +
   usecase return types — no change).

## Execution

Subagent-driven-development per the established template (per-task implementer →
spec-review → code-quality-review; whole-slice review before SHIP). Likely task
decomposition: (T1) relocate json + `libraryData.ts` + `LibraryRepository.layer` +
settingsJson test repoint; (T2) `exportBook` usecase rewrite + test repoint; (T3)
`bookImport.ts` (`buildBookLookupIndex` + `mergeBooks` + `importBook`) +
`importBooks` usecase rewrite + `importBooks.test`/`import-metahash.test` repoints;
(T4) delete `bookService.ts` + `libraryService.ts` + full verification. `importBook`
(T3) is the large, fidelity-critical task (opus implementer + opus review). Kept
as-is on `effect/domain-type-migration`, not pushed.

## Sequencing context

E6d-2 is the fifth E6 slice. After it: **E6e** — delete `makeLegacyFsAdapter` +
`fsPortAdapter.ts` + `persistence.ts` + the legacy `FileSystem`/`FileWriter` in
`@/domain/system` (the final cleanup; all consumers now gone).
