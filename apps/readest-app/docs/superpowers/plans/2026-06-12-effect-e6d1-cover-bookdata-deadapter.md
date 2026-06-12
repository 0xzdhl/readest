# E6d-1 — Cover + Book-data de-adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the cover functions and the book-data functions as Effect-native modules on the ports, drop `makeLegacyFsAdapter` from `CoverService.layer`, `BookRepository.layer`, and `CloudService.layer` (retiring the E6c `fetchBookDetails` bridge). Purely additive — `bookService.ts`/`libraryService.ts` untouched (E6d-2 deletes them).

**Architecture:** New `src/application/services/cover/coverImages.ts` and `src/application/services/book/bookData.ts` hold Effect-native ports of the legacy `bookService.ts` fns (each `Effect.gen` yielding `FileSystem`/`PathResolver`/`Platform`, `Effect.tryPromise` for non-port async, each fn maps to `BookError({operation, bookId: book.hash, cause})` internally — exactly reproducing the layers' current `err(op, book.hash)`). The three layers become `provide<A,E>` wrappers (SettingsRepository pattern). `getCoverImageUrl` stays sync inline in `CoverService.layer` (Tauri `prefix` is async). `CloudService.layer.fetchBookDetails` injects `CloudTransfers.downloadBook` into the new Effect-native `fetchBookDetails`, mapping its `BookError` to `CloudError`.

**Tech Stack:** TypeScript (strict, ES2022), Effect TS, Vitest. Spec: `docs/superpowers/specs/2026-06-12-effect-e6d1-cover-bookdata-deadapter-design.md`.

---

## File Structure

- **Create** `src/application/services/cover/coverImages.ts` — `getCoverImageBlobUrl`, `getCachedImageUrl`, `generateCoverImageUrl`, `updateCoverImage` (+ internal `imageToArrayBuffer`).
- **Rewrite** `src/infra/shared/CoverService.layer.ts` — `provide` over `FileSystem | PathResolver | Platform`; `getCoverImageUrl` inline sync over snapshotted `localBooksDir`.
- **Create** `src/application/services/book/bookData.ts` — `loadBookContent`, `loadBookConfig`, `saveBookConfig`, `loadBookNav`, `saveBookNav`, `getBookFileSize`, `isBookAvailable`, `refreshBookMetadata`, `fetchBookDetails` (+ internal raw `openBookFile`).
- **Rewrite** `src/infra/shared/BookRepository.layer.ts` — `provide` over `FileSystem` only.
- **Rewrite** `src/infra/shared/CloudService.layer.ts` — drop `makeLegacyFsAdapter`/`BookSvc`; `fetchBookDetails` over the new module.
- **Extend** `src/__tests__/application/coverService.test.ts`, `src/__tests__/application/bookRepository.test.ts` — add a focused case each.
- **Create** `src/__tests__/application/book/fetchBookDetails.test.ts`.
- **Untouched:** `src/services/bookService.ts`, `src/services/libraryService.ts`, `src/infra/shared/fsPortAdapter.ts`.

Test-run command: `pnpm test run <path>`.

---

## Task 1: `coverImages.ts` + CoverService.layer

**Files:**

- Create: `src/application/services/cover/coverImages.ts`
- Rewrite: `src/infra/shared/CoverService.layer.ts`
- Extend: `src/__tests__/application/coverService.test.ts`

- [ ] **Step 1: Create `src/application/services/cover/coverImages.ts`** (faithful port of legacy `bookService.ts:63-134`; each public fn maps to `BookError` internally):

```typescript
import { Effect } from 'effect';
import type { Book } from '@/domain/book';
import type { AppPlatform } from '@/domain/system';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import { getCoverFilename } from '@/utils/book';
import { md5 } from '@/utils/md5';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export const getCoverImageBlobUrl = (
  book: Book,
): Effect.Effect<string, BookError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const localBooksDir = yield* resolver.prefix('Books');
    return yield* fs.getBlobUrl(`${localBooksDir}/${getCoverFilename(book)}`, 'None');
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'getCoverImageBlobUrl', bookId: book.hash, cause }),
    ),
  );

export const getCachedImageUrl = (
  pathOrUrl: string,
): Effect.Effect<string, BookError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const cachedKey = `img_${md5(pathOrUrl)}`;
    const cachePrefix = yield* resolver.prefix('Cache');
    const cachedPath = `${cachePrefix}/${cachedKey}`;
    if (yield* fs.exists(cachedPath, 'None')) {
      return yield* fs.getUrl(cachedPath);
    }
    const file = yield* fs.openFile(pathOrUrl, 'None');
    const buf = yield* Effect.tryPromise(() => file.arrayBuffer());
    yield* fs.writeFile(cachedKey, 'Cache', buf);
    return yield* fs.getUrl(cachedPath);
  }).pipe(Effect.mapError((cause) => new BookError({ operation: 'getCachedImageUrl', cause })));

// Inlines both branches (legacy generateCoverImageUrl delegated to the same two
// getBlobUrl/getUrl lines), so the whole effect maps once to 'generateCoverImageUrl'.
export const generateCoverImageUrl = (
  book: Book,
): Effect.Effect<string, BookError, FileSystem | PathResolver | Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const platform = yield* Platform;
    const info = yield* platform.info;
    const localBooksDir = yield* resolver.prefix('Books');
    const path = `${localBooksDir}/${getCoverFilename(book)}`;
    return info.appPlatform === 'web' ? yield* fs.getBlobUrl(path, 'None') : yield* fs.getUrl(path);
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'generateCoverImageUrl', bookId: book.hash, cause }),
    ),
  );

// Effect-native port of legacy imageToArrayBuffer (bookService.ts:90-120).
const imageToArrayBuffer = (
  appPlatform: AppPlatform,
  imageUrl?: string,
  imageFile?: string,
): Effect.Effect<ArrayBuffer, unknown, FileSystem> =>
  Effect.gen(function* () {
    if (!imageUrl && !imageFile) {
      return yield* Effect.fail(new Error('No image URL or file provided'));
    }
    if (appPlatform === 'web' && imageUrl && imageUrl.startsWith('blob:')) {
      return yield* Effect.tryPromise(() => fetch(imageUrl).then((r) => r.arrayBuffer()));
    }
    if (appPlatform === 'tauri' && imageFile) {
      const fs = yield* FileSystem;
      const file = yield* fs.openFile(imageFile, 'None');
      return yield* Effect.tryPromise(() => file.arrayBuffer());
    }
    if (appPlatform === 'tauri' && imageUrl) {
      return yield* Effect.tryPromise(() =>
        tauriFetch(imageUrl, { method: 'GET' }).then((r) => r.arrayBuffer()),
      );
    }
    return yield* Effect.fail(new Error('Unsupported platform or missing image data'));
  });

export const updateCoverImage = (
  book: Book,
  imageUrl?: string,
  imageFile?: string,
): Effect.Effect<void, BookError, FileSystem | Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (imageUrl === '_blank') {
      yield* fs.removeFile(getCoverFilename(book), 'Books');
    } else if (imageUrl || imageFile) {
      const platform = yield* Platform;
      const info = yield* platform.info;
      const arrayBuffer = yield* imageToArrayBuffer(info.appPlatform, imageUrl, imageFile);
      yield* fs.writeFile(getCoverFilename(book), 'Books', arrayBuffer);
    }
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'updateCoverImage', bookId: book.hash, cause }),
    ),
  );
```

- [ ] **Step 2: Rewrite `src/infra/shared/CoverService.layer.ts`:**

```typescript
import { Effect, Layer } from 'effect';
import type { Book } from '@/domain/book';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import { getCoverFilename } from '@/utils/book';
import * as CoverImages from '@/application/services/cover/coverImages';

export const CoverServiceLive = Layer.effect(
  CoverService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const platform = yield* Platform;
    const localBooksDir = yield* resolver.prefix('Books'); // cached snapshot
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem | PathResolver | Platform>) =>
      e.pipe(
        Effect.provideService(FileSystem, fsPort),
        Effect.provideService(PathResolver, resolver),
        Effect.provideService(Platform, platform),
      );
    return {
      // Sync: getUrl is a sync Effect; run it over the snapshotted localBooksDir
      // (Tauri resolver.prefix is async, so it can't be re-run under runSync).
      getCoverImageUrl: (book: Book) =>
        Effect.runSync(fsPort.getUrl(`${localBooksDir}/${getCoverFilename(book)}`)),
      getCoverImageBlobUrl: (book: Book) => provide(CoverImages.getCoverImageBlobUrl(book)),
      getCachedImageUrl: (pathOrUrl: string) => provide(CoverImages.getCachedImageUrl(pathOrUrl)),
      generateCoverImageUrl: (book: Book) => provide(CoverImages.generateCoverImageUrl(book)),
      updateCoverImage: (book: Book, imageUrl?: string, imageFile?: string) =>
        provide(CoverImages.updateCoverImage(book, imageUrl, imageFile)),
    } satisfies CoverServiceShape;
  }),
);
```

- [ ] **Step 3: Extend `src/__tests__/application/coverService.test.ts`** — add a `generateCoverImageUrl` case (the test ports use `appPlatform: 'web'`, so it routes through `getCoverImageBlobUrl`). Insert this `it` inside the existing `describe`:

```typescript
it('generateCoverImageUrl returns a string (web -> blob url)', async () => {
  const url = await run(
    Effect.flatMap(CoverService, (c) => c.generateCoverImageUrl({ hash: 'abc' } as never)),
  );
  expect(typeof url).toBe('string');
  expect(url.length).toBeGreaterThan(0);
});
```

- [ ] **Step 4: Run the cover guard**

Run: `pnpm test run src/__tests__/application/coverService.test.ts`
Expected: PASS (existing getCoverImageUrl case + new generateCoverImageUrl case).

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsgo --noEmit`
Expected: only the pre-existing `scripts/upload-cjk-fonts-r2.ts` baseline error.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/cover/coverImages.ts src/infra/shared/CoverService.layer.ts src/__tests__/application/coverService.test.ts
CI=true git commit -m "refactor(effect): E6d-1 Effect-native cover images + CoverService.layer over ports

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `bookData.ts` (BookRepository fns) + BookRepository.layer

**Files:**

- Create: `src/application/services/book/bookData.ts`
- Rewrite: `src/infra/shared/BookRepository.layer.ts`
- Extend: `src/__tests__/application/bookRepository.test.ts`

- [ ] **Step 1: Create `src/application/services/book/bookData.ts`** with the eight BookRepository fns (faithful port of legacy `bookService.ts:489-598, 625-648`). `fetchBookDetails` is added in Task 3. Internal raw `openBookFile` is shared (so `refreshMetadata` and the Task-3 `fetchBookDetails` map only once):

```typescript
import { Effect } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import { type Book, type BookConfig, type BookContent, FIXED_LAYOUT_FORMATS } from '@/domain/book';
import type { BookNav } from '@/domain/nav';
import { BookError, type FsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import {
  getDir,
  getLocalBookFilename,
  getConfigFilename,
  getBookNavFilename,
  getMetadataHash,
  formatTitle,
  getPrimaryLanguage,
} from '@/utils/book';
import { EXTS } from '@/domain/document';
import { DocumentLoader } from '@/libs/document';
import {
  DEFAULT_BOOK_SEARCH_CONFIG,
  DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS,
} from '@/services/constants';
import { isValidURL } from '@/utils/misc';
import { deserializeConfig, serializeConfig } from '@/utils/serializer';
import type { ClosableFile } from '@/utils/file';
import { BookFileNotFoundError } from '@/services/errors';

// Internal raw open: the file-resolution cascade, without BookError mapping, so
// callers (loadContent/refreshMetadata/fetchBookDetails) map exactly once.
const openBookFile = (
  book: Book,
): Effect.Effect<BookContent, FsError | BookFileNotFoundError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const fp = getLocalBookFilename(book);
    if (yield* fs.exists(fp, 'Books')) {
      return { book, file: yield* fs.openFile(fp, 'Books') };
    }
    if (book.filePath) {
      return { book, file: yield* fs.openFile(book.filePath, 'None') };
    }
    if (book.url) {
      return { book, file: yield* fs.openFile(book.url, 'None') };
    }
    // 0.9.64 bug: book.title may change without the filename being updated.
    const bookDir = getDir(book);
    const files = yield* fs.readDir(bookDir, 'Books');
    if (files.length > 0) {
      const bookFile = files.find((f) => f.path.endsWith(`.${EXTS[book.format]}`));
      if (bookFile) {
        return { book, file: yield* fs.openFile(`${bookDir}/${bookFile.path}`, 'Books') };
      }
    }
    return yield* Effect.fail(new BookFileNotFoundError());
  });

