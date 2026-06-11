# Effect E2b — Import/Export usecases + library.json consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `importBooks`/`exportBook` Effect usecases that reuse `bookService` via the existing ports/repos, then migrate the Local-UI + OPDS consumers off `appService.importBook`/`exportBook`/`saveLibraryBooks` onto them — consolidating every migrated `library.json` write onto `LibraryRepository.save`.

**Architecture:** Two pure orchestration usecases in `src/application/usecases/book/` wrap the legacy `bookService.importBook`/`bookService.exportBook`, injecting `BookRepository.saveConfig` + `CoverService.generateCoverImageUrl` (import) and `PathResolver.absolute` + `FileSystem.copyFile` + `Dialog.saveFile` (export). No new ports or infra layers. React consumers run them via `useRunEffect`. Store-coupled grouping stays in `library/index` via an `onImported` callback.

**Tech Stack:** Effect TS (`Effect`, `Layer`, `ManagedRuntime`, `Option`), Vitest, React. Spec: `docs/superpowers/specs/2026-06-09-effect-e2b-import-export-design.md`.

---

## File Structure

- **Create** `src/application/usecases/book/exportBook.ts` — `exportBook(book)` usecase.
- **Create** `src/application/usecases/book/importBooks.ts` — `importBooks(books, inputs, options)` usecase.
- **Create** `src/application/usecases/book/index.ts` — barrel re-exporting both + their types.
- **Create** `src/__tests__/application/book/exportBook.test.ts`
- **Create** `src/__tests__/application/book/importBooks.test.ts`
- **Modify** consumers: `src/app/reader/components/annotator/Annotator.tsx`, `src/components/metadata/BookDetailModal.tsx`, `src/app/library/components/Bookshelf.tsx`, `src/app/opds/index.tsx`, `src/app/library/hooks/useDemoBooks.ts`, `src/app/library/index.tsx`, `src/app/library/components/GroupingModal.tsx`, `src/app/library/hooks/useBooksSync.ts`, `src/app/user/components/StorageManager.tsx`.

**Conventions (from E2a, verify before coding):** Effect tags `Context.Tag('app/<Name>')`; `Data.TaggedError` errors; resolved shape methods have `R = never` so `Effect.runPromise(shape.method(...))` is valid; React consumers use `useRunEffect()` from `@/context/EffectRuntimeProvider`; the runner is typed by the `ClientServices` union which already includes `BookRepository | CoverService | FileSystem | PathResolver | LibraryRepository | Dialog`.

---

## Task 1: `exportBook` usecase

**Files:**

- Create: `src/application/usecases/book/exportBook.ts`
- Test: `src/__tests__/application/book/exportBook.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/application/book/exportBook.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect, Layer, ManagedRuntime, Option } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { Dialog, type DialogShape } from '@/application/ports/Dialog';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import type { Book } from '@/domain/book';

// Mock bookService.exportBook so we exercise the usecase's callback wiring
// (resolveFilePath/copyFile/saveFile), not real document loading.
vi.mock('@/services/bookService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bookService')>();
  return {
    ...actual,
    // Invoke the injected saveFile and return whatever boolean it yields,
    // so we can assert the Option<string> -> boolean mapping.
    exportBook: vi.fn(
      async (
        _fs: unknown,
        _book: Book,
        _resolveFilePath: unknown,
        _copyFile: unknown,
        saveFile: (f: string, c: ArrayBuffer) => Promise<boolean>,
      ) => saveFile('out.epub', new ArrayBuffer(8)),
    ),
  };
});

import { exportBook } from '@/application/usecases/book/exportBook';

const book = { hash: 'h1', format: 'EPUB', title: 'T' } as unknown as Book;

const makeRuntime = (saveResult: Option.Option<string>) => {
  const DialogStub = Layer.succeed(Dialog, {
    ask: () => Effect.succeed(true),
    selectDirectory: () => Effect.succeed(Option.none()),
    selectFiles: () => Effect.succeed([]),
    saveFile: () => Effect.succeed(saveResult),
  } satisfies DialogShape);
  const Ports = Layer.mergeAll(
    TestFileSystemLive,
    Layer.provideMerge(TestPathResolverLive, PathStateLive),
  );
  return ManagedRuntime.make(Layer.merge(Ports, DialogStub));
};

describe('exportBook usecase', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when the dialog saved (Option.some)', async () => {
    const rt = makeRuntime(Option.some('/saved/out.epub'));
    expect(await rt.runPromise(exportBook(book))).toBe(true);
  });

  it('returns false when the dialog was cancelled (Option.none)', async () => {
    const rt = makeRuntime(Option.none());
    expect(await rt.runPromise(exportBook(book))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/__tests__/application/book/exportBook.test.ts`
