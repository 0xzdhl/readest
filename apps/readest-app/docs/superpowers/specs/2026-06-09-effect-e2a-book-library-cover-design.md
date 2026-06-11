# Effect E2a — Book/Library/Cover Data Layer + Consumers

**Date:** 2026-06-09
**Status:** Approved (brainstorm) → pending implementation plan
**Scope:** First sub-slice of E2. Build `LibraryRepository`, `BookRepository`, `CoverService` by **reusing** the existing `bookService`/`libraryService` functions via the Plan D adapter pattern, then migrate the ~10 read/write-book-data consumers off the legacy `AppService`. ImportBook (E2b) and cloud/sync (E4) are deferred.

---

## 0. Context

E1 migrated ~27 portable consumers onto the Effect bridge (`getClientRuntime`/`EffectRuntimeProvider`). ~18 remain blocked on Book/Library/Sync/Cover usecases. This slice builds the Book/Library/Cover **data layer** and unblocks the subset that needs only those (no document parsing, no cloud).

Key enabler (from the service map): `src/services/bookService.ts` and `src/services/libraryService.ts` are already **pure functions** taking `fs` (the legacy `FileSystem` interface) + callbacks — NOT instance methods. So they can be reused verbatim through the existing `src/infra/shared/fsPortAdapter.ts` (built in Plan D), exactly as `SettingsRepository` reuses `settingsService`.

`CoverContext = { fs, appPlatform, localBooksDir }` (bookService.ts:63). `localBooksDir` = `PathResolver.prefix('Books')`; `appPlatform` = `Platform.info.appPlatform`.

---

## 1. Decisions (locked during brainstorm)

| #   | Decision           | Choice                                                                                                                                                                       |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Approach           | **Reuse** `bookService`/`libraryService`/cover functions via the `fsPortAdapter` + `CoverContext` — no reimplementation (matches Plan D)                                     |
| 2   | Cut                | E2a = data layer (Library/Book/Cover repos+service) + clusters 1/2/4/5 (~10 consumers). E2b = ImportBook/Export + cluster 3. E4 = cloud.                                     |
| 3   | Runtime wiring     | Add `LibraryRepositoryLive` + `BookRepositoryLive` + `CoverServiceLive` to `client-{tauri,web}` runtimes (as Settings/Migration were)                                        |
| 4   | Sync cover URL     | `CoverService.getCoverImageUrl` stays **synchronous** (computes cover path from `localBooksDir`+book + sync URL conversion) — do NOT force cover renders through `runEffect` |
| 5   | Consumer migration | Same E1 playbook: parallel fan-out for self-acquiring files, sequential for param-injected/DI files                                                                          |

---

## 2. Scope boundary

### In scope

- `application/errors`: add `BookError` (per the original taxonomy)
- `application/repositories/LibraryRepository.ts` + `BookRepository.ts` (ports)
- `application/services/CoverService.ts` (port)
- `infra/shared/{LibraryRepository,BookRepository,CoverService}.layer.ts` (reuse via adapter)
- Wire the three live layers into both client runtimes
- Migrate the **~10 consumers** (clusters 1/2/4/5): `hooks/useLibrary.ts`, `store/libraryStore.ts`, `store/readerStore.ts`, `store/bookDataStore.ts`, `components/metadata/BookDetailModal.tsx`, `components/metadata/BookDetailEdit.tsx`, `app/library/components/SettingsMenu.tsx`, `app/user/components/StorageManager.tsx`, `hooks/useOPDSSubscriptions.ts`, `app/library/components/BackupWindow.tsx` (library-load part only)
- Unit tests (test runtime) + rebridge migrated consumers' tests

### Out of scope

- **ImportBook / ExportBook / mergeBooks** (E2b) — `library/index`, `Bookshelf`, `useDemoBooks`, `opds/index`, `backupService`, `autoDownload`
- **Cloud/sync** (E4): `downloadBook`, `uploadBook`, `fetchBookDetails`'s downloadBook callback, `deleteBook` (CloudSvc)
- The `AppService` god-objects (E5)

> `BookDetailModal` uses `fetchBookDetails` (which needs a `downloadBook` callback → cloud). For E2a, migrate only `getBookFileSize`; if `fetchBookDetails` can't be migrated without cloud, leave that call on legacy and note it (partial-migration is acceptable per-call here ONLY when the remaining call is cloud-blocked — log it). Same for any consumer mixing E2a + cloud members.

---

## 3. Port contracts

```ts
// application/repositories/LibraryRepository.ts
interface LibraryRepositoryShape {
  readonly load: Effect.Effect<Book[], BookError>; // populates coverImageUrl via CoverService
  readonly save: (books: readonly Book[]) => Effect.Effect<void, BookError>;
}

// application/repositories/BookRepository.ts
interface BookRepositoryShape {
  readonly loadContent: (book: Book) => Effect.Effect<BookContent, BookError>;
  readonly loadConfig: (
    book: Book,
    settings: SystemSettings,
  ) => Effect.Effect<BookConfig, BookError>;
  readonly saveConfig: (
    book: Book,
    config: BookConfig,
    settings?: SystemSettings,
  ) => Effect.Effect<void, BookError>;
  readonly loadNav: (book: Book) => Effect.Effect<BookNav | null, BookError>;
  readonly saveNav: (book: Book, nav: BookNav) => Effect.Effect<void, BookError>;
  readonly getFileSize: (book: Book) => Effect.Effect<number | null, BookError>;
  readonly isAvailable: (book: Book) => Effect.Effect<boolean, BookError>;
}

// application/services/CoverService.ts
interface CoverServiceShape {
  readonly getCoverImageUrl: (book: Book) => string; // SYNC
  readonly getCoverImageBlobUrl: (book: Book) => Effect.Effect<string, BookError>;
  readonly getCachedImageUrl: (pathOrUrl: string) => Effect.Effect<string, BookError>;
  readonly generateCoverImageUrl: (book: Book) => Effect.Effect<string, BookError>;
  readonly updateCoverImage: (
    book: Book,
    imageUrl?: string,
    imageFile?: string,
  ) => Effect.Effect<void, BookError>;
}
```