export const loadBookContent = (book: Book): Effect.Effect<BookContent, BookError, FileSystem> =>
  openBookFile(book).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'loadContent', bookId: book.hash, cause }),
    ),
  );

export const isBookAvailable = (book: Book): Effect.Effect<boolean, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const fp = getLocalBookFilename(book);
    if (yield* fs.exists(fp, 'Books')) return true;
    if (book.filePath) return yield* fs.exists(book.filePath, 'None');
    if (book.url) return isValidURL(book.url);
    return false;
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'isAvailable', bookId: book.hash, cause }),
    ),
  );

export const getBookFileSize = (book: Book): Effect.Effect<number | null, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const fp = getLocalBookFilename(book);
    if (yield* fs.exists(fp, 'Books')) {
      const file = yield* fs.openFile(fp, 'Books');
      const size = file.size;
      const f = file as ClosableFile;
      if (f && f.close) {
        yield* Effect.tryPromise(() => f.close());
      }
      return size;
    }
    return null;
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'getFileSize', bookId: book.hash, cause }),
    ),
  );

export const loadBookConfig = (
  book: Book,
  settings: SystemSettings,
): Effect.Effect<BookConfig, BookError, FileSystem> => {
  const globalViewSettings = {
    ...settings.globalViewSettings,
    ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
  };
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    let str = '{}';
    if (yield* fs.exists(getConfigFilename(book), 'Books')) {
      str = (yield* fs.readFile(getConfigFilename(book), 'Books', 'text')) as string;
    }
    return deserializeConfig(str, globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG);
  }).pipe(
    // Faithful to legacy try/catch -> default: any failure yields the default config.
    Effect.catchAll(() =>
      Effect.sync(() => deserializeConfig('{}', globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG)),
    ),
  );
};