Expected: FAIL — `Cannot find module '@/application/usecases/book/exportBook'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/application/usecases/book/exportBook.ts
import { Effect, Option } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Dialog } from '@/application/ports/Dialog';
import { makeLegacyFsAdapter } from '@/infra/shared/fsPortAdapter';
import * as BookSvc from '@/services/bookService';

/**
 * Export a book file via the platform save dialog. Reuses bookService.exportBook,
 * mapping its three legacy callbacks onto ports: resolveFilePath -> PathResolver,
 * copyFile -> FileSystem, saveFile -> Dialog (Option.isSome => boolean "saved?").
 */
export const exportBook = (
  book: Book,
): Effect.Effect<boolean, BookError, FileSystem | PathResolver | Dialog> =>
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const dialog = yield* Dialog;
    const fs = makeLegacyFsAdapter(fsPort, resolver);

    const resolveFilePath = (path: string, base: Parameters<typeof resolver.absolute>[1]) =>
      Effect.runPromise(resolver.absolute(path, base));
    const copyFile = (
      s: string,
      sb: Parameters<typeof fsPort.copyFile>[1],
      d: string,
      db: Parameters<typeof fsPort.copyFile>[3],
    ) => Effect.runPromise(fsPort.copyFile(s, sb, d, db));
    const saveFile = (
      filename: string,
      content: string | ArrayBuffer,
      options?: Parameters<typeof dialog.saveFile>[2],
    ) =>
      Effect.runPromise(
        dialog.saveFile(filename, content, options).pipe(Effect.map(Option.isSome)),
      );

    return yield* Effect.tryPromise({
      try: () => BookSvc.exportBook(fs, book, resolveFilePath, copyFile, saveFile),
      catch: (cause) => new BookError({ operation: 'exportBook', bookId: book.hash, cause }),
    });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/__tests__/application/book/exportBook.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/application/usecases/book/exportBook.ts src/__tests__/application/book/exportBook.test.ts
CI=true git commit -m "feat(effect): add exportBook usecase (Dialog/FileSystem/PathResolver)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `importBooks` usecase

**Files:**

- Create: `src/application/usecases/book/importBooks.ts`
- Test: `src/__tests__/application/book/importBooks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/application/book/importBooks.test.ts
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
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import type { Book } from '@/domain/book';

const mkBook = (hash: string): Book => ({ hash, format: 'EPUB', title: hash }) as unknown as Book;

// Mock bookService.importBook to exercise the usecase's loop/persist/callbacks
// without real document parsing. Keep buildBookLookupIndex real.
vi.mock('@/services/bookService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bookService')>();
  return {
    ...actual,
    importBook: vi.fn(
      async (
        _fs: unknown,
        file: string | File,
        books: Book[],
        opts: {
          generateCoverImageUrl: (b: Book) => Promise<string>;
          saveBookConfig: (b: Book, c: unknown) => Promise<void>;
        },
      ) => {
        const name = typeof file === 'string' ? file : file.name;
        if (name === 'fail') throw new Error('boom');
        const b = mkBook(name);
        await opts.saveBookConfig(b, {});
        b.coverImageUrl = await opts.generateCoverImageUrl(b);
        books.push(b);
        return b;
      },
    ),
  };
});

import { importBooks } from '@/application/usecases/book/importBooks';

const saved: Book[][] = [];
const savedConfigs: string[] = [];

const makeRuntime = () => {
  saved.length = 0;
  savedConfigs.length = 0;
  const BookRepoStub = Layer.succeed(BookRepository, {
    loadContent: () => Effect.die('unused'),
    loadConfig: () => Effect.die('unused'),
    saveConfig: (b) => Effect.sync(() => void savedConfigs.push(b.hash)),
    loadNav: () => Effect.die('unused'),
    saveNav: () => Effect.die('unused'),
    getFileSize: () => Effect.die('unused'),
    isAvailable: () => Effect.die('unused'),
    refreshMetadata: () => Effect.die('unused'),
  } as unknown as BookRepositoryShape);
  const CoverStub = Layer.succeed(CoverService, {
    getCoverImageUrl: () => 'cover://x',
    getCoverImageBlobUrl: () => Effect.succeed('cover://x'),
    getCachedImageUrl: () => Effect.succeed('cover://x'),
    generateCoverImageUrl: (b: Book) => Effect.succeed(`cover://${b.hash}`),
    updateCoverImage: () => Effect.void,
  } as unknown as CoverServiceShape);
  const LibraryStub = Layer.succeed(LibraryRepository, {
    load: Effect.succeed([] as Book[]),
    save: (books: readonly Book[]) => Effect.sync(() => void saved.push([...books])),
  } satisfies LibraryRepositoryShape);
  const Ports = Layer.mergeAll(
    TestFileSystemLive,
    Layer.provideMerge(TestPathResolverLive, PathStateLive),
  );
  return ManagedRuntime.make(Layer.mergeAll(Ports, BookRepoStub, CoverStub, LibraryStub));
};

