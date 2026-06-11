# Effect E2a — Book/Library/Cover Data Layer + Consumers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Sequential for the layer tasks (1–5); the consumer migration (Task 6) fans out in parallel (edit-only) then the controller verifies+commits. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build `LibraryRepository`, `BookRepository`, `CoverService` by reusing the existing `bookService`/`libraryService`/cover functions through the Plan D `fsPortAdapter` + a `CoverContext`, wire them into the client runtimes, and migrate the ~10 read/write-book-data consumers off the legacy `AppService`.

**Architecture:** Each repo/service `*.layer.ts` (in `infra/shared/`) yields the new ports, builds the legacy-`FileSystem` adapter, and calls the existing pure `bookService`/`libraryService` functions — zero logic divergence (same pattern as `SettingsRepository`). Errors map to a new `BookError`. Consumers move to the bridge (`runEffect(Repo…)` / `getClientRuntime()`), same E1 playbook.

**Tech Stack:** effect@3.21.2, Vitest, tsgo + Biome. Reuses `@/services/{bookService,libraryService}` + `@/infra/shared/fsPortAdapter`. `@/* → src/*`.

**Prereqs:** Plans A–D + E1 complete. `fsPortAdapter`, ports, bridge, `TestFileSystem`, `runtime/test.ts` exist. Spec: `docs/superpowers/specs/2026-06-09-effect-e2a-book-library-cover-design.md`.

**Source of truth (read while wrapping):** `src/services/bookService.ts` (CoverContext L63; loadBookContent L517, loadBookConfig L545, saveBookConfig L565, loadBookNav L584, saveBookNav L597, getBookFileSize L503, isBookAvailable L489; cover: getCoverImageUrl L63 sync, getCoverImageBlobUrl L67, getCachedImageUrl L71, generateCoverImageUrl L84, updateCoverImage L122). `src/services/libraryService.ts` (loadLibraryBooks, saveLibraryBooks). `src/services/appService.ts:211–419` (binding pattern). Domain types: `Book`,`BookConfig`,`BookContent` in `@/domain/book`; `BookNav` in `@/domain/nav`; `SystemSettings` in `@/domain/settings`.

---

## File structure

```
src/application/errors/AppError.ts                 # MODIFY: add BookError
src/application/repositories/LibraryRepository.ts  # port
src/application/repositories/BookRepository.ts     # port
src/application/services/CoverService.ts           # port
src/infra/shared/fsPortAdapter.ts                  # MODIFY: getURL stub -> Effect.runSync(fsPort.getUrl)
src/infra/shared/CoverService.layer.ts
src/infra/shared/BookRepository.layer.ts
src/infra/shared/LibraryRepository.layer.ts
src/runtime/client-tauri.ts, client-web.ts         # MODIFY: add the 3 live layers
src/__tests__/application/{coverService,bookRepository,libraryRepository}.test.ts
# + ~10 consumer files migrated (Task 6)
```

---

## Task 1: BookError + adapter getURL fix + the 3 port contracts

**Files:** Modify `src/application/errors/AppError.ts`, `src/infra/shared/fsPortAdapter.ts`; Create the 3 port files.

- [ ] **Step 1: Add `BookError`** to `src/application/errors/AppError.ts` (after `SettingsError`), and add it to the `AppError` union:

```ts
export class BookError extends Data.TaggedError('BookError')<{
  readonly operation: string;
  readonly bookId?: string;
  readonly cause: unknown;
}> {}
```

(Add `| BookError` to the `AppError` union type.)