export const saveBookConfig = (
  book: Book,
  config: BookConfig,
  settings?: SystemSettings,
): Effect.Effect<void, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    let serializedConfig: string;
    if (settings) {
      const globalViewSettings = {
        ...settings.globalViewSettings,
        ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
      };
      serializedConfig = serializeConfig(config, globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG);
    } else {
      serializedConfig = JSON.stringify(config);
    }
    yield* fs.writeFile(getConfigFilename(book), 'Books', serializedConfig);
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'saveConfig', bookId: book.hash, cause }),
    ),
  );

export const loadBookNav = (book: Book): Effect.Effect<BookNav | null, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = getBookNavFilename(book);
    if (!(yield* fs.exists(path, 'Books'))) return null;
    const str = (yield* fs.readFile(path, 'Books', 'text')) as string;
    const parsed = JSON.parse(str) as BookNav;
    if (!parsed || typeof parsed.version !== 'number') return null;
    return parsed;
  }).pipe(
    // Faithful to legacy try/catch -> null.
    Effect.catchAll(() => Effect.succeed(null)),
  );

export const saveBookNav = (book: Book, nav: BookNav): Effect.Effect<void, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.writeFile(getBookNavFilename(book), 'Books', JSON.stringify(nav));
  }).pipe(
    Effect.mapError((cause) => new BookError({ operation: 'saveNav', bookId: book.hash, cause })),
  );

