# E6d-2 — Import/Export + Library de-adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-adapter the final three `makeLegacyFsAdapter` consumers (`importBooks`/`exportBook` usecases, `LibraryRepository.layer`) to Effect-native code and delete `bookService.ts` + `libraryService.ts`, leaving `makeLegacyFsAdapter` with zero consumers.

**Architecture:** New Effect-native modules `book/bookImport.ts` (importBook/mergeBooks/buildBookLookupIndex; `yield*`s FileSystem + CoverService + BookRepository) and `library/libraryData.ts` (load/save over the relocated `shared/json.ts` mirror). The two usecases + `LibraryRepository.layer` become thin Effect-native wrappers; the legacy god-files are deleted. Faithful ports of `src/services/bookService.ts` / `libraryService.ts`.

**Tech Stack:** TypeScript (strict, ES2022), Effect TS, Vitest. Spec: `docs/superpowers/specs/2026-06-12-effect-e6d2-import-export-library-deadapter-design.md`.

---

## File Structure

- **Move** `src/application/services/settings/json.ts` → `src/application/services/shared/json.ts` (git mv); repoint `settings/systemSettings.ts` + `__tests__/application/settingsJson.test.ts`.
- **Create** `src/application/services/library/libraryData.ts`; **rewrite** `src/infra/shared/LibraryRepository.layer.ts`; **delete** `src/services/libraryService.ts` (Task 4).
- **Rewrite** `src/application/usecases/book/exportBook.ts`; **repoint** `__tests__/application/book/exportBook.test.ts`.
- **Create** `src/application/services/book/bookImport.ts`; **rewrite** `src/application/usecases/book/importBooks.ts`; **repoint** `__tests__/application/book/importBooks.test.ts` + `__tests__/services/import-metahash.test.ts`.
- **Delete** `src/services/bookService.ts` (Task 4).

Test-run command: `pnpm test run <path>`.

---

## Task 1: Relocate json + Library de-adapter

**Files:**

- Move: `src/application/services/settings/json.ts` → `src/application/services/shared/json.ts`
- Modify: `src/application/services/settings/systemSettings.ts`, `src/__tests__/application/settingsJson.test.ts`
- Create: `src/application/services/library/libraryData.ts`
- Rewrite: `src/infra/shared/LibraryRepository.layer.ts`

- [ ] **Step 1: Relocate the json mirror**

```bash
git mv src/application/services/settings/json.ts src/application/services/shared/json.ts
```

Then update the two importers. In `src/application/services/settings/systemSettings.ts`, change the import specifier `'./json'` to `'@/application/services/shared/json'` (keep the imported names `safeLoadJsonE`, `safeSaveJsonE` unchanged). In `src/__tests__/application/settingsJson.test.ts`, change `'@/application/services/settings/json'` to `'@/application/services/shared/json'`.

- [ ] **Step 2: Create `src/application/services/library/libraryData.ts`** (faithful port of `libraryService.ts`; maps to `BookError` internally):

```typescript
import { Effect } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { CoverService } from '@/application/services/CoverService';
import { getLibraryFilename } from '@/utils/book';
import { safeLoadJsonE, safeSaveJsonE } from '@/application/services/shared/json';

const COVER_CONCURRENCY = 20;

export const loadLibraryBooks = (): Effect.Effect<Book[], BookError, FileSystem | CoverService> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const cover = yield* CoverService;
    if (!(yield* fs.exists('', 'Books'))) {
      yield* fs.createDir('', 'Books', true);
    }
    const books = yield* safeLoadJsonE<Book[]>(getLibraryFilename(), 'Books', []);
    yield* Effect.forEach(
      books,
      (book) =>
        Effect.gen(function* () {
          book.coverImageUrl = yield* cover.generateCoverImageUrl(book);
          book.updatedAt ??= book.lastUpdated || Date.now();
        }),
      { concurrency: COVER_CONCURRENCY, discard: true },
    );
    return books;
  }).pipe(Effect.mapError((cause) => new BookError({ operation: 'loadLibrary', cause })));

export const saveLibraryBooks = (books: Book[]): Effect.Effect<void, BookError, FileSystem> =>
  Effect.gen(function* () {
    const libraryBooks = books.map(({ coverImageUrl: _coverImageUrl, ...rest }) => rest);
    yield* safeSaveJsonE(getLibraryFilename(), 'Books', libraryBooks);
  }).pipe(Effect.mapError((cause) => new BookError({ operation: 'saveLibrary', cause })));
```

Note: `book.lastUpdated` is a legacy optional field on `Book` (the legacy `libraryService` used it and compiled); if tsgo flags it, confirm `Book.lastUpdated?: number` exists in `@/domain/book` and keep the expression as-is.

- [ ] **Step 3: Rewrite `src/infra/shared/LibraryRepository.layer.ts`:**

```typescript
import { Effect, Layer } from 'effect';
import type { Book } from '@/domain/book';
import { FileSystem } from '@/application/ports/FileSystem';
import { CoverService } from '@/application/services/CoverService';
import {
  LibraryRepository,
  type LibraryRepositoryShape,
} from '@/application/repositories/LibraryRepository';
import * as LibraryData from '@/application/services/library/libraryData';

export const LibraryRepositoryLive = Layer.effect(
  LibraryRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const cover = yield* CoverService;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem | CoverService>) =>
      e.pipe(Effect.provideService(FileSystem, fsPort), Effect.provideService(CoverService, cover));
    return {
      load: provide(LibraryData.loadLibraryBooks()),
      save: (books) => provide(LibraryData.saveLibraryBooks(books as Book[])),
    } satisfies LibraryRepositoryShape;
  }),
);
```