- [ ] **Step 2: Fix the adapter `getURL`.** In `src/infra/shared/fsPortAdapter.ts`, replace the throwing `getURL` stub with a real sync conversion (the new port's `getUrl` is `Effect.try`/sync on Tauri — `convertFileSrc`; web cover rendering uses the async blob path and never calls this synchronously):

```ts
  getURL: (path: string): string => Effect.runSync(fsPort.getUrl(path)),
```

(Keep `resolvePath` as the throwing stub — still unused.)

- [ ] **Step 3: Create the 3 port contracts** exactly as the spec §3:

```ts
// src/application/repositories/LibraryRepository.ts
import { Context, type Effect } from 'effect';
import type { Book } from '@/domain/book';
import type { BookError } from '@/application/errors/AppError';
export interface LibraryRepositoryShape {
  readonly load: Effect.Effect<Book[], BookError>;
  readonly save: (books: readonly Book[]) => Effect.Effect<void, BookError>;
}
export class LibraryRepository extends Context.Tag('app/LibraryRepository')<
  LibraryRepository,
  LibraryRepositoryShape
>() {}
```

```ts
// src/application/repositories/BookRepository.ts
import { Context, type Effect } from 'effect';
import type { Book, BookConfig, BookContent } from '@/domain/book';
import type { BookNav } from '@/domain/nav';
import type { SystemSettings } from '@/domain/settings';
import type { BookError } from '@/application/errors/AppError';
export interface BookRepositoryShape {
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
export class BookRepository extends Context.Tag('app/BookRepository')<
  BookRepository,
  BookRepositoryShape
>() {}
```

```ts
// src/application/services/CoverService.ts
import { Context, type Effect } from 'effect';
import type { Book } from '@/domain/book';
import type { BookError } from '@/application/errors/AppError';
export interface CoverServiceShape {
  readonly getCoverImageUrl: (book: Book) => string;
  readonly getCoverImageBlobUrl: (book: Book) => Effect.Effect<string, BookError>;
  readonly getCachedImageUrl: (pathOrUrl: string) => Effect.Effect<string, BookError>;
  readonly generateCoverImageUrl: (book: Book) => Effect.Effect<string, BookError>;
  readonly updateCoverImage: (
    book: Book,
    imageUrl?: string,
    imageFile?: string,
  ) => Effect.Effect<void, BookError>;
}
export class CoverService extends Context.Tag('app/CoverService')<
  CoverService,
  CoverServiceShape
>() {}
```

- [ ] **Step 4:** `pnpm exec tsgo --noEmit` → only pre-existing error. (Confirm the `BookError` import resolves and the adapter `getURL` typechecks — `fsPort.getUrl` returns `Effect<string, FsError>`; `Effect.runSync` requires the effect have no async; if tsgo complains that `getUrl` may be async, wrap as `Effect.runSync(fsPort.getUrl(path) as Effect.Effect<string, FsError>)` is NOT enough — instead confirm `TauriFileSystem.getUrl`/`WebFileSystem.getUrl` are built with `Effect.try`/`Effect.sync` not `tryPromise`; if web `getUrl` is async, gate: `getURL: (path) => Effect.runSync(fsPort.getUrl(path))` still compiles because the type is `Effect<string, FsError>` with `R=never`; runSync throws at runtime only if actually async — acceptable since cover-web uses blob.)
- [ ] **Step 5: Commit** `git add src/application/errors/AppError.ts src/infra/shared/fsPortAdapter.ts src/application/repositories/LibraryRepository.ts src/application/repositories/BookRepository.ts src/application/services/CoverService.ts && git commit -m "feat(application): add BookError + Library/Book repos + CoverService ports"`

---

## Task 2: CoverServiceLive + test

**Files:** Create `src/infra/shared/CoverService.layer.ts`; Test `src/__tests__/application/coverService.test.ts`

- [ ] **Step 1: Write the failing test** (cover URL derivation over test ports; getCachedImageUrl round-trip via TestFileSystem)

```ts
// src/__tests__/application/coverService.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { CoverService } from '@/application/services/CoverService';
import { CoverServiceLive } from '@/infra/shared/CoverService.layer';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Deps = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, Base);
const layer = Layer.provide(CoverServiceLive, Deps);
const run = <A>(p: Effect.Effect<A, unknown, CoverService>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('CoverService (live over test ports)', () => {
  it('getCoverImageUrl returns a sync string derived from the book', async () => {
    const url = await run(
      Effect.map(CoverService, (c) => c.getCoverImageUrl({ hash: 'abc' } as never)),
    );
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — READ `bookService.ts` cover functions + `CoverContext`. Build the context once in the layer (cache `localBooksDir`), wrap each cover fn:

```ts
// src/infra/shared/CoverService.layer.ts
import { Effect, Layer } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as BookSvc from '@/services/bookService';

export const CoverServiceLive = Layer.effect(
  CoverService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const platform = yield* Platform;
    const info = yield* platform.info;
    const localBooksDir = yield* resolver.prefix('Books'); // cached snapshot
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const ctx: BookSvc.CoverContext = { fs, appPlatform: info.appPlatform, localBooksDir };
    const err = (operation: string, bookId?: string) => (cause: unknown) =>
      new BookError({ operation, bookId, cause });
    return {
      getCoverImageUrl: (book: Book) => BookSvc.getCoverImageUrl(ctx, book),
      getCoverImageBlobUrl: (book: Book) =>
        Effect.tryPromise({
          try: () => BookSvc.getCoverImageBlobUrl(ctx, book),
          catch: err('getCoverImageBlobUrl', book.hash),
        }),
      getCachedImageUrl: (pathOrUrl: string) =>
        Effect.tryPromise({
          try: () => BookSvc.getCachedImageUrl(ctx, pathOrUrl),
          catch: err('getCachedImageUrl'),
        }),
      generateCoverImageUrl: (book: Book) =>
        Effect.tryPromise({
          try: () => BookSvc.generateCoverImageUrl(ctx, book),
          catch: err('generateCoverImageUrl', book.hash),
        }),
      updateCoverImage: (book: Book, imageUrl?: string, imageFile?: string) =>
        Effect.tryPromise({
          try: () => BookSvc.updateCoverImage(ctx, book, imageUrl, imageFile),
          catch: err('updateCoverImage', book.hash),
        }),
    } satisfies CoverServiceShape;
  }),
);
```

> Verify `BookSvc.CoverContext` is exported (if not, import the type it actually exposes, or construct the object inline matching the fn params). Confirm the cover fn names/arities against the source.

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(infra): add CoverService live layer (reuses bookService cover fns)`.