export const refreshBookMetadata = (book: Book): Effect.Effect<boolean, BookError, FileSystem> =>
  Effect.gen(function* () {
    const { file } = yield* openBookFile(book);
    const { book: bookDoc } = yield* Effect.tryPromise(() => new DocumentLoader(file).open());
    if (!bookDoc) return false;

    book.metadata = bookDoc.metadata;
    book.metaHash = getMetadataHash(bookDoc.metadata);
    const primaryLanguage = getPrimaryLanguage(bookDoc.metadata.language);
    if (primaryLanguage) {
      book.primaryLanguage = primaryLanguage;
    }
    if (book.metadata?.belongsTo?.series) {
      const belongsTo = book.metadata.belongsTo.series;
      const series = Array.isArray(belongsTo) ? belongsTo[0] : belongsTo;
      if (series) {
        book.metadata.series = formatTitle(series.name);
        book.metadata.seriesIndex = parseFloat(series.position || '0');
      }
    }
    return true;
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'refreshMetadata', bookId: book.hash, cause }),
    ),
  );
```

Notes for the implementer:

- `openBookFile` is the un-mapped shared helper. If tsgo objects to `FsError` not being exported as a value, it's imported `type`-only (it is a `Data.TaggedError` class; `import { type FsError }` keeps it type-position only — fine, we never construct it here).
- Do NOT touch `src/services/bookService.ts`.

- [ ] **Step 2: Rewrite `src/infra/shared/BookRepository.layer.ts`:**

```typescript
import { Effect, Layer } from 'effect';
import { FileSystem } from '@/application/ports/FileSystem';
import {
  BookRepository,
  type BookRepositoryShape,
} from '@/application/repositories/BookRepository';
import * as BookData from '@/application/services/book/bookData';

