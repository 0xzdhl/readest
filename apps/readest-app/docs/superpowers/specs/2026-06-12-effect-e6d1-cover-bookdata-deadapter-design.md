# E6d-1 — Cover + Book-data de-adapter (design)

**Date:** 2026-06-12
**Branch:** `effect/domain-type-migration`
**Predecessors:** E6a (Settings, the template) — `2026-06-11-effect-e6a-settings-deadapter-design.md`;
E6b (Font/Image/Dict) — `2026-06-12-effect-e6b-font-image-dict-deadapter-design.md`;
E6c (Cloud) — `2026-06-12-effect-e6c-cloud-deadapter-design.md`.

## Goal

E6 removes the `makeLegacyFsAdapter` compatibility shim service-by-service. E6d
de-adapters the **Book / Library / Cover** stack; it is split into two sub-slices
(decided during brainstorming because `importBook` is large and the de-adaptered
Cover/Book-data are what the effectful `importBook` will `yield*`):

- **E6d-1 (this spec):** the **cover** functions + the **book-data** functions
  (content/config/nav/size/availability/refresh/fetchBookDetails). De-adapter
  `CoverService.layer` and `BookRepository.layer`, and retire the E6c
  `fetchBookDetails` bridge in `CloudService.layer` (so CloudService becomes
  **fully** clear of `makeLegacyFsAdapter`).
- **E6d-2 (later):** `importBook` / `mergeBooks` / `exportBook` + `libraryService`
  (LibraryRepository, `persistence.ts` → the E6a json mirror), then delete
  `bookService.ts` / `libraryService.ts`.

E6d-1 is **purely additive**: it creates new Effect-native modules and repoints
three layers; it does **not** modify `bookService.ts` or `libraryService.ts`.
The migrated functions therefore coexist (legacy copy in `bookService.ts`, new
Effect-native copy in `application/services/*`) until E6d-2 deletes
`bookService.ts` wholesale. This is the same additive-coexistence strangler
pattern used in E1–E5, and it keeps E6d-1 low-risk (no chance of breaking the
still-legacy `importBook`/`mergeBooks`/`exportBook` by removing a shared helper)
and free of test repoints.

## Non-goals / explicitly untouched

- `src/services/bookService.ts` and `src/services/libraryService.ts` — **left
  entirely as-is**. Their now-duplicated cover/book-data fns become unreferenced
  by production (still referenced by the legacy `importBook`/`exportBook` inside
  the same file) and are deleted with the file in E6d-2. (Unused _exports_ are
  not flagged by tsgo/Biome, so this compiles cleanly.)
- `src/services/persistence.ts` (`safeLoadJSON`/`safeSaveJSON`) — untouched; its
  last user `libraryService` is migrated in E6d-2, after which E6e deletes it.
  (Confirmed: the top-level `persistence.ts` is imported **only** by
  `libraryService.ts`; `rsvp/index.ts` re-exports its _own_ sibling
  `rsvp/persistence`, a different module.)
- `src/infra/shared/fsPortAdapter.ts` (`makeLegacyFsAdapter`), the legacy
  `FileSystem`/`FileWriter` in `@/domain/system` — untouched (E6d-2 removes the
  last 3 consumers; E6e deletes the adapter). After E6d-1 the consumer count is
  **3**: `LibraryRepository.layer` + `exportBook`/`importBooks` usecases (plus
  the `fsPortAdapter.ts` definition).
- The application tags/shapes — `CoverService`/`CoverServiceShape`,
  `BookRepository`/`BookRepositoryShape`, `CloudService`/`CloudServiceShape`,
  `BookError` (`Data.TaggedError<{operation, bookId?, cause}>`) — **unchanged**.
  Every method signature and error channel is identical before and after.
  `CoverServiceShape.getCoverImageUrl` stays **synchronous** (`(book) => string`).