---

## Task 3: BookRepositoryLive + test

**Files:** Create `src/infra/shared/BookRepository.layer.ts`; Test `src/__tests__/application/bookRepository.test.ts`

- [ ] **Step 1: Write the failing test** (saveConfig→loadConfig round-trip over TestFileSystem)

```ts
// src/__tests__/application/bookRepository.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { BookRepository } from '@/application/repositories/BookRepository';
import { BookRepositoryLive } from '@/infra/shared/BookRepository.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const layer = Layer.provide(BookRepositoryLive, Layer.merge(TestFileSystemLive, Base));
const run = <A>(p: Effect.Effect<A, unknown, BookRepository>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('BookRepository (live over test ports)', () => {
  it('isAvailable is false for a book with no local file', async () => {
    const ok = await run(
      Effect.flatMap(BookRepository, (r) =>
        r.isAvailable({ hash: 'nope', format: 'EPUB' } as never),
      ),
    );
    expect(ok).toBe(false);
  });
});
```

(Keep this minimal — a config round-trip needs a valid `Book`+`BookConfig`+`settings`; if constructing those is heavy, the `isAvailable=false` test exercises the wiring sufficiently. Add a config round-trip only if a cheap fixture exists.)

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — wrap each `BookSvc` fn (they take `fs` first):