export const BookRepositoryLive = Layer.effect(
  BookRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem>) =>
      e.pipe(Effect.provideService(FileSystem, fsPort));
    return {
      loadContent: (book) => provide(BookData.loadBookContent(book)),
      loadConfig: (book, settings) => provide(BookData.loadBookConfig(book, settings)),
      saveConfig: (book, config, settings) =>
        provide(BookData.saveBookConfig(book, config, settings)),
      loadNav: (book) => provide(BookData.loadBookNav(book)),
      saveNav: (book, nav) => provide(BookData.saveBookNav(book, nav)),
      getFileSize: (book) => provide(BookData.getBookFileSize(book)),
      isAvailable: (book) => provide(BookData.isBookAvailable(book)),
      refreshMetadata: (book) => provide(BookData.refreshBookMetadata(book)),
    } satisfies BookRepositoryShape;
  }),
);
```

- [ ] **Step 3: Extend `src/__tests__/application/bookRepository.test.ts`** — add a `loadNav` case (returns `null` for a book with no nav file; needs no settings). Insert inside the existing `describe`:

```typescript
it('loadNav returns null when no nav file exists', async () => {
  const nav = await run(
    Effect.flatMap(BookRepository, (r) =>
      r.loadNav({ hash: 'nope', format: 'EPUB', title: 'Nope' } as never),
    ),
  );
  expect(nav).toBeNull();
});
```

- [ ] **Step 4: Run the book guard**

Run: `pnpm test run src/__tests__/application/bookRepository.test.ts`
Expected: PASS (isAvailable + new loadNav cases).

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsgo --noEmit`
Expected: only the `scripts/upload-cjk-fonts-r2.ts` baseline error.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/book/bookData.ts src/infra/shared/BookRepository.layer.ts src/__tests__/application/bookRepository.test.ts
CI=true git commit -m "refactor(effect): E6d-1 Effect-native book-data + BookRepository.layer over ports

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `fetchBookDetails` + retire CloudService bridge

**Files:**

- Modify: `src/application/services/book/bookData.ts` (add `fetchBookDetails`)
- Rewrite: `src/infra/shared/CloudService.layer.ts`
- Create: `src/__tests__/application/book/fetchBookDetails.test.ts`

- [ ] **Step 1: Write the failing test** `src/__tests__/application/book/fetchBookDetails.test.ts` (mocks `@/libs/document` so no real epub is needed; drives `BookData.fetchBookDetails` over a stub `FileSystem` and a fake `downloadBook` effect):