- `src/libs/storage.ts`, `CloudTransfers` (`application/services/cloud/cloudTransfers.ts`)
  — unchanged; CloudService.layer still uses `CloudTransfers.downloadBook` (now
  as the `fetchBookDetails` callback instead of a separate method seam).

## Architecture

Two new Effect-native modules under `src/application/services/`, mirroring the
E6a/E6b/E6c style (`Effect.gen` yielding the ports; `Effect.tryPromise` for
non-port async; faithful, mechanical port of the legacy `bookService.ts` logic).

### `src/application/services/cover/coverImages.ts`

Effect-native ports of the cover fns (legacy `bookService.ts:67-134`). They drop
the `CoverContext` parameter and `yield*` the ports instead:

- `getCoverImageBlobUrl(book)` → `Effect<string, FsError, FileSystem | PathResolver>`:
  `localBooksDir = yield* resolver.prefix('Books')`; `yield* fs.getBlobUrl(\`${localBooksDir}/${getCoverFilename(book)}\`, 'None')`.
- `getCachedImageUrl(pathOrUrl)` → `Effect<string, FsError, FileSystem | PathResolver>`:
  `cachePrefix = yield* resolver.prefix('Cache')` (per-call, faithful to legacy
  `ctx.fs.getPrefix('Cache')`); `exists` → `getUrl`, else `openFile` +
  `arrayBuffer` (`Effect.tryPromise`) + `writeFile('Cache')` + `getUrl`.
- `generateCoverImageUrl(book)` → `Effect<string, FsError, FileSystem | PathResolver | Platform>`:
  `info = yield* platform.info`; `appPlatform === 'web' ? yield* getCoverImageBlobUrl(book)
: yield* (resolver.prefix('Books') then fs.getUrl(\`${localBooksDir}/${getCoverFilename(book)}\`))`.
(The non-web branch reproduces the one-line `getUrl`of the sync`getCoverImageUrl` — see below — over a per-call Books prefix; async, faithful.)
- `updateCoverImage(book, imageUrl?, imageFile?)` → `Effect<void, …, FileSystem | Platform>`:
  `'_blank'` → `removeFile(getCoverFilename(book), 'Books')`; else
  `imageToArrayBuffer` (web blob `fetch`, tauri file/url) wrapped in
  `Effect.tryPromise`, then `writeFile(getCoverFilename(book), 'Books', buf)`.
  `imageToArrayBuffer` is ported into this module (uses `appPlatform` from
  Platform; web `fetch`, `tauriFetch`, and `fs.openFile` paths preserved).