- [ ] **Step 4: Run the Library + settings-json guards**

Run: `pnpm test run src/__tests__/application/libraryRepository.test.ts src/__tests__/application/settingsJson.test.ts src/__tests__/application/settingsRepository.test.ts`
Expected: PASS (libraryRepository load→[]; settingsJson unchanged; settingsRepository still uses the relocated json).

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsgo --noEmit`
Expected: only the `scripts/upload-cjk-fonts-r2.ts` baseline error.

- [ ] **Step 6: Commit**

```bash
git add -A
CI=true git commit -m "refactor(effect): E6d-2 relocate json to shared/ + Effect-native Library over ports

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: exportBook usecase de-adapter

**Files:**

- Rewrite: `src/application/usecases/book/exportBook.ts`
- Repoint: `src/__tests__/application/book/exportBook.test.ts`

- [ ] **Step 1: Repoint the test** `src/__tests__/application/book/exportBook.test.ts` (the usecase no longer calls `bookService.exportBook`; mock `BookData.loadBookContent` to a stub file and exercise the usecase's resolveFilePath/copyFile/saveFile wiring). Replace the whole file:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect, Layer, ManagedRuntime, Option } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { Dialog, type DialogShape } from '@/application/ports/Dialog';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PlatformError } from '@/application/errors/AppError';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import type { Book } from '@/domain/book';

// The usecase loads the book file via BookData.loadBookContent; stub it so we
// exercise the resolveFilePath/copyFile/saveFile wiring, not real doc loading.
vi.mock('@/application/services/book/bookData', () => ({
  loadBookContent: vi.fn(() =>
    Effect.succeed({
      book: {} as Book,
      file: new File([new Uint8Array(8)], 'b.epub', { type: 'application/epub+zip' }),
    }),
  ),
}));

import { exportBook } from '@/application/usecases/book/exportBook';

const book = { hash: 'h1', format: 'EPUB', title: 'T' } as unknown as Book;

const FsStub = Layer.succeed(FileSystem, {
  copyFile: () => Effect.void,
} as unknown as FileSystemShape);

const makeRuntime = (dialog: Layer.Layer<Dialog>) => {
  const Ports = Layer.mergeAll(FsStub, Layer.provideMerge(TestPathResolverLive, PathStateLive));
  return ManagedRuntime.make(Layer.merge(Ports, dialog));
};

const dialogWith = (saveFile: DialogShape['saveFile']): Layer.Layer<Dialog> =>
  Layer.succeed(Dialog, {
    ask: () => Effect.succeed(true),
    selectDirectory: () => Effect.succeed(Option.none()),
    selectFiles: () => Effect.succeed([]),
    saveFile,
  } satisfies DialogShape);

describe('exportBook usecase', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when the dialog saved (Option.some)', async () => {
    const rt = makeRuntime(dialogWith(() => Effect.succeed(Option.some('/saved/out.epub'))));
    expect(await rt.runPromise(exportBook(book))).toBe(true);
  });

  it('returns false when the dialog was cancelled (Option.none)', async () => {
    const rt = makeRuntime(dialogWith(() => Effect.succeed(Option.none())));
    expect(await rt.runPromise(exportBook(book))).toBe(false);
  });

  it('rejects when the dialog saveFile fails with a PlatformError', async () => {
    const rt = makeRuntime(
      dialogWith(() =>
        Effect.fail(new PlatformError({ operation: 'saveFile', cause: new Error('disk full') })),
      ),
    );
    await expect(rt.runPromise(exportBook(book))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails** (usecase still calls legacy path / mock target mismatch)

Run: `pnpm test run src/__tests__/application/book/exportBook.test.ts`
Expected: FAIL (the current usecase imports `@/services/bookService`, not `bookData`; the mock won't intercept and the real `loadBookContent` path / `makeLegacyFsAdapter` differs).

- [ ] **Step 3: Rewrite `src/application/usecases/book/exportBook.ts`:**

```typescript
import { Effect, Option } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Dialog } from '@/application/ports/Dialog';
import * as BookData from '@/application/services/book/bookData';
import { getLocalBookFilename } from '@/utils/book';
import { makeSafeFilename } from '@/utils/misc';
import { getFilename } from '@/utils/path';

/**
 * Export a book file via the platform save dialog. Effect-native port of the
 * legacy bookService.exportBook + its usecase callbacks: loadBookContent (BookData),
 * resolveFilePath -> PathResolver, copyFile -> FileSystem, saveFile -> Dialog
 * (Option.isSome => boolean "saved?").
 */
export const exportBook = (
  book: Book,
): Effect.Effect<boolean, BookError, FileSystem | PathResolver | Dialog> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const dialog = yield* Dialog;

    const { file } = yield* BookData.loadBookContent(book);
    const content = yield* Effect.tryPromise(() => file.arrayBuffer());
    const filename = `${makeSafeFilename(book.title)}.${book.format.toLowerCase()}`;
    let filePath = yield* resolver.absolute(getLocalBookFilename(book), 'Books');
    const mimeType = file.type || 'application/octet-stream';
    if (getFilename(filePath) !== filename) {
      yield* fs.copyFile(filePath, 'None', filename, 'Temp');
      filePath = yield* resolver.absolute(filename, 'Temp');
    }
    return yield* dialog
      .saveFile(filename, content, { filePath, mimeType })
      .pipe(Effect.map(Option.isSome));
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'exportBook', bookId: book.hash, cause }),
    ),
  );
```

- [ ] **Step 4: Run the test → PASS**

Run: `pnpm test run src/__tests__/application/book/exportBook.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsgo --noEmit`
Expected: only the baseline. Note: `makeSafeFilename` is exported from `@/utils/misc`; `getLocalBookFilename` from `@/utils/book`; `getFilename` from `@/utils/path`.

- [ ] **Step 6: Commit**

```bash
git add src/application/usecases/book/exportBook.ts src/__tests__/application/book/exportBook.test.ts
CI=true git commit -m "refactor(effect): E6d-2 Effect-native exportBook usecase over ports

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: bookImport.ts + importBooks usecase (the large, fidelity-critical task)

**Files:**

- Create: `src/application/services/book/bookImport.ts`
- Rewrite: `src/application/usecases/book/importBooks.ts`
- Repoint: `src/__tests__/application/book/importBooks.test.ts`, `src/__tests__/services/import-metahash.test.ts`

- [ ] **Step 1: Create `src/application/services/book/bookImport.ts`** — faithful Effect-native port of legacy `bookService.ts` `buildBookLookupIndex` (42-55), `mergeBooks` (147-208), `importBook` (223-485). `importBook` `yield*`s `FileSystem` + `CoverService` + `BookRepository` (callbacks removed); JSON.parse of config strings is wrapped in `Effect.try` so corrupt configs surface as failures (not defects); best-effort branches (svg2png, copyFile→writeFile fallback) preserved via `Effect.catchAll`; outer `tapError(console.error)` + `mapError → BookError('importBook')` mirror the legacy outer try/catch.

```typescript
import { Effect } from 'effect';
import {
  type Book,
  type BookConfig,
  type BookFormat,
  type BookLookupIndex,
  type BookNote,
  INIT_BOOK_CONFIG,
  type ImportBookOptions,
} from '@/domain/book';
import type { BookDoc } from '@/domain/document';
import { BookError, type FsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { CoverService } from '@/application/services/CoverService';
import { BookRepository } from '@/application/repositories/BookRepository';
import {
  getDir,
  getLocalBookFilename,
  getCoverFilename,
  getConfigFilename,
  formatTitle,
  formatAuthors,
  getPrimaryLanguage,
  getMetadataHash,
} from '@/utils/book';
import { partialMd5, md5 } from '@/utils/md5';
import { getBaseFilename, getFilename } from '@/utils/path';
import { DocumentLoader } from '@/libs/document';
import {
  isPseStreamFileName,
  openPseStreamBook,
  parsePseStreamFileName,
} from '@/services/opds/pseStream';
import { isContentURI, isValidURL } from '@/utils/misc';
import type { ClosableFile } from '@/utils/file';
import { TxtToEpubConverter } from '@/utils/txt';
import { svg2png } from '@/utils/svg';
import { normalizeMetadataIsbn } from '@/utils/isbn';

export function buildBookLookupIndex(books: Book[]): BookLookupIndex {
  const byHash = new Map<string, Book>();
  const byMetaKey = new Map<string, Book[]>();
  for (const book of books) {
    byHash.set(book.hash, book);
    if (book.metaHash && !book.deletedAt) {
      const key = `${book.metaHash}:${book.format}`;
      const list = byMetaKey.get(key);
      if (list) list.push(book);
      else byMetaKey.set(key, [book]);
    }
  }
  return { byHash, byMetaKey };
}

// Internal: merge duplicate entries sharing metaHash+format; returns the merged
// config JSON (or undefined). Per-config read/parse is best-effort (corrupt
// configs ignored), faithful to legacy try/catch.
const mergeBooks = (
  books: Book[],
  book: Book,
  lookupIndex?: BookLookupIndex,
): Effect.Effect<string | undefined, FsError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (!book.metaHash) return undefined;

    const metaKey = `${book.metaHash}:${book.format}`;
    const duplicates = lookupIndex
      ? (lookupIndex.byMetaKey.get(metaKey) ?? []).filter((b) => !b.deletedAt && b !== book)
      : books.filter(
          (b) =>
            b.metaHash === book.metaHash && b.format === book.format && !b.deletedAt && b !== book,
        );
    if (duplicates.length === 0) return undefined;

    const allCandidates = [book, ...duplicates];
    const configs: Partial<BookConfig>[] = [];
    for (const candidate of allCandidates) {
      const configPath = getConfigFilename(candidate);
      if (yield* fs.exists(configPath, 'Books')) {
        const parsed = yield* fs.readFile(configPath, 'Books', 'text').pipe(
          Effect.flatMap((str) =>
            Effect.try(() => JSON.parse(str as string) as Partial<BookConfig>),
          ),
          Effect.catchAll(() => Effect.succeed(undefined)),
        );
        if (parsed !== undefined) configs.push(parsed);
      }
    }

    let mergedConfigData: string | undefined;
    if (configs.length > 0) {
      const base = configs.reduce((best, cfg) => {
        const bestPage = best.progress?.[0] ?? 0;
        const cfgPage = cfg.progress?.[0] ?? 0;
        return cfgPage > bestPage ? cfg : best;
      });
      const noteMap = new Map<string, BookNote>();
      for (const cfg of configs) {
        for (const note of cfg.booknotes ?? []) {
          const existing = noteMap.get(note.id);
          if (!existing || (note.updatedAt || 0) > (existing.updatedAt || 0)) {
            noteMap.set(note.id, note);
          }
        }
      }
      base.booknotes = [...noteMap.values()];
      mergedConfigData = JSON.stringify(base);
    }

    for (const dup of duplicates) {
      dup.deletedAt = Date.now();
      const dupDir = getDir(dup);
      if (yield* fs.exists(dupDir, 'Books')) {
        yield* fs.removeDir(dupDir, 'Books', true);
      }
    }
    return mergedConfigData;
  });

export const importBook = (
  file: string | File,
  books: Book[],
  options: ImportBookOptions & { lookupIndex?: BookLookupIndex } = {},
): Effect.Effect<Book | null, BookError, FileSystem | CoverService | BookRepository> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const coverSvc = yield* CoverService;
    const bookRepo = yield* BookRepository;
    const {
      saveBook = true,
      saveCover = true,
      overwrite = false,
      transient = false,
      lookupIndex,
    } = options;
    const isPseStream = typeof file === 'string' && isPseStreamFileName(file);

    if (transient && typeof file !== 'string') {
      return yield* Effect.fail(new Error('Transient import is only supported for file paths'));
    }

    // --- open (errors wrapped as "Failed to open the book file: <msg>") ---
    const opened = yield* Effect.gen(function* () {
      let loadedBook: BookDoc;
      let format: BookFormat;
      let filename: string;
      let fileobj: File | undefined;
      if (isPseStream) {
        const r = yield* Effect.tryPromise(() =>
          openPseStreamBook(parsePseStreamFileName(file as string)),
        );
        loadedBook = r.book;
        format = r.format;
        filename = file as string;
      } else {
        if (typeof file === 'string') {
          fileobj = yield* fs.openFile(file, 'None');
          filename = fileobj.name || getFilename(file);
        } else {
          fileobj = file;
          filename = file.name;
        }
        if (/\.txt$/i.test(filename)) {
          const conv = yield* Effect.tryPromise(() =>
            new TxtToEpubConverter().convert({ file: fileobj! }),
          );
          fileobj = conv.file;
        }
        if (!fileobj || fileobj.size === 0) {
          return yield* Effect.fail(new Error('Invalid or empty book file'));
        }
        const r = yield* Effect.tryPromise(() => new DocumentLoader(fileobj!).open());
        loadedBook = r.book;
        format = r.format;
      }
      if (!loadedBook) {
        return yield* Effect.fail(new Error('Unsupported or corrupted book file'));
      }
      normalizeMetadataIsbn(loadedBook.metadata);
      const metadataTitle = formatTitle(loadedBook.metadata.title);
      if (!metadataTitle || !metadataTitle.trim() || metadataTitle === filename) {
        loadedBook.metadata.title = getBaseFilename(filename);
      }
      return { loadedBook, format, filename, fileobj };
    }).pipe(
      Effect.mapError(
        (error) => new Error(`Failed to open the book file: ${(error as Error).message || error}`),
      ),
    );

    const { loadedBook, format, filename, fileobj } = opened;

    const hash = isPseStream
      ? md5(file as string)
      : yield* Effect.tryPromise(() => partialMd5(fileobj!));

    const metaHash = getMetadataHash(loadedBook.metadata);
    let existingBook = lookupIndex
      ? lookupIndex.byHash.get(hash)
      : books.find((b) => b.hash === hash);
    let metaHashMatch = false;
    let oldBookDir: string | undefined;
    if (existingBook) {
      if (!transient) existingBook.deletedAt = null;
      existingBook.createdAt = Date.now();
      existingBook.updatedAt = Date.now();
    }

    let bestConfigData: string | undefined;
    if (!transient && metaHash) {
      if (!existingBook) {
        const metaKey = `${metaHash}:${format}`;
        const firstMatch = lookupIndex
          ? (lookupIndex.byMetaKey.get(metaKey) ?? []).find((b) => !b.deletedAt)
          : books.find((b) => b.metaHash === metaHash && b.format === format && !b.deletedAt);
        if (firstMatch) {
          oldBookDir = getDir(firstMatch);
          existingBook = firstMatch;
          metaHashMatch = true;
          existingBook.createdAt = Date.now();
          existingBook.updatedAt = Date.now();
        }
      }
      if (existingBook) {
        bestConfigData = yield* mergeBooks(books, existingBook, lookupIndex);
      }
    }

    const primaryLanguage = getPrimaryLanguage(loadedBook.metadata.language);
    const book: Book = {
      hash,
      format,
      metaHash,
      title: formatTitle(loadedBook.metadata.title),
      sourceTitle: formatTitle(loadedBook.metadata.title),
      primaryLanguage,
      author: formatAuthors(loadedBook.metadata.author, primaryLanguage),
      metadata: loadedBook.metadata,
      createdAt: existingBook ? existingBook.createdAt : Date.now(),
      uploadedAt: existingBook ? existingBook.uploadedAt : null,
      deletedAt: transient ? Date.now() : null,
      downloadedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (book.metadata?.belongsTo?.series) {
      const belongsTo = book.metadata.belongsTo.series;
      const series = Array.isArray(belongsTo) ? belongsTo[0] : belongsTo;
      if (series) {
        book.metadata.series = formatTitle(series.name);
        book.metadata.seriesIndex = parseFloat(series.position || '0');
      }
    }
    if (existingBook && metaHashMatch) {
      existingBook.hash = hash;
      existingBook.format = book.format;
      existingBook.metaHash = metaHash;
      existingBook.title = book.title;
      existingBook.sourceTitle = book.sourceTitle;
      existingBook.author = book.author;
      existingBook.primaryLanguage = book.primaryLanguage;
      existingBook.metadata = book.metadata;
      existingBook.uploadedAt = null;
      existingBook.downloadedAt = Date.now();
    } else if (existingBook) {
      existingBook.format = book.format;
      existingBook.metaHash = metaHash;
      existingBook.title = existingBook.title.trim() ? existingBook.title.trim() : book.title;
      existingBook.sourceTitle = existingBook.sourceTitle ?? book.sourceTitle;
      existingBook.author = existingBook.author ?? book.author;
      existingBook.primaryLanguage = existingBook.primaryLanguage ?? book.primaryLanguage;
      existingBook.metadata = book.metadata;
      existingBook.downloadedAt = Date.now();
    }

    if (!(yield* fs.exists(getDir(book), 'Books'))) {
      yield* fs.createDir(getDir(book), 'Books');
    }
    const bookFilename = getLocalBookFilename(book);
    if (
      saveBook &&
      !transient &&
      fileobj &&
      (!(yield* fs.exists(bookFilename, 'Books')) || overwrite)
    ) {
      if (/\.txt$/i.test(filename)) {
        yield* fs.writeFile(bookFilename, 'Books', fileobj);
      } else if (typeof file === 'string' && isContentURI(file)) {
        yield* fs.copyFile(file, 'None', bookFilename, 'Books');
      } else if (typeof file === 'string' && !isValidURL(file)) {
        // Try a direct copy first (large files); fall back to read+write on failure.
        yield* fs.copyFile(file, 'None', bookFilename, 'Books').pipe(
          Effect.catchAll(() =>
            Effect.gen(function* () {
              const buf = yield* Effect.tryPromise(() => fileobj!.arrayBuffer());
              yield* fs.writeFile(bookFilename, 'Books', buf);
            }),
          ),
        );
      } else {
        yield* fs.writeFile(bookFilename, 'Books', fileobj);
      }
    }
    if (saveCover && (!(yield* fs.exists(getCoverFilename(book), 'Books')) || overwrite)) {
      let coverBlob = yield* Effect.tryPromise(() => loadedBook.getCover());
      if (coverBlob?.type === 'image/svg+xml') {
        const original = coverBlob;
        coverBlob = yield* Effect.gen(function* () {
          yield* Effect.sync(() => console.log('Converting SVG cover to PNG...'));
          return yield* Effect.tryPromise(() => svg2png(original));
        }).pipe(Effect.catchAll(() => Effect.succeed(original)));
      }
      if (coverBlob) {
        const buf = yield* Effect.tryPromise(() => coverBlob!.arrayBuffer());
        yield* fs.writeFile(getCoverFilename(book), 'Books', buf);
      }
    }
    // Config: only write INIT when the book is new; otherwise migrate/adopt config.
    if (!existingBook) {
      yield* bookRepo.saveConfig(book, INIT_BOOK_CONFIG);
      books.push(book);
      if (lookupIndex) {
        lookupIndex.byHash.set(book.hash, book);
        if (book.metaHash) {
          const key = `${book.metaHash}:${book.format}`;
          const list = lookupIndex.byMetaKey.get(key);
          if (list) list.push(book);
          else lookupIndex.byMetaKey.set(key, [book]);
        }
      }
    } else if (metaHashMatch && oldBookDir && oldBookDir !== getDir(book)) {
      if (bestConfigData) {
        const config = yield* Effect.try(() => JSON.parse(bestConfigData!) as Partial<BookConfig>);
        config.bookHash = hash;
        config.metaHash = metaHash;
        yield* fs.writeFile(getConfigFilename(book), 'Books', JSON.stringify(config));
      } else {
        const oldConfigPath = `${oldBookDir}/config.json`;
        if (yield* fs.exists(oldConfigPath, 'Books')) {
          const configData = (yield* fs.readFile(oldConfigPath, 'Books', 'text')) as string;
          const config = yield* Effect.try(() => JSON.parse(configData) as Partial<BookConfig>);
          config.bookHash = hash;
          config.metaHash = metaHash;
          yield* fs.writeFile(getConfigFilename(book), 'Books', JSON.stringify(config));
        } else {
          yield* bookRepo.saveConfig(book, INIT_BOOK_CONFIG);
        }
      }
      if (yield* fs.exists(oldBookDir, 'Books')) {
        yield* fs.removeDir(oldBookDir, 'Books', true);
      }
    } else if (bestConfigData) {
      const config = yield* Effect.try(() => JSON.parse(bestConfigData!) as Partial<BookConfig>);
      config.bookHash = hash;
      config.metaHash = metaHash;
      yield* fs.writeFile(getConfigFilename(book), 'Books', JSON.stringify(config));
    }

    if (isPseStream) {
      book.url = file as string;
      if (existingBook) existingBook.url = file as string;
    } else if (typeof file === 'string') {
      if (isValidURL(file)) {
        book.url = file;
        if (existingBook) existingBook.url = file;
      }
      if (transient) {
        book.filePath = file;
        if (existingBook) existingBook.filePath = file;
      }
    }
    book.coverImageUrl = yield* coverSvc.generateCoverImageUrl(book);
    const f = file as unknown as ClosableFile;
    if (f && f.close) {
      yield* Effect.tryPromise(() => f.close());
    }

    return existingBook || book;
  }).pipe(
    Effect.tapError((cause) => Effect.sync(() => console.error('Error importing book:', cause))),
    Effect.mapError((cause) => new BookError({ operation: 'importBook', cause })),
  );
```

Notes for the implementer:

- Verify the port against legacy `bookService.ts:42-55, 147-208, 223-485` line-by-line.
- The `let loadedBook: BookDoc; let format: BookFormat;` definite-assignment mirrors legacy (compiles because both branches assign before use); if tsgo complains, initialize via the same destructuring pattern legacy used.
- `coverSvc` (the CoverService) is named distinctly from `coverBlob` (the cover image Blob) to avoid shadowing.
- Do NOT export `mergeBooks` (internal). Export `buildBookLookupIndex` + `importBook`.

- [ ] **Step 2: Rewrite `src/application/usecases/book/importBooks.ts`** (drop `makeLegacyFsAdapter` + callbacks; call the Effect-native `importBook`):

```typescript
import { Effect, Either } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { BookRepository } from '@/application/repositories/BookRepository';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { CoverService } from '@/application/services/CoverService';
import * as BookImport from '@/application/services/book/bookImport';

export interface ImportBookInput {
  file: string | File;
  path?: string;
  basePath?: string;
}

export interface ImportBooksOptions {
  transient?: boolean;
  saveBook?: boolean;
  saveCover?: boolean;
  overwrite?: boolean;
  concurrency?: number;
  persist?: boolean;
  onImported?: (book: Book, input: ImportBookInput) => void;
  onBatch?: (imported: Book[]) => void;
}

export interface ImportBooksResult {
  library: Book[];
  imported: Book[];
  failed: Array<{ filename: string; error: unknown }>;
}

const filenameOf = (file: string | File): string => (typeof file === 'string' ? file : file.name);

/**
 * Import 1..N books then optionally persist library.json. Reuses the Effect-native
 * bookImport.importBook (which yields CoverService + BookRepository internally).
 * The `books` array is mutated in place (faithful to legacy) and is what gets
 * persisted. Grouping is left to the consumer via `onImported`.
 */
export const importBooks = (
  books: Book[],
  inputs: ReadonlyArray<ImportBookInput>,
  options: ImportBooksOptions = {},
): Effect.Effect<
  ImportBooksResult,
  BookError,
  BookRepository | CoverService | FileSystem | LibraryRepository
> =>
  Effect.gen(function* () {
    const library = yield* LibraryRepository;

    const { transient, saveBook, saveCover, overwrite, onImported, onBatch } = options;
    const concurrency = options.concurrency ?? 4;
    const persist = options.persist ?? true;

    const lookupIndex = BookImport.buildBookLookupIndex(books);
    const imported: Book[] = [];
    const failed: Array<{ filename: string; error: unknown }> = [];

    const importOne = (input: ImportBookInput) =>
      BookImport.importBook(input.file, books, {
        lookupIndex,
        saveBook,
        saveCover,
        overwrite,
        transient,
      }).pipe(
        Effect.either,
        Effect.map((result) => ({ input, result })),
      );

    for (let i = 0; i < inputs.length; i += concurrency) {
      const batch = inputs.slice(i, i + concurrency);
      const results = yield* Effect.all(batch.map(importOne), { concurrency });
      const importedThisBatch: Book[] = [];
      for (const { input, result } of results) {
        if (Either.isLeft(result)) {
          // Record the original thrown error (BookError.cause), not the wrapper.
          failed.push({ filename: filenameOf(input.file), error: result.left.cause });
        } else if (result.right) {
          imported.push(result.right);
          importedThisBatch.push(result.right);
          onImported?.(result.right, input);
        }
      }
      if (importedThisBatch.length > 0) onBatch?.(importedThisBatch);
    }

    if (persist && imported.length > 0) {
      yield* library.save(books);
    }

    return { library: books, imported, failed };
  });
```

- [ ] **Step 3: Repoint `src/__tests__/application/book/importBooks.test.ts`** — change the `vi.mock` target from `@/services/bookService` to the new module; the mock `importBook` becomes an `Effect.gen` that yields `BookRepository` + `CoverService`.

Replace the ENTIRE top of the file — from line 1 through the `import { importBooks } from '@/application/usecases/book/importBooks';` line inclusive (which includes the original `mkBook` definition and the old `vi.mock('@/services/bookService', …)` block) — with this block (it redefines `mkBook` once, so there will be no duplicate):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import {
  BookRepository,
  type BookRepositoryShape,
} from '@/application/repositories/BookRepository';
import {
  LibraryRepository,
  type LibraryRepositoryShape,
} from '@/application/repositories/LibraryRepository';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import { BookError } from '@/application/errors/AppError';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import type { Book, BookConfig } from '@/domain/book';

const mkBook = (hash: string): Book => ({ hash, format: 'EPUB', title: hash }) as unknown as Book;

// Mock the Effect-native importBook to exercise the usecase's loop/persist/
// callbacks without real document parsing. The mock yields BookRepository +
// CoverService (provided by the runtime) so the saveConfig/cover wiring is
// still validated. buildBookLookupIndex stays real.
vi.mock('@/application/services/book/bookImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/application/services/book/bookImport')>();
  return {
    ...actual,
    importBook: vi.fn((file: string | File, books: Book[]) =>
      Effect.gen(function* () {
        const name = typeof file === 'string' ? file : file.name;
        if (name === 'fail') {
          return yield* Effect.fail(
            new BookError({ operation: 'importBook', cause: new Error('boom') }),
          );
        }
        const b = mkBook(name);
        const bookRepo = yield* BookRepository;
        const cover = yield* CoverService;
        yield* bookRepo.saveConfig(b, {} as BookConfig);
        b.coverImageUrl = yield* cover.generateCoverImageUrl(b);
        books.push(b);
        return b;
      }),
    ),
  };
});

import { importBooks } from '@/application/usecases/book/importBooks';
```

Keep the rest of the file (the `saved`/`savedConfigs` arrays, `makeRuntime`, and all 5 `it` blocks) UNCHANGED — the stub layers (`BookRepoStub.saveConfig`, `CoverStub.generateCoverImageUrl`, `LibraryStub.save`) already record into `savedConfigs`/`saved`, and the mocked `importBook` now drives them.

- [ ] **Step 4: Repoint `src/__tests__/services/import-metahash.test.ts`** — preserve ALL 16 assertions + every `mockFs`/`mockResolvedValue`/`mockImplementation` by wrapping the legacy-shape `mockFs` into an Effect `FileSystem` layer (a Promise→Effect adapter) and providing the REAL `BookRepositoryLive` over it (so `saveConfig` writes flow through `mockFs.writeFile`, mirroring the old real `saveBookConfig`). Only the imports + the local `importBook` helper change.

Replace the `import * as BookSvc ...` / `buildBookLookupIndex` import block (lines ~42-43) and the local `importBook` helper (lines ~63-82) with:

```typescript
import { Effect, Layer } from 'effect';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { CoverService, type CoverServiceShape } from '@/application/services/CoverService';
import { BookRepositoryLive } from '@/infra/shared/BookRepository.layer';
import { importBook as importBookEffect } from '@/application/services/book/bookImport';

// Wrap the legacy-shape Promise mockFs into an Effect FileSystem layer so the
// existing vi.fn assertions (mockResolvedValue / mockImplementation / .mock.calls)
// all keep working unchanged. Each port method calls the matching mockFs method.
const fsLayerFromMock = (mockFs: MockFs): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    openFile: (p: string, b: string, f?: string) =>
      Effect.tryPromise(() => mockFs.openFile(p, b, f)),
    readFile: (p: string, b: string, m: string) =>
      Effect.tryPromise(() => mockFs.readFile(p, b, m)),
    writeFile: (p: string, b: string, c: unknown) =>
      Effect.tryPromise(() => mockFs.writeFile(p, b, c)),
    copyFile: (s: string, sb: string, d: string, db: string) =>
      Effect.tryPromise(() => mockFs.copyFile(s, sb, d, db)),
    removeFile: (p: string, b: string) => Effect.tryPromise(() => mockFs.removeFile(p, b)),
    createDir: (p: string, b: string, r?: boolean) =>
      Effect.tryPromise(() => mockFs.createDir(p, b, r)),
    removeDir: (p: string, b: string, r?: boolean) =>
      Effect.tryPromise(() => mockFs.removeDir(p, b, r)),
    readDir: (p: string, b: string) => Effect.tryPromise(() => mockFs.readDir(p, b)),
    exists: (p: string, b: string) => Effect.tryPromise(() => mockFs.exists(p, b)),
    stat: (p: string, b: string) => Effect.tryPromise(() => mockFs.stats(p, b)),
    getUrl: (p: string) => Effect.sync(() => mockFs.getURL(p)),
    getBlobUrl: (p: string, b: string) => Effect.tryPromise(() => mockFs.getBlobURL(p, b)),
  } as unknown as FileSystemShape);

const CoverStub = Layer.succeed(CoverService, {
  getCoverImageUrl: () => '',
  getCoverImageBlobUrl: () => Effect.succeed(''),
  getCachedImageUrl: () => Effect.succeed(''),
  generateCoverImageUrl: () => Effect.succeed(''),
  updateCoverImage: () => Effect.void,
} as unknown as CoverServiceShape);

// Drive the Effect-native importBook through the adapter layer. saveConfig is the
// REAL BookRepository.saveConfig over the same FileSystem (writes config via
// mockFs.writeFile), faithful to the legacy injected saveBookConfig.
function importBook(
  fs: MockFs,
  file: string | File,
  books: Book[],
  options: {
    transient?: boolean;
    saveBook?: boolean;
    saveCover?: boolean;
    overwrite?: boolean;
  } = {},
): Promise<Book | null> {
  const FsLayer = fsLayerFromMock(fs);
  const layers = Layer.mergeAll(FsLayer, CoverStub, Layer.provide(BookRepositoryLive, FsLayer));
  return Effect.runPromise(
    importBookEffect(file, books, options).pipe(Effect.provide(layers)) as Effect.Effect<
      Book | null,
      unknown,
      never
    >,
  );
}
```

Keep EVERYTHING ELSE in the file unchanged: `makeMockFs`, `makeBook`, `setupMockBookDoc`, the `vi.mock('@/libs/document')` / `@/utils/md5` / `@/utils/txt` / `@/utils/svg` / `@tauri-apps/plugin-http` / `@/libs/storage` mocks, the `beforeEach` `fs.exists.mockResolvedValue(false)` setup, and ALL `it` blocks with their 16 assertions. **The old block imported `buildBookLookupIndex`/`* as BookSvc` from `@/services/bookService` — remove those imports entirely.** If any test body still references `buildBookLookupIndex`, re-import it from `@/application/services/book/bookImport`; if it references `BookSvc.*`, that path no longer exists — repoint to the new module (the Task-4 `rg "@/services/bookService"` gate will catch any leftover).

- [ ] **Step 5: Run the three import tests**

Run: `pnpm test run src/__tests__/services/import-metahash.test.ts src/__tests__/application/book/importBooks.test.ts`
Expected: PASS (import-metahash all ~16 assertions; importBooks 5 cases).

- [ ] **Step 6: Type-check**

Run: `pnpm exec tsgo --noEmit`
Expected: only the `scripts/upload-cjk-fonts-r2.ts` baseline. If the `opened` sub-gen or `bestConfigData!` non-null assertions trip strict checks, fix faithfully (minimal) and report.

- [ ] **Step 7: Commit**

```bash
git add src/application/services/book/bookImport.ts src/application/usecases/book/importBooks.ts src/__tests__/application/book/importBooks.test.ts src/__tests__/services/import-metahash.test.ts
CI=true git commit -m "refactor(effect): E6d-2 Effect-native importBook + importBooks usecase over ports

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Delete the god-files + full verification

**Files:**

- Delete: `src/services/bookService.ts`, `src/services/libraryService.ts`

- [ ] **Step 1: Confirm no importers remain**

Run: `rg -n "@/services/bookService|@/services/libraryService" src`
Expected: NO output. If there IS output, STOP and report (something still imports a legacy module).

- [ ] **Step 2: Delete the files**

```bash
git rm src/services/bookService.ts src/services/libraryService.ts
```

- [ ] **Step 3: Grep gates**

Run: `rg -n "@/services/bookService|@/services/libraryService" src` → expected EMPTY.
Run: `ls src/services/bookService.ts src/services/libraryService.ts 2>&1` → expected "No such file" for both.
Run: `rg -ln "makeLegacyFsAdapter" src --glob '!**/*.test.*'` → expected EXACTLY 1 file: `src/infra/shared/fsPortAdapter.ts` (the definition; **0 consumers**).
Run: `rg -n "services/settings/json" src` → expected EMPTY (relocated to shared/json).

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: tsgo only the `scripts/upload-cjk-fonts-r2.ts` baseline; Biome only the `SettingsDialog.tsx` `lazy` baseline. No new errors.

- [ ] **Step 5: Repointed + guard test surface**

Run: `pnpm test run src/__tests__/services/import-metahash.test.ts src/__tests__/application/book/importBooks.test.ts src/__tests__/application/book/exportBook.test.ts src/__tests__/application/libraryRepository.test.ts src/__tests__/application/settingsJson.test.ts`
Expected: all PASS.

- [ ] **Step 6: Full suite**

Run: `pnpm test run`
Expected: green except the known env/timer/sandbox-flaky set (auth-page, useBookShortcuts, theme-store, api-routes, storage-config import-time env; ProgressBar/ReadingRuler timer; clientRuntime/edgeTTS/opds-req sandbox; hardcover). Confirm NO new failures attributable to E6d-2 (anything touching book/library/import/export). Run any uncertain failer in isolation to confirm it passes alone (flaky), and confirm it does not import the E6d-2 surface.

- [ ] **Step 7: Commit**

```bash
git add -A
CI=true git commit -m "refactor(effect): E6d-2 delete bookService.ts + libraryService.ts (de-adapter complete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done-conditions (whole slice)

1. `bookService.ts` + `libraryService.ts` deleted; `rg "@/services/{bookService,libraryService}" src` empty.
2. `makeLegacyFsAdapter` consumer count **0** (`rg -ln "makeLegacyFsAdapter" src --glob '!**/*.test.*'` → only `fsPortAdapter.ts` def).
3. json mirror at `shared/json.ts`; settings + library both import it; `settingsJson`/`settingsRepository`/`libraryRepository` tests green.
4. The 4 repointed/guard tests green (import-metahash 16 assertions, importBooks 5, exportBook 3, libraryRepository); `LibraryRepositoryShape` + usecase public signatures unchanged.
5. `pnpm lint` 0-new; full suite green minus the known flaky set.