describe('importBooks usecase', () => {
  beforeEach(() => vi.clearAllMocks());

  it('imports all inputs, wires saveConfig + cover, and persists once by default', async () => {
    const rt = makeRuntime();
    const books: Book[] = [];
    const res = await rt.runPromise(importBooks(books, [{ file: 'a' }, { file: 'b' }]));
    expect(res.imported.map((b) => b.hash)).toEqual(['a', 'b']);
    expect(res.imported[0]!.coverImageUrl).toBe('cover://a');
    expect(savedConfigs).toEqual(['a', 'b']);
    expect(res.failed).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.map((b) => b.hash)).toEqual(['a', 'b']);
  });

  it('records failures without aborting the batch', async () => {
    const rt = makeRuntime();
    const res = await rt.runPromise(importBooks([], [{ file: 'a' }, { file: 'fail' }]));
    expect(res.imported.map((b) => b.hash)).toEqual(['a']);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.filename).toBe('fail');
  });

  it('skips persistence when persist:false', async () => {
    const rt = makeRuntime();
    const res = await rt.runPromise(importBooks([], [{ file: 'a' }], { persist: false }));
    expect(res.imported).toHaveLength(1);
    expect(saved).toHaveLength(0);
  });

  it('does not persist when nothing imported', async () => {
    const rt = makeRuntime();
    const res = await rt.runPromise(importBooks([], [{ file: 'fail' }]));
    expect(res.imported).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('fires onImported per file and onBatch per batch', async () => {
    const rt = makeRuntime();
    const importedCb: string[] = [];
    const batches: number[] = [];
    await rt.runPromise(
      importBooks([], [{ file: 'a' }, { file: 'b' }], {
        concurrency: 1,
        onImported: (b) => void importedCb.push(b.hash),
        onBatch: (bs) => void batches.push(bs.length),
      }),
    );
    expect(importedCb).toEqual(['a', 'b']);
    expect(batches).toEqual([1, 1]); // two batches of 1 at concurrency 1
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/__tests__/application/book/importBooks.test.ts`
Expected: FAIL — `Cannot find module '@/application/usecases/book/importBooks'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/application/usecases/book/importBooks.ts
import { Effect } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { BookRepository } from '@/application/repositories/BookRepository';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { CoverService } from '@/application/services/CoverService';
import { makeLegacyFsAdapter } from '@/infra/shared/fsPortAdapter';
import * as BookSvc from '@/services/bookService';

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
 * Import 1..N books then optionally persist library.json. Reuses
 * bookService.importBook, injecting BookRepository.saveConfig +
 * CoverService.generateCoverImageUrl as the legacy callbacks. The `books` array
 * is mutated in place (faithful to legacy) and is what gets persisted. Grouping
 * is left to the consumer via `onImported` (getGroupId/getGroupName are store
 * methods).
 */
export const importBooks = (
  books: Book[],
  inputs: ReadonlyArray<ImportBookInput>,
  options: ImportBooksOptions = {},
): Effect.Effect<
  ImportBooksResult,
  BookError,
  BookRepository | CoverService | FileSystem | PathResolver | LibraryRepository
> =>
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const bookRepo = yield* BookRepository;
    const cover = yield* CoverService;
    const library = yield* LibraryRepository;
    const fs = makeLegacyFsAdapter(fsPort, resolver);

    const { transient, saveBook, saveCover, overwrite, onImported, onBatch } = options;
    const concurrency = options.concurrency ?? 4;
    const persist = options.persist ?? true;

    const saveBookConfig = (b: Book, c: Parameters<typeof bookRepo.saveConfig>[1]) =>
      Effect.runPromise(bookRepo.saveConfig(b, c));
    const generateCoverImageUrl = (b: Book) => Effect.runPromise(cover.generateCoverImageUrl(b));

    const lookupIndex = BookSvc.buildBookLookupIndex(books);
    const imported: Book[] = [];
    const failed: Array<{ filename: string; error: unknown }> = [];

    const importOne = (input: ImportBookInput) =>
      Effect.tryPromise({
        try: () =>
          BookSvc.importBook(fs, input.file, books, {
            lookupIndex,
            saveBook,
            saveCover,
            overwrite,
            transient,
            saveBookConfig,
            generateCoverImageUrl,
          }),
        catch: (cause) => new BookError({ operation: 'importBook', cause }),
      }).pipe(
        Effect.either,
        Effect.map((result) => ({ input, result })),
      );

    for (let i = 0; i < inputs.length; i += concurrency) {
      const batch = inputs.slice(i, i + concurrency);
      const results = yield* Effect.all(batch.map(importOne), { concurrency });
      const importedThisBatch: Book[] = [];
      for (const { input, result } of results) {
        if (result._tag === 'Left') {
          failed.push({ filename: filenameOf(input.file), error: result.left });
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/__tests__/application/book/importBooks.test.ts`
Expected: PASS (5 tests).

> If `result._tag`/`Either` access trips tsgo, import `Either` from `effect` and use `Either.isLeft(result)` / `result.right`. Prefer whichever the codebase already uses (grep `Effect.either` in `src/`).

- [ ] **Step 5: Commit**

```bash
git add src/application/usecases/book/importBooks.ts src/__tests__/application/book/importBooks.test.ts
CI=true git commit -m "feat(effect): add importBooks usecase (loop + persist via repos)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: usecases barrel

**Files:**

- Create: `src/application/usecases/book/index.ts`

- [ ] **Step 1: Write the barrel**

```ts
// src/application/usecases/book/index.ts
export { exportBook } from './exportBook';
export {
  importBooks,
  type ImportBookInput,
  type ImportBooksOptions,
  type ImportBooksResult,
} from './importBooks';
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm lint`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/application/usecases/book/index.ts
CI=true git commit -m "feat(effect): book usecases barrel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Migrate `exportBook` consumers (Annotator + BookDetailModal)

**Files:**

- Modify: `src/components/metadata/BookDetailModal.tsx:181`
- Modify: `src/app/reader/components/annotator/Annotator.tsx` (the markdown-export `handleBookExport`/export handler that calls `appService.exportBook`)

> `BookDetailModal` already has `runEffect = useRunEffect()` (line 54). `Annotator` has `useEnv()` but verify it has a `runEffect`; if not, add `import { useRunEffect } from '@/context/EffectRuntimeProvider'` and `const runEffect = useRunEffect();` near the other hook calls.

- [ ] **Step 1: BookDetailModal — replace the export call**

In `src/components/metadata/BookDetailModal.tsx`, add the import near the other `@/application` imports:

```ts
import { exportBook } from '@/application/usecases/book';
```

Replace line 181:

```ts
const success = await appService?.exportBook(book);
```

with:

```ts
const success = await runEffect(exportBook(book));
```

- [ ] **Step 2: Annotator — replace the export call**

In `src/app/reader/components/annotator/Annotator.tsx`, find the handler that calls `appService.exportBook(...)` (grep `exportBook` — distinct from the local `handleExportMarkdown`). Add:

```ts
import { exportBook } from '@/application/usecases/book';
```

and, if missing, `const runEffect = useRunEffect();`. Replace `await appService.exportBook(book)` with `await runEffect(exportBook(book))`.

> If grep shows Annotator only exports markdown (no `appService.exportBook`), it is NOT an exportBook consumer — skip it and note that in the commit. Confirm with: `grep -n "appService.*exportBook\|\.exportBook(" src/app/reader/components/annotator/Annotator.tsx`.

- [ ] **Step 3: Run affected tests**

Run: `pnpm test -- src/__tests__` (or any existing BookDetailModal/Annotator tests). If a test now fails at collection because it pulls the runtime graph, add `vi.mock('@/runtime/clientRuntime')` (see Task 8 note for the faithful stub shape).
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/metadata/BookDetailModal.tsx src/app/reader/components/annotator/Annotator.tsx
CI=true git commit -m "refactor(effect): migrate exportBook consumers to usecase

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Migrate `Bookshelf.tsx` URL import

**Files:**

- Modify: `src/app/library/components/Bookshelf.tsx:318-331`

- [ ] **Step 1: Add imports + runEffect**

Add to `Bookshelf.tsx`:

```ts
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { importBooks } from '@/application/usecases/book';
```

and, with the other hooks in the component, `const runEffect = useRunEffect();` (skip if already present).

- [ ] **Step 2: Replace the import effect body**

Replace lines 318-331:

```ts
if (importBookUrl && appService) {
  const importBook = async () => {
    console.log('Importing book from URL:', importBookUrl);
    const book = await appService.importBook(importBookUrl, libraryBooks);
    if (book) {
      setLibrary(libraryBooks);
      appService.saveLibraryBooks(libraryBooks);
      navigateToReader(router, [book.hash]);
    }
  };
  importBook();
}
```

with:

```ts
if (importBookUrl) {
  const importBook = async () => {
    console.log('Importing book from URL:', importBookUrl);
    const { imported, library } = await runEffect(
      importBooks(libraryBooks, [{ file: importBookUrl }]),
    );
    const book = imported[0];
    if (book) {
      setLibrary(library);
      navigateToReader(router, [book.hash]);
    }
  };
  importBook();
}
```

Update the effect dependency array on line ~331 from `[importBookUrl, appService]` to `[importBookUrl]` (or `[importBookUrl, runEffect]` if lint requires it — `runEffect` is stable).

- [ ] **Step 3: Test + lint**

Run: `pnpm test -- src/__tests__` then `pnpm lint`
Expected: PASS. Add `vi.mock('@/runtime/clientRuntime')` to any Bookshelf test that breaks at collection.

- [ ] **Step 4: Commit**

```bash
git add src/app/library/components/Bookshelf.tsx
CI=true git commit -m "refactor(effect): migrate Bookshelf URL import to importBooks usecase

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Migrate `opds/index.tsx` (handleDownload + handleStream)

**Files:**

- Modify: `src/app/opds/index.tsx:494-508` (handleDownload) and `:519-530` (handleStream)

- [ ] **Step 1: Add imports + runEffect**

```ts
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { importBooks } from '@/application/usecases/book';
```

and `const runEffect = useRunEffect();` with the other hooks.

- [ ] **Step 2: Replace handleDownload import+save (lines 494-508)**

```ts
const { library, setLibrary } = useLibraryStore.getState();
try {
  const book = await appService.importBook(dstFilePath, library);
  if (user && book && !book.uploadedAt && settings.autoUpload) {
    setTimeout(() => {
      transferManager.queueUpload(book);
    }, 3000);
  }
  setLibrary(library);
  appService.saveLibraryBooks(library);
  return book;
} catch (importError) {
  console.error('Import error:', importError);
  throw new ImportError(importError);
}
```

with:

```ts
const { library, setLibrary } = useLibraryStore.getState();
try {
  const { imported, library: nextLibrary } = await runEffect(
    importBooks(library, [{ file: dstFilePath }]),
  );
  const book = imported[0] ?? null;
  if (user && book && !book.uploadedAt && settings.autoUpload) {
    setTimeout(() => {
      transferManager.queueUpload(book);
    }, 3000);
  }
  setLibrary(nextLibrary);
  return book;
} catch (importError) {
  console.error('Import error:', importError);
  throw new ImportError(importError);
}
```

- [ ] **Step 3: Replace handleStream transient import (lines 525-528)**

```ts
        const { library, setLibrary } = useLibraryStore.getState();
        const book = await appService.importBook(psePath, library, { transient: true });
        if (book) {
          setLibrary(library);
```

with:

```ts
        const { library, setLibrary } = useLibraryStore.getState();
        const { imported, library: nextLibrary } = await runEffect(
          importBooks(library, [{ file: psePath }], { transient: true, persist: false }),
        );
        const book = imported[0];
        if (book) {
          setLibrary(nextLibrary);
```

> Keep the rest of `handleStream` (navigateToReader etc.) unchanged. `appService` is still used elsewhere in this file (resolveFilePath/copyFile/deleteFile) — do NOT remove its binding.

- [ ] **Step 4: Test + lint**

Run: `pnpm test -- src/__tests__` then `pnpm lint`
Expected: PASS. `vi.mock('@/runtime/clientRuntime')` for any opds test that breaks at collection.

- [ ] **Step 5: Commit**

```bash
git add src/app/opds/index.tsx
CI=true git commit -m "refactor(effect): migrate OPDS download/stream import to importBooks usecase

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Migrate `useDemoBooks.ts`

**Files:**

- Modify: `src/app/library/hooks/useDemoBooks.ts:31-45`

- [ ] **Step 1: Add imports + runEffect**

Add:

```ts
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { importBooks } from '@/application/usecases/book';
```

In the hook body add `const runEffect = useRunEffect();` (next to `const { envConfig } = useEnv();`). `envConfig` becomes unused — remove the `useEnv()` line if nothing else uses it, otherwise leave it.

- [ ] **Step 2: Replace the fetch body**

Replace:

```ts
try {
  const appService = await envConfig.getAppService();
  const demoBooks = libraries[userLang] || (libraries.en as DemoBooks);
  const books = await Promise.all(
    demoBooks.library.map((url) => appService.importBook(url, [], { saveBook: false })),
  );
  setBooks(books.filter((book) => book !== null) as Book[]);
} catch (error) {
  console.error('Failed to import demo books:', error);
}
```

with:

```ts
try {
  const demoBooks = libraries[userLang] || (libraries.en as DemoBooks);
  const { imported } = await runEffect(
    importBooks(
      [],
      demoBooks.library.map((url) => ({ file: url })),
      { saveBook: false, persist: false },
    ),
  );
  setBooks(imported);
} catch (error) {
  console.error('Failed to import demo books:', error);
}
```

> Behavior note: legacy used `Promise.all` (full concurrency); the usecase batches at concurrency 4. Demo libraries are small (a handful of URLs) so this is acceptable and avoids hammering the network.

- [ ] **Step 3: Test + lint**

Run: `pnpm test -- src/__tests__` then `pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/library/hooks/useDemoBooks.ts
CI=true git commit -m "refactor(effect): migrate useDemoBooks to importBooks usecase

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Migrate `library/index.tsx` (importBooks, processOpenWithFiles, demoBooks effect)

**Files:**

- Modify: `src/app/library/index.tsx` — `importBooks` (581-641), `processOpenWithFiles` (379-403), demoBooks effect (564-579)

> This is the complex consumer. Keep all UI concerns (toasts, `setLoading`, `pushLibrary`, `transferManager`) in the component. The usecase owns the import loop + cover/config; the component keeps grouping (`onImported`), incremental render (`onBatch`), and the final store-state save.

- [ ] **Step 1: Add imports + runEffect**

Add near the other imports:

```ts
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { importBooks as importBooksUsecase } from '@/application/usecases/book';
import { Effect } from 'effect';
```

In the component body add `const runEffect = useRunEffect();` (next to the other hooks).

- [ ] **Step 2: Rewrite the `importBooks` batch function (581-643)**

Replace the body from `const lookupIndex = ...` through the final `await finalAppService.saveLibraryBooks(finalLibrary);` block with a single usecase call that preserves grouping (via `onImported`), incremental render (via `onBatch`), failure collection, and autoUpload:

```ts
  const importBooks = async (files: SelectedFile[], groupId?: string) => {
    setLoading(true);
    const { library } = useLibraryStore.getState();
    const failedImports: Array<{ filename: string; errorMessage: string }> = [];
    const successfulImports: string[] = [];

    const inputs = files
      .map((selectedFile) => {
        const file = selectedFile.file || selectedFile.path;
        if (!file) return null;
        return { file, path: selectedFile.path, basePath: selectedFile.basePath };
      })
      .filter((v): v is { file: string | File; path?: string; basePath?: string } => v !== null);

    const { imported } = await runEffect(
      importBooksUsecase(library, inputs, {
        persist: false,
        onImported: (book, input) => {
          if (groupId) {
            book.groupId = groupId;
            book.groupName = getGroupName(groupId);
          } else if (input.path && input.basePath) {
            const rootPath = getDirPath(input.basePath);
            const groupName = getDirPath(input.path).replace(rootPath, '').replace(/^\//, '');
            book.groupName = groupName;
            book.groupId = getGroupId(groupName);
          }
          if (user && !book.uploadedAt && settings.autoUpload) {
            console.log('Queueing upload for book:', book.title);
            transferManager.queueUpload(book);
          }
          successfulImports.push(book.title);
        },
        onBatch: (batch) => {
          // fire-and-forget incremental store render (legacy used skipSave)
          void updateBooks(envConfig, batch, { skipSave: true });
        },
      }),
    );
    void imported;

    if (successfulImports.length > 0) {
      const finalLibrary = useLibraryStore.getState().library;
      await runEffect(Effect.flatMap(LibraryRepository, (r) => r.save(finalLibrary)));
    }

    pushLibrary();

    if (failedImports.length > 0) {
      // ... keep the existing toast block unchanged ...
```

> The original collected `failedImports` inside `processFile`'s catch with a localized message via `getImportErrorMessage`. The usecase swallows per-file errors into `result.failed`. To preserve the localized failure toast, map the usecase's `failed` instead: after the `runEffect`, push into `failedImports` from the usecase result. Adjust by capturing `failed` from the destructure:

```ts
const { imported, failed } = await runEffect(
  importBooksUsecase(library, inputs, {
    /* ...as above... */
  }),
);
void imported;
for (const f of failed) {
  const baseFilename = getFilename(f.filename);
  const errorMessage = f.error instanceof Error ? _(getImportErrorMessage(f.error.message)) : '';
  failedImports.push({ filename: baseFilename, errorMessage });
  console.error('Failed to import book:', f.filename, f.error);
}
```

Keep everything below `if (failedImports.length > 0)` (the toast dispatch) exactly as in the original through the end of the function (including `setLoading(false)` if present).

- [ ] **Step 3: Replace `processOpenWithFiles` import loop (383-403)**

Replace:

```ts
const bookIds: string[] = [];
for (const file of openWithFiles) {
  console.log('Open with book:', file);
  try {
    const temp = appService.isMobile ? false : !settings.autoImportBooksOnOpen;
    const book = await appService.importBook(file, libraryBooks, { transient: temp });
    if (book) {
      bookIds.push(book.hash);
    }
    if (user && book && !temp && !book.uploadedAt && settings.autoUpload) {
      setTimeout(() => {
        console.log('Queueing upload for book:', book.title);
        transferManager.queueUpload(book);
        // wait for the initialization of the transfer manager and opening of the book
      }, 3000);
    }
  } catch (error) {
    console.log('Failed to import book:', file, error);
  }
}
setLibrary(libraryBooks);
appService.saveLibraryBooks(libraryBooks);
```

with:

```ts
const bookIds: string[] = [];
const temp = appService.isMobile ? false : !settings.autoImportBooksOnOpen;
const { imported, library: nextLibrary } = await runEffect(
  importBooksUsecase(
    libraryBooks,
    openWithFiles.map((file) => ({ file })),
    {
      transient: temp,
      onImported: (book) => {
        bookIds.push(book.hash);
        if (user && !temp && !book.uploadedAt && settings.autoUpload) {
          setTimeout(() => {
            console.log('Queueing upload for book:', book.title);
            transferManager.queueUpload(book);
          }, 3000);
        }
      },
    },
  ),
);
void imported;
setLibrary(nextLibrary);
```

> `processOpenWithFiles` takes `appService` as a param and still uses `appService.isMobile`/`appService.loadSettings()` — keep those. Only the import loop + `saveLibraryBooks` change. The usecase persists (`persist` defaults true), so the explicit save is removed.

- [ ] **Step 4: Replace the demoBooks effect save (576)**

Replace:

```ts
setLibrary(newLibrary);
appService?.saveLibraryBooks(newLibrary);
```

with:

```ts
setLibrary(newLibrary);
void runEffect(Effect.flatMap(LibraryRepository, (r) => r.save(newLibrary)));
```

- [ ] **Step 5: Run tests; rebridge if needed**

Run: `pnpm test -- src/__tests__`
Expected: PASS. If a library/index-related test breaks at collection (runtime graph pull — E2a gotcha), add at the top of that test file:

```ts
import { Effect } from 'effect';
vi.mock('@/runtime/clientRuntime', () => ({
  getClientRuntime: () => ({
    runPromise: (eff: unknown) => Effect.runPromise(eff as Parameters<typeof Effect.runPromise>[0]),
    runSync: (eff: unknown) => Effect.runSync(eff as Parameters<typeof Effect.runSync>[0]),
  }),
  getPlatformInfo: () => ({ type: 'web', isMobile: false }),
}));
```

(Adjust to the faithful fake-layer form from `HardcoverSyncMapStore.test.ts` if the test actually exercises the import/save path.)

- [ ] **Step 6: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/library/index.tsx
CI=true git commit -m "refactor(effect): migrate library import/open-with/demo saves to usecase + LibraryRepository

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Consolidate remaining `saveLibraryBooks` calls (GroupingModal, useBooksSync, StorageManager)

**Files:**

- Modify: `src/app/library/components/GroupingModal.tsx`
- Modify: `src/app/library/hooks/useBooksSync.ts`
- Modify: `src/app/user/components/StorageManager.tsx`

> For each: replace `appService.saveLibraryBooks(books)` with a `LibraryRepository.save` run through the bridge. React components/hooks use `useRunEffect`; verify each already has it (StorageManager does — E2a), else add it.

- [ ] **Step 1: GroupingModal**

`grep -n "saveLibraryBooks\|useRunEffect\|appService" src/app/library/components/GroupingModal.tsx`. Add (if missing):

```ts
import { Effect } from 'effect';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
```

and `const runEffect = useRunEffect();`. Replace each `await appService?.saveLibraryBooks(<books>)` / `appService.saveLibraryBooks(<books>)` with:

```ts
await runEffect(Effect.flatMap(LibraryRepository, (r) => r.save(<books>)));
```

(use the same `<books>` argument the original passed).

- [ ] **Step 2: useBooksSync**

Same pattern in `src/app/library/hooks/useBooksSync.ts`. `grep -n "saveLibraryBooks\|useRunEffect" src/app/library/hooks/useBooksSync.ts`, add imports + `runEffect`, replace the `saveLibraryBooks` call(s) with `runEffect(Effect.flatMap(LibraryRepository, (r) => r.save(<books>)))`.

- [ ] **Step 3: StorageManager leftover**

`grep -n "saveLibraryBooks" src/app/user/components/StorageManager.tsx`. StorageManager already imports `useRunEffect`/`LibraryRepository` (E2a). Replace the leftover `appService.saveLibraryBooks(<books>)` with `runEffect(Effect.flatMap(LibraryRepository, (r) => r.save(<books>)))`. Add `import { Effect } from 'effect'` if not present.

- [ ] **Step 4: Verify no migrated consumer still calls legacy saveLibraryBooks**

Run:

```bash
grep -rn "saveLibraryBooks" src/app/library/index.tsx src/app/library/components/Bookshelf.tsx src/app/library/components/GroupingModal.tsx src/app/library/hooks/useBooksSync.ts src/app/opds/index.tsx src/app/user/components/StorageManager.tsx
```

Expected: no matches (the only remaining `saveLibraryBooks` callers are the E4-deferred `shareImport.ts`, `backupService.ts`, plus `libraryService.ts`'s definition and `appService.ts`'s wrapper).

- [ ] **Step 5: Test + lint**

Run: `pnpm test -- src/__tests__` then `pnpm lint`
Expected: PASS. Rebridge any breaking test as in Task 8 Step 5.

- [ ] **Step 6: Commit**

```bash
git add src/app/library/components/GroupingModal.tsx src/app/library/hooks/useBooksSync.ts src/app/user/components/StorageManager.tsx
CI=true git commit -m "refactor(effect): route remaining library saves through LibraryRepository

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full verification

- [ ] **Step 1: Full unit suite**

Run: `pnpm test`
Expected: PASS. Known sandbox-flaky tests (turso-node / edgeTTS / opds-req) may fail in the sandbox — confirm they fail for env reasons only, not from these changes.

- [ ] **Step 2: Lint (Biome + tsgo)**

Run: `pnpm lint`
Expected: PASS — no `any`, no unmet Effect requirements (tsgo verifies the usecases resolve against `ClientServices`).

- [ ] **Step 3: Confirm scope boundary intact**

Run: `grep -rn "appService.*importBook\|appService.*exportBook" src/libs/shareImport.ts src/services/backupService.ts src/services/opds/autoDownload.ts`
Expected: these three still use legacy (deferred to E4) — unchanged.

- [ ] **Step 4: Final commit (only if uncommitted residue)**

```bash
git status
# if clean, nothing to do; otherwise stage and commit residual formatting
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** Task 1 = exportBook usecase; Task 2 = importBooks usecase; Task 3 = barrel; Tasks 4-9 = the cluster-3 migration + library.json consolidation table from the spec; Task 10 = verification gates. E4-deferred files (`shareImport`, `backupService`, `autoDownload`) are explicitly untouched.
- **Type consistency:** `importBooks(books, inputs, options)` / `exportBook(book)` signatures are identical across the usecase definition (Tasks 1-2), the barrel (Task 3), and every consumer (Tasks 4-9). `ImportBookInput.file` is `string | File` everywhere.
- **Grouping correctness:** `getGroupId`/`getGroupName` stay in `library/index` (store methods) via `onImported`; never moved into the usecase.
- **Persist correctness:** `library/index.importBooks` uses `persist:false` + explicit store-state save because `updateBooks` replaces (not mutates) the store array; all other consumers let the usecase persist (`persist` defaults true), except transient `handleStream`/demo which pass `persist:false`.