```typescript
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { fetchBookDetails } from '@/application/services/book/bookData';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import type { Book } from '@/domain/book';

vi.mock('@/libs/document', () => ({
  DocumentLoader: class {
    constructor(_file: unknown) {}
    async open() {
      return { book: { metadata: { title: 'Mock Title' } } };
    }
  },
}));

const fileStub = () => new File([new Uint8Array(8)], 'b.epub');

// `present` flips to true once downloadBook "downloads" the file.
const makeFs = (present: { value: boolean }): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    exists: () => Effect.sync(() => present.value),
    openFile: () => Effect.succeed(fileStub()),
  } as unknown as FileSystemShape);

const run = <A>(p: Effect.Effect<A, unknown, FileSystem>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(fs)) as Effect.Effect<A, unknown, never>);

const book = (over: Partial<Book> = {}) =>
  ({ hash: 'h1', format: 'EPUB', title: 'T', ...over }) as unknown as Book;

describe('bookData.fetchBookDetails', () => {
  it('returns metadata without downloading when the file is present', async () => {
    const present = { value: true };
    const downloadBook = vi.fn(() => Effect.void);
    const meta = await run(
      fetchBookDetails(book({ uploadedAt: 123 }), downloadBook),
      makeFs(present),
    );
    expect(meta).toEqual({ title: 'Mock Title' });
    expect(downloadBook).not.toHaveBeenCalled();
  });

  it('downloads when the file is absent and the book was uploaded', async () => {
    const present = { value: false };
    const downloadBook = vi.fn((_b: Book) =>
      Effect.sync(() => {
        present.value = true; // the download writes the file
      }),
    );
    const meta = await run(
      fetchBookDetails(book({ uploadedAt: 123 }), downloadBook),
      makeFs(present),
    );
    expect(downloadBook).toHaveBeenCalledTimes(1);
    expect(meta).toEqual({ title: 'Mock Title' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test run src/__tests__/application/book/fetchBookDetails.test.ts`
Expected: FAIL — `fetchBookDetails` is not exported from `bookData` yet.

- [ ] **Step 3: Add `fetchBookDetails` to `src/application/services/book/bookData.ts`** (append after `refreshBookMetadata`; add the `BookMetadata` type import):

Add to the imports at the top of the file:

```typescript
import type { BookMetadata } from '@/domain/document';
```

Append the function:

```typescript
export const fetchBookDetails = <E, R>(
  book: Book,
  downloadBook: (b: Book) => Effect.Effect<void, E, R>,
): Effect.Effect<BookMetadata, BookError, FileSystem | R> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const fp = getLocalBookFilename(book);
    if (!(yield* fs.exists(fp, 'Books')) && book.uploadedAt) {
      yield* downloadBook(book);
    }
    const { file } = yield* openBookFile(book);
    const bookDoc = (yield* Effect.tryPromise(() => new DocumentLoader(file).open())).book;
    const f = file as ClosableFile;
    if (f && f.close) {
      yield* Effect.tryPromise(() => f.close());
    }
    return bookDoc.metadata;
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'fetchBookDetails', bookId: book.hash, cause }),
    ),
  );
```

- [ ] **Step 4: Run the new test → PASS**