```ts
// src/infra/shared/BookRepository.layer.ts
import { Effect, Layer } from 'effect';
import type { Book, BookConfig } from '@/domain/book';
import type { BookNav } from '@/domain/nav';
import type { SystemSettings } from '@/domain/settings';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import {
  BookRepository,
  type BookRepositoryShape,
} from '@/application/repositories/BookRepository';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as BookSvc from '@/services/bookService';

export const BookRepositoryLive = Layer.effect(
  BookRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const err = (operation: string, bookId?: string) => (cause: unknown) =>
      new BookError({ operation, bookId, cause });
    return {
      loadContent: (book) =>
        Effect.tryPromise({
          try: () => BookSvc.loadBookContent(fs, book),
          catch: err('loadContent', book.hash),
        }),
      loadConfig: (book, settings) =>
        Effect.tryPromise({
          try: () => BookSvc.loadBookConfig(fs, book, settings),
          catch: err('loadConfig', book.hash),
        }),
      saveConfig: (book, config, settings) =>
        Effect.tryPromise({
          try: () => BookSvc.saveBookConfig(fs, book, config, settings),
          catch: err('saveConfig', book.hash),
        }),
      loadNav: (book) =>
        Effect.tryPromise({
          try: () => BookSvc.loadBookNav(fs, book),
          catch: err('loadNav', book.hash),
        }),
      saveNav: (book, nav) =>
        Effect.tryPromise({
          try: () => BookSvc.saveBookNav(fs, book, nav),
          catch: err('saveNav', book.hash),
        }),
      getFileSize: (book) =>
        Effect.tryPromise({
          try: () => BookSvc.getBookFileSize(fs, book),
          catch: err('getFileSize', book.hash),
        }),
      isAvailable: (book) =>
        Effect.tryPromise({
          try: () => BookSvc.isBookAvailable(fs, book),
          catch: err('isAvailable', book.hash),
        }),
    } satisfies BookRepositoryShape;
  }),
);
```