`getCoverImageUrl` (the **sync** shape method) is NOT in the module — it stays
**inline in the layer**: Tauri `resolver.prefix` is async (`Effect.tryPromise`),
so it can't be re-run under `Effect.runSync` per call. The layer snapshots
`localBooksDir = yield* resolver.prefix('Books')` once at init (as the current
layer already does) and returns
`getCoverImageUrl: (book) => Effect.runSync(fsPort.getUrl(\`${localBooksDir}/${getCoverFilename(book)}\`))`.
`getUrl`is a sync Effect (proven:`fsPortAdapter.getURL`already calls`Effect.runSync(fsPort.getUrl(path))`). This is the E6c precedent (keep the one
method that can't be modeled the standard way inline in the layer).

### `src/application/services/book/bookData.ts`

Effect-native ports of the book-data fns (legacy `bookService.ts:489-617, 625-648`),
each `yield*`ing `FileSystem`:

- `loadBookContent(book)` → `Effect<BookContent, FsError | BookFileNotFoundError, FileSystem>`:
  `exists`/`openFile` cascade (Books local → filePath/url 'None' → readDir
  fallback finding `.${EXTS[book.format]}`); throws `BookFileNotFoundError` via
  `Effect.fail` when not found (faithful).
- `loadBookConfig(book, settings)` → `Effect<BookConfig, never, FileSystem>`:
  exists→readFile→`deserializeConfig`; any error → `Effect.catchAll` returns
  `deserializeConfig('{}', …)` (faithful try/catch→default; never fails).
- `saveBookConfig(book, config, settings?)` → `Effect<void, FsError, FileSystem>`:
  `serializeConfig`/`JSON.stringify` then `writeFile(getConfigFilename(book), 'Books')`.
- `loadBookNav(book)` → `Effect<BookNav | null, never, FileSystem>`: exists→readFile→
  `JSON.parse` + version check; any error → `null` (faithful catch→null).
- `saveBookNav(book, nav)` → `Effect<void, FsError, FileSystem>`.
- `getBookFileSize(book)` → `Effect<number | null, FsError, FileSystem>`: exists→
  `openFile`→`file.size`→close (ClosableFile, `Effect.tryPromise`).
- `isBookAvailable(book)` → `Effect<boolean, FsError, FileSystem>`: exists local /
  filePath 'None' / `isValidURL(book.url)`.
- `refreshBookMetadata(book)` → `Effect<boolean, …, FileSystem>`: `loadBookContent`
  - `DocumentLoader(file).open()` (`Effect.tryPromise`); mutates `book.metadata`/
    `metaHash`/`primaryLanguage`/series in place (faithful).
- `fetchBookDetails(book, downloadBook)` → `Effect<BookMetadata, …, FileSystem | R_dl>`:
  `if (!(yield* fs.exists(getLocalBookFilename(book), 'Books')) && book.uploadedAt)
yield* downloadBook(book)`; `loadBookContent`; `DocumentLoader(file).open()`
  (`Effect.tryPromise`); close; return `book.metadata`. `downloadBook` is an
  **injected effect** `(b: Book) => Effect<void, E, R_dl>` (the layer supplies it),
  so `R`/`E` union the caller's.

(The module may be split into e.g. `bookContent.ts` + `bookMetadata.ts` if the
single file grows unwieldy — a plan-level call. One file is the default.)

## Layer rewrites

All three use the `provide<A,E>` helper that `provideService`s the ports
(SettingsRepository.layer pattern). The layer wraps the module fn's residual
error channel into the domain error **at the layer** (where `book` — and thus
`book.hash` — is in scope), faithful to today's `Effect.tryPromise{catch: err(op, hash)}`.

### `BookRepository.layer.ts`

Drops `makeLegacyFsAdapter` + `import * as BookSvc` **and** the `PathResolver`
yield (the book-data fns use only `FileSystem` — no `prefix`/`absolute`). `provide`
over `FileSystem` only. Each method:
`loadContent: (book) => provide(BookData.loadBookContent(book)).pipe(Effect.mapError(err('loadContent', book.hash)))`,
and likewise for `loadConfig`/`saveConfig`/`loadNav`/`saveNav`/`getFileSize`/
`isAvailable`/`refreshMetadata`.

### `CoverService.layer.ts`

Drops `makeLegacyFsAdapter` + `import * as BookSvc` + the `CoverContext`. Keeps
`Platform` (for `info`) and snapshots `localBooksDir = yield* resolver.prefix('Books')`.
`provide` over `FileSystem | PathResolver | Platform`. Methods:
`getCoverImageUrl` inline (runSync, above); `getCoverImageBlobUrl`/
`getCachedImageUrl`/`generateCoverImageUrl`/`updateCoverImage` →
`provide(CoverImages.fn(...)).pipe(Effect.mapError(err(op, book?.hash)))`.

### `CloudService.layer.ts` (retire the E6c bridge)

Drops `makeLegacyFsAdapter` + `import * as BookSvc` (the **only** remaining uses,
from E6c). `fetchBookDetails` becomes:

```
fetchBookDetails: (book) =>
  provide(
    BookData.fetchBookDetails(book, (b) => CloudTransfers.downloadBook(b)),
  ).pipe(Effect.mapError(err('fetchBookDetails'))),
```

where `provide` here is the existing CloudService.layer two-port helper. The
injected `downloadBook` returns `Effect<void, CloudError, FileSystem | PathResolver>`;
`fetchBookDetails` unions that into its `R`/`E`, both satisfied/mapped by the
layer. After this, `rg "makeLegacyFsAdapter" src/infra/shared/CloudService.layer.ts`
is **empty**.

## Tests

No repoints (the legacy `bookService.ts` is untouched, so
`import-metahash.test`/`importBooks.test`/`exportBook.test` are unaffected). The
existing **layer** regression guards now exercise the new modules (identical
shapes), and are the green-gate:

- `src/__tests__/application/coverService.test.ts` — CoverService.layer.
- `src/__tests__/application/bookRepository.test.ts` — BookRepository.layer.
- `src/__tests__/application/cloudService.test.ts` — CloudService.layer (its 4
  cases don't cover `fetchBookDetails`, but confirm the bridge retirement didn't
  break the layer).
- Store/consumer guards (`store/reader-store`, `store/library-store`,
  `store/book-data-store`) — unchanged.

Add one focused test: `src/__tests__/application/book/bookData.fetchBookDetails.test.ts`
(or fold into an existing app test) exercising `BookData.fetchBookDetails` over a
stub `FileSystem` layer with a fake `downloadBook` effect — asserting it
downloads-when-absent-and-uploaded, opens content, and returns metadata — since
`fetchBookDetails` gains no other direct coverage and this slice retires its
bridge.

## Verification (done-conditions)

1. `pnpm lint` — tsgo **0-new** (only the pre-existing `scripts/upload-cjk-fonts-r2.ts`
   baseline); Biome only the pre-existing `SettingsDialog.tsx` `lazy` baseline.
2. `pnpm test` — the cover/book/cloud layer guards + the new `fetchBookDetails`
   test green; full suite green minus the known env/timer-flaky set (auth-page,
   useBookShortcuts, theme-store import-time env, ProgressBar/ReadingRuler timer,
   clientRuntime/edgeTTS/opds-req sandbox, hardcover) — none E6d-1-touched.
3. **Grep gates:**
   - `rg "makeLegacyFsAdapter" src/infra/shared/CloudService.layer.ts` → **empty**.
   - `rg "makeLegacyFsAdapter" src/infra/shared/CoverService.layer.ts src/infra/shared/BookRepository.layer.ts` → **empty**.
   - `rg -ln "makeLegacyFsAdapter" src --glob '!**/*.test.*'` → **4 files**:
     `fsPortAdapter.ts` (def) + `LibraryRepository.layer.ts` + `exportBook.ts` +
     `importBooks.ts` (consumer count 3 + the def).
   - `rg "@/services/bookService" src/infra/shared/{CoverService,BookRepository,CloudService}.layer.ts` → **empty** (layers off legacy bookService).
4. `CoverServiceShape`/`BookRepositoryShape`/`CloudServiceShape` unchanged (diff the tag files → no change).

## Execution

Subagent-driven-development per the E6a/E6b/E6c template: per-task implementer →
spec-review → code-quality-review; whole-slice review before SHIP. Likely task
decomposition: (1) `coverImages.ts` + CoverService.layer; (2) `bookData.ts`
content/config/nav/size/availability + BookRepository.layer; (3) `fetchBookDetails`

- refreshMetadata + retire CloudService bridge + the focused test; (4) verify.
  Kept as-is on `effect/domain-type-migration`, not pushed.

## Sequencing context

E6d-1 is the fourth E6 slice. After it: **E6d-2** (Import/Export + Library —
clears the last 3 `makeLegacyFsAdapter` consumers and deletes `bookService.ts`/
`libraryService.ts`) and **E6e** (delete `makeLegacyFsAdapter` + `fsPortAdapter.ts`

- `persistence.ts` + `LegacyFileSystem`).