Run: `pnpm test run src/__tests__/application/book/fetchBookDetails.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 5: Rewrite `src/infra/shared/CloudService.layer.ts`** to drop `makeLegacyFsAdapter`/`BookSvc` and route `fetchBookDetails` through the new module. Replace the existing `fetchBookDetails` method and the layer's imports/`legacyFs` block. The full file becomes:

```typescript
import { Effect, Layer } from 'effect';
import { CloudError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { CloudService, type CloudServiceShape } from '@/application/services/CloudService';
import * as CloudTransfers from '@/application/services/cloud/cloudTransfers';
import * as BookData from '@/application/services/book/bookData';

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
      // Effect-native fetchBookDetails (E6d-1 retires the E6c makeLegacyFsAdapter
      // bridge): inject this layer's own downloadBook; map BookError -> CloudError.
      fetchBookDetails: (book) =>
        provide(BookData.fetchBookDetails(book, (b) => CloudTransfers.downloadBook(b))).pipe(
          Effect.mapError(err('fetchBookDetails')),
        ),
    } satisfies CloudServiceShape;
  }),
);
```

- [ ] **Step 6: Run the CloudService + new fetchBookDetails guards**

Run: `pnpm test run src/__tests__/application/cloudService.test.ts src/__tests__/application/book/fetchBookDetails.test.ts`
Expected: PASS (cloudService 4 cases + fetchBookDetails 2 cases).

- [ ] **Step 7: Type-check**

Run: `pnpm exec tsgo --noEmit`
Expected: only the `scripts/upload-cjk-fonts-r2.ts` baseline error. If the `fetchBookDetails` generic `<E, R>` signature causes inference trouble at the CloudService call site, confirm `CloudTransfers.downloadBook(b)` resolves `E = CloudError`, `R = FileSystem | PathResolver` (both provided by `provide`); fix faithfully and report.

- [ ] **Step 8: Commit**

```bash
git add src/application/services/book/bookData.ts src/infra/shared/CloudService.layer.ts src/__tests__/application/book/fetchBookDetails.test.ts
CI=true git commit -m "refactor(effect): E6d-1 Effect-native fetchBookDetails; retire CloudService legacy bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Grep gates** (report actual output of each):

```bash
rg -n "makeLegacyFsAdapter" src/infra/shared/CloudService.layer.ts src/infra/shared/CoverService.layer.ts src/infra/shared/BookRepository.layer.ts
```

Expected: EMPTY (all three layers off the adapter).

```bash
rg -n "@/services/bookService" src/infra/shared/CoverService.layer.ts src/infra/shared/BookRepository.layer.ts src/infra/shared/CloudService.layer.ts
```

Expected: EMPTY (layers off legacy bookService).

```bash
rg -ln "makeLegacyFsAdapter" src --glob '!**/*.test.*'
```

Expected: exactly 4 files — `src/infra/shared/fsPortAdapter.ts` (def), `src/infra/shared/LibraryRepository.layer.ts`, `src/application/usecases/book/exportBook.ts`, `src/application/usecases/book/importBooks.ts`.

- [ ] **Step 2: Confirm bookService.ts/libraryService.ts untouched**

```bash
git diff --stat 8fba7936 HEAD -- src/services/bookService.ts src/services/libraryService.ts
```

Expected: EMPTY (no changes to either file in this slice).

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: tsgo only the `scripts/upload-cjk-fonts-r2.ts` baseline; Biome only the `SettingsDialog.tsx` `lazy` baseline. No new errors.

- [ ] **Step 4: Layer-guard + new test surface**

Run: `pnpm test run src/__tests__/application/coverService.test.ts src/__tests__/application/bookRepository.test.ts src/__tests__/application/cloudService.test.ts src/__tests__/application/book/fetchBookDetails.test.ts`
Expected: all PASS.

- [ ] **Step 5: Full suite**

Run: `pnpm test run`
Expected: green except the known env/timer-flaky set (auth-page, useBookShortcuts, theme-store import-time env, ProgressBar/ReadingRuler timer, clientRuntime/edgeTTS/opds-req sandbox, hardcover). Confirm NO new failures — in particular, the store/consumer guards (`store/reader-store`, `store/library-store`, `store/book-data-store`) and `import-metahash`/`importBooks`/`exportBook` tests (which still exercise the untouched legacy `bookService.ts`) must remain green.

- [ ] **Step 6: (No commit — verification only.)** If all gates pass, the slice is complete.

---

## Done-conditions (whole slice)

1. `CoverService.layer` / `BookRepository.layer` / `CloudService.layer` use NO `makeLegacyFsAdapter` and NO `@/services/bookService`; `rg` consumer count of `makeLegacyFsAdapter` is **3** (+ the `fsPortAdapter.ts` def).
2. `CoverServiceShape` / `BookRepositoryShape` / `CloudServiceShape` unchanged.
3. `bookService.ts` / `libraryService.ts` byte-identical to pre-slice.
4. Regression guards green (cover/book/cloud layer tests + new `fetchBookDetails` test); full suite green minus the known flaky set.
5. `pnpm lint` 0-new.