## 4. Live layers (reuse via adapter)

Each `*.layer.ts` is `Layer.effect(Port, Effect.gen(...))` that:

1. yields `FileSystem` + `PathResolver` (+ `Platform` for CoverService), builds `const fs = makeLegacyFsAdapter(fsPort, resolver)`.
2. For CoverService: `localBooksDir = yield* resolver.prefix('Books')`; `appPlatform = (yield* platform.info).appPlatform`; `ctx = { fs, appPlatform, localBooksDir }`. Wrap each `BookSvc` cover fn: `getCoverImageBlobUrl: (book) => Effect.tryPromise({ try: () => BookSvc.getCoverImageBlobUrl(ctx, book), catch: (cause) => new BookError({ operation, bookId: book.hash, cause }) })`. `getCoverImageUrl` is sync → `(book) => BookSvc.getCoverImageUrl(ctx, book)` (no Effect).
3. For BookRepository: wrap `BookSvc.loadContent/loadConfig/...` (they take `fs`, book, [settings]) in `Effect.tryPromise → BookError`.
4. For LibraryRepository: `load` = wrap `LibrarySvc.loadLibraryBooks(fs, generateCoverImageUrl)` where `generateCoverImageUrl` runs `CoverService.generateCoverImageUrl` (yield CoverService, adapt to a `(book) => Promise<string>` via `Effect.runPromise`). `save` = wrap `LibrarySvc.saveLibraryBooks(fs, books)`.

> **`localBooksDir` caveat:** `resolver.prefix('Books')` is async (Effect). Compute it once when the layer builds (in the `Effect.gen`), cache in the closure — so `getCoverImageUrl` (sync) can use the cached value. If the custom-root changes at runtime (rare; `ChangeRootDirectory`), the cached value is stale until the runtime rebuilds — acceptable for this slice; note it. (Legacy had the same `localBooksDir` snapshot via `prepareBooksDir`.)

## 5. Consumer migration

Per file: replace `appService.<member>` with the bridge:

- `loadLibraryBooks()` → `runEffect(Effect.flatMap(LibraryRepository, (r) => r.load))` (or a `LoadLibrary` usecase); `saveLibraryBooks(b)` → `runEffect(... r.save(b))`
- `loadBookConfig(book, settings)` → `runEffect(Effect.flatMap(BookRepository, (r) => r.loadConfig(book, settings)))`; similarly content/nav/saveConfig/saveNav/getFileSize/isAvailable
- `getCachedImageUrl` / `generateCoverImageUrl` / `updateCoverImage` → CoverService via `runEffect`; `getCoverImageUrl` → sync `usePlatformInfo`-style accessor (a `useCoverService()`/`getCoverService()` that exposes the sync method), OR run the cover layer's sync method through `getClientRuntime()`... (plan decides the cleanest sync accessor)
- React → `useRunEffect()`; non-React → `getClientRuntime().runPromise(...)`
- Thin usecases (`LoadLibrary`, `SaveLibrary`, `LoadBookConfig`, etc.) MAY be added (mirroring `LoadSettings`) for ergonomics, or call the repo via `Effect.flatMap` directly — plan picks one and stays consistent.

## 6. Testing & verification

- Unit tests (test runtime) for each repo/service: `BookRepository.saveConfig`→`loadConfig` round-trip over `TestFileSystem`; `LibraryRepository.save`→`load` round-trip (cover population stubbed via a test CoverService or the real one over test platform); `CoverService.getCoverImageUrl` returns a sync path-derived URL. May need a test cover/platform double; `TestFileSystem` suffices for FS-backed ops.
- Migrated consumers' existing tests rebridged (mock `@/runtime/clientRuntime`, as in E1).
- `pnpm exec tsgo --noEmit` clean (+ `BookError` wired); `pnpm exec biome check` clean; `pnpm test` no new failures beyond documented flaky.
- Dependency direction: `application/` imports only domain/application/effect; `infra/shared` may import `@/services/*` (the functions it reuses).

## 7. Risks

- **Sync `getCoverImageUrl`** (decision #4) — relies on cached `localBooksDir` + sync URL conversion. Plan must verify the web path (blob URLs are async) — if web `getCoverImageUrl` genuinely needs async, fall back to an Effect variant for web and keep sync for Tauri, or have consumers use the already-async `generateCoverImageUrl`. Resolve in the plan.
- **LibraryRepository → CoverService dependency** — wiring order in the runtime; tsgo catches unmet requirements.
- **Partial migration where E2a + cloud mix** (e.g. `BookDetailModal` `fetchBookDetails`) — migrate the E2a members, leave cloud members on legacy, log each; not a silent partial.
- **`localBooksDir` staleness** after `ChangeRootDirectory` — accepted for this slice (matches legacy snapshot behavior).