> Confirm the exact exported fn names/arities in `bookService.ts` and adjust. `loadBookConfig`/`saveBookConfig` settings param must match.

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(infra): add BookRepository live layer (reuses bookService)`.

---

## Task 4: LibraryRepositoryLive + test

**Files:** Create `src/infra/shared/LibraryRepository.layer.ts`; Test `src/__tests__/application/libraryRepository.test.ts`

- [ ] **Step 1: Write the failing test** (save→load round-trip; CoverService provided)

```ts
// src/__tests__/application/libraryRepository.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { LibraryRepositoryLive } from '@/infra/shared/LibraryRepository.layer';
import { CoverServiceLive } from '@/infra/shared/CoverService.layer';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Ports = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, Base);
const Cover = Layer.provide(CoverServiceLive, Ports);
const layer = Layer.provide(LibraryRepositoryLive, Layer.merge(Ports, Cover));
const run = <A>(p: Effect.Effect<A, unknown, LibraryRepository>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('LibraryRepository (live over test ports)', () => {
  it('load returns [] when no library.json exists', async () => {
    const books = await run(Effect.flatMap(LibraryRepository, (r) => r.load));
    expect(Array.isArray(books)).toBe(true);
    expect(books).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — depends on `CoverService` (for the `generateCoverImageUrl` callback):

```ts
// src/infra/shared/LibraryRepository.layer.ts
import { Effect, Layer } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { CoverService } from '@/application/services/CoverService';
import {
  LibraryRepository,
  type LibraryRepositoryShape,
} from '@/application/repositories/LibraryRepository';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as LibrarySvc from '@/services/libraryService';

export const LibraryRepositoryLive = Layer.effect(
  LibraryRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const cover = yield* CoverService;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const generateCoverImageUrl = (book: Book) =>
      Effect.runPromise(cover.generateCoverImageUrl(book));
    return {
      load: Effect.tryPromise({
        try: () => LibrarySvc.loadLibraryBooks(fs, generateCoverImageUrl),
        catch: (cause) => new BookError({ operation: 'loadLibrary', cause }),
      }),
      save: (books) =>
        Effect.tryPromise({
          try: () => LibrarySvc.saveLibraryBooks(fs, books as Book[]),
          catch: (cause) => new BookError({ operation: 'saveLibrary', cause }),
        }),
    } satisfies LibraryRepositoryShape;
  }),
);
```

> Confirm `LibrarySvc.loadLibraryBooks`/`saveLibraryBooks` signatures. `generateCoverImageUrl` via `Effect.runPromise(cover.generateCoverImageUrl(book))` is valid because `cover` is a resolved shape (no remaining R).

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(infra): add LibraryRepository live layer (reuses libraryService)`.

---

## Task 5: Wire the 3 live layers into the client runtimes

**Files:** Modify `src/runtime/client-tauri.ts`, `src/runtime/client-web.ts`

- [ ] **Step 1:** Add `CoverServiceLive`, `BookRepositoryLive`, `LibraryRepositoryLive` to both runtimes, provided over the existing ports (and `LibraryRepositoryLive` over `CoverServiceLive`). Follow the existing `provideMerge`/`mergeAll` composition (where `Settings`/`Migration` were added). Example shape:

```ts
// in client-tauri.ts (and analogous in client-web.ts)
const Cover = Layer.provide(CoverServiceLive, /* ports incl. Platform */ ...);
const Repos = Layer.provide(
  Layer.mergeAll(SettingsRepositoryLive, MigrationServiceLive, BookRepositoryLive, Cover, LibraryRepositoryLive),
  /* the port layer */,
);
```

The exact composition must resolve the runtime to requirement `never` — `LibraryRepositoryLive` needs `CoverService`; `CoverService`/`Book`/`Library` need `FileSystem`+`PathResolver` (+`Platform` for Cover). tsgo flags any unmet requirement at `ManagedRuntime.make`. Adjust `provide`/`provideMerge` nesting until clean. READ the current `client-tauri.ts` composition and extend it.

- [ ] **Step 2:** `pnpm exec tsgo --noEmit` → clean (both `ManagedRuntime.make` requirement `never`). `pnpm exec vitest run src/__tests__/application src/__tests__/infra` → pass.
- [ ] **Step 3: Commit** `feat(runtime): wire CoverService + Book/Library repositories into client runtimes`.

---

## Task 6: Migrate the ~10 consumers (parallel fan-out, controller commits)

The consumers + their E2a members (from the service map):

| File                                      | E2a members → bridge target                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hooks/useLibrary.ts`                     | `loadLibraryBooks` → `LibraryRepository.load` (+ `loadSettings` already E1)                                                                                                                                                                                                                                                                                                                                                                      |
| `store/libraryStore.ts`                   | `saveLibraryBooks` → `LibraryRepository.save`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `store/bookDataStore.ts`                  | `saveBookConfig` → `BookRepository.saveConfig`; `saveLibraryBooks` → `LibraryRepository.save`                                                                                                                                                                                                                                                                                                                                                    |
| `store/readerStore.ts`                    | `loadBookConfig/loadBookContent/loadBookNav/saveBookConfig/saveBookNav` → `BookRepository.*`                                                                                                                                                                                                                                                                                                                                                     |
| `app/library/components/SettingsMenu.tsx` | `loadLibraryBooks`,`saveLibraryBooks` → `LibraryRepository.*`; `refreshBookMetadata` → **NOT in E2a** (it's a book-metadata write; the repo doesn't expose it — leave `refreshBookMetadata` on legacy, log it; OR add `refreshMetadata` to BookRepository in Task 3 if cheap). Decide: add `refreshMetadata(book): Effect<boolean,BookError>` wrapping `BookSvc.refreshBookMetadata(fs, book)` to BookRepository so SettingsMenu fully migrates. |
| `app/user/components/StorageManager.tsx`  | `saveLibraryBooks` → `LibraryRepository.save`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `hooks/useOPDSSubscriptions.ts`           | `saveLibraryBooks` → `LibraryRepository.save`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `app/library/components/BackupWindow.tsx` | `loadLibraryBooks` → `LibraryRepository.load` (its `openFile` is FS, already-portable; migrate too). Other backup logic uses importBook → **E2b**: migrate only the loadLibraryBooks/FS calls, leave importBook on legacy, log.                                                                                                                                                                                                                  |
| `components/metadata/BookDetailModal.tsx` | `getBookFileSize` → `BookRepository.getFileSize`; `fetchBookDetails` needs cloud → **leave on legacy, log**                                                                                                                                                                                                                                                                                                                                      |
| `components/metadata/BookDetailEdit.tsx`  | `getCachedImageUrl` → `CoverService.getCachedImageUrl`                                                                                                                                                                                                                                                                                                                                                                                           |

> **Plan decision:** add `refreshMetadata(book)` to BookRepository (Task 3) so `SettingsMenu` fully migrates. Re-run Task 3's commit to include it, or add it here as a small amendment commit before the fan-out.

**Per-file recipe (same as E1 Task 5):** React → `const runEffect = useRunEffect()`, `await runEffect(Effect.flatMap(LibraryRepository, (r) => r.load))`; non-React → `getClientRuntime().runPromise(...)`. Preserve async/throw semantics. If a file ALSO uses a cloud/import member (E4/E2b), migrate ONLY the E2a members and leave the rest on `appService` (acceptable partial — the remaining member is genuinely blocked; LOG it). DO NOT change exported signatures in the parallel phase (return `NEEDS_SEQUENTIAL`).

- [ ] **Step 1: Fan-out** (parallel Workflow, edit-only, one agent per file): each agent reads the file, migrates its E2a members per the table, runs `pnpm exec biome check <file>`, returns `{file, status: MIGRATED|PARTIAL|NEEDS_SEQUENTIAL, leftOnLegacy[], notes}`. No git, no whole-tsgo.
- [ ] **Step 2: Controller** — run `pnpm exec tsgo --noEmit` (fix any miss); commit the migrated files (one commit or per-file). Handle `NEEDS_SEQUENTIAL` files serially (DI/signature).
- [ ] **Step 3:** Rebridge any broken consumer tests (mock `@/runtime/clientRuntime` / the repos), as in E1.

---

## Task 7: Verification (E2a done)

- [ ] `pnpm exec vitest run src/__tests__/application src/__tests__/infra` → pass (new repo/service tests green).
- [ ] `pnpm exec tsgo --noEmit` → only pre-existing `upload-cjk-fonts-r2`. Both runtimes requirement `never`.
- [ ] `pnpm exec biome check src/application src/infra src/runtime` → clean.
- [ ] `pnpm test` → no new failures beyond documented flaky (run any new-looking failure in isolation to confirm flaky).
- [ ] Grep gate: the migrated files no longer import `getAppService` for the migrated members (partial files still may, for the logged cloud/import members).

## Done-conditions

- `LibraryRepository`/`BookRepository`/`CoverService` live, reuse the existing functions, tested, wired into both runtimes (requirement `never`).
- The ~10 E2a consumers migrated (partials logged for cloud/import members deferred to E2b/E4).
- tsgo + biome clean (modulo 2 pre-existing); `pnpm test` green (modulo flaky); legacy `AppService` untouched.

## Risks

- **Adapter `getURL` runSync** — only sync-safe where the platform `getUrl` is sync (Tauri). If tsgo/runtime shows web breakage, gate the cover sync method or keep `getCoverImageUrl` Tauri-only and have web consumers use `generateCoverImageUrl` (none of the ~10 E2a consumers use sync `getCoverImageUrl`, so low risk).
- **`CoverContext` export** / fn arities — verify against `bookService.ts`; tsgo catches mismatches.
- **`localBooksDir` snapshot staleness** after `ChangeRootDirectory` — accepted (matches legacy).
- **Partial migrations** (BookDetailModal fetchBookDetails, BackupWindow importBook) — logged, deferred to E2b/E4, never silent.
