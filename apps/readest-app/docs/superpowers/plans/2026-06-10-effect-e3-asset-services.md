# E3 Asset Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the remaining local Cover call sites plus all Font/Image/Dictionary asset operations off the legacy `getAppService()` god-object onto the Effect ports/services architecture, reusing the existing pure service functions verbatim.

**Architecture:** Add one shared `AssetError`, three new services (`Context.Tag` + `*Shape` interface + live `infra/shared/*.layer.ts` layer that builds the legacy `FileSystem` via `makeLegacyFsAdapter` and wraps the pure fns in `Effect.tryPromise`), wire each into both client runtimes + the `ClientServices` union, then repoint consumers to `runEffect(Effect.flatMap(<Service>, ...))`. Strictly additive — the legacy `appService` wrappers and `domain/system.ts` interface entries stay live until E5. Same pattern as E2a's `CoverService`.

**Tech Stack:** Effect (`Context.Tag`, `Layer.effect`, `Effect.tryPromise`, `Data.TaggedError`), Vitest, React, Zustand.

**Spec:** `docs/superpowers/specs/2026-06-10-effect-e3-asset-services-design.md`

---

## File Structure

**Create:**

- `src/application/services/FontService.ts` — `app/FontService` tag + `FontServiceShape`
- `src/application/services/ImageService.ts` — `app/ImageService` tag + `ImageServiceShape`
- `src/application/services/DictionaryService.ts` — `app/DictionaryService` tag + `DictionaryServiceShape`
- `src/infra/shared/FontService.layer.ts` — `FontServiceLive` (reuses `@/services/fontService`)
- `src/infra/shared/ImageService.layer.ts` — `ImageServiceLive` (reuses `@/services/imageService`)
- `src/infra/shared/DictionaryService.layer.ts` — `DictionaryServiceLive` (lazy-loads `@/services/dictionaries/dictionaryService`)
- `src/__tests__/application/fontService.test.ts`
- `src/__tests__/application/imageService.test.ts`
- `src/__tests__/application/dictionaryService.test.ts`

**Modify:**

- `src/application/errors/AppError.ts` — add `AssetError` + union entry
- `src/runtime/clientRuntime.ts` — add 3 tags to `ClientServices` union
- `src/runtime/client-tauri.ts` — add 3 layers to `SharedRepos`
- `src/runtime/client-web.ts` — add 3 layers to `SharedRepos`
- `src/app/library/index.tsx` — cover `updateCoverImage` → `CoverService`
- `src/app/library/hooks/useBooksSync.ts` — 2× `generateCoverImageUrl` → `CoverService`
- `src/components/settings/CustomFonts.tsx` — `importFont`/`deleteFont` → `FontService`
- `src/components/settings/DialogMenu.tsx` — `deleteFont` → `FontService`
- `src/components/settings/ColorPanel.tsx` — `importImage` → `ImageService`
- `src/components/settings/CustomDictionaries.tsx` — `importDictionaries`/`deleteDictionary` → `DictionaryService`

---

## Task 1: AssetError contract

**Files:**

- Modify: `src/application/errors/AppError.ts`

- [ ] **Step 1: Add the `AssetError` class**

In `src/application/errors/AppError.ts`, after the `BookError` class (before `MigrationError`), insert:

```ts
export class AssetError extends Data.TaggedError('AssetError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}
```

- [ ] **Step 2: Add it to the `AppError` union**

Change the union to include `AssetError`:

```ts
export type AppError =
  | FsError
  | PlatformError
  | DatabaseError
  | SettingsError
  | BookError
  | AssetError
  | MigrationError
  | UserCancelled;
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm exec tsgo --noEmit -p tsconfig.json 2>&1 | grep -i AppError || echo "AppError clean"`
Expected: `AppError clean` (only the pre-existing `scripts/upload-cjk-fonts-r2.ts` error may appear elsewhere; ignore it).

- [ ] **Step 4: Commit**

```bash
git add src/application/errors/AppError.ts
git commit -m "feat(effect): add AssetError for font/image/dictionary services"
```

---

## Task 2: FontService (tag + layer + runtime wiring + test)

**Files:**

- Create: `src/application/services/FontService.ts`
- Create: `src/infra/shared/FontService.layer.ts`
- Create: `src/__tests__/application/fontService.test.ts`
- Modify: `src/runtime/clientRuntime.ts`, `src/runtime/client-tauri.ts`, `src/runtime/client-web.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/application/fontService.test.ts`:

```ts
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { FontService } from '@/application/services/FontService';
import { FontServiceLive } from '@/infra/shared/FontService.layer';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { AssetError } from '@/application/errors/AppError';
import type { CustomFont } from '@/domain/fonts';

const baseResolver = Layer.provideMerge(TestPathResolverLive, PathStateLive);

// Minimal in-memory FileSystem stub supporting only the ops importFont/deleteFont touch.
const makeFs = (over: Partial<FileSystemShape> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    createDir: () => Effect.void,
    writeFile: () => Effect.void,
    openFile: (path: string) =>
      Effect.succeed(new File([new Uint8Array(1024)], path.split('/').pop() ?? 'font.ttf')),
    removeFile: () => Effect.void,
    removeDir: () => Effect.void,
    ...over,
  } as unknown as FileSystemShape);

const mkLayer = (fs: Layer.Layer<FileSystem>) =>
  Layer.provide(FontServiceLive, Layer.merge(fs, baseResolver));
const run = <A>(p: Effect.Effect<A, unknown, FontService>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(mkLayer(fs))) as Effect.Effect<A, unknown, never>);

describe('FontService (live over stub FileSystem)', () => {
  it('importFont writes a bundle and returns a populated CustomFontInfo', async () => {
    const info = await run(
      Effect.flatMap(FontService, (s) =>
        s.importFont(new File([new Uint8Array(1024)], 'Roboto.ttf')),
      ),
      makeFs(),
    );
    expect(info).toBeTruthy();
    expect(info!.path.endsWith('Roboto.ttf')).toBe(true);
    expect(typeof info!.bundleDir).toBe('string');
    expect(info!.byteSize).toBe(1024);
    expect(typeof info!.contentId).toBe('string');
  });

  it('importFont returns null when no file is given', async () => {
    const info = await run(
      Effect.flatMap(FontService, (s) => s.importFont(undefined)),
      makeFs(),
    );
    expect(info).toBeNull();
  });

  it('deleteFont removes the file', async () => {
    const removeFile = vi.fn(() => Effect.void);
    const font = {
      id: '1',
      name: 'Roboto',
      path: 'abc/Roboto.ttf',
      bundleDir: 'abc',
    } as CustomFont;
    await run(
      Effect.flatMap(FontService, (s) => s.deleteFont(font)),
      makeFs({ removeFile }),
    );
    expect(removeFile).toHaveBeenCalledWith('abc/Roboto.ttf', 'Fonts');
  });

  it('maps a failure to AssetError', async () => {
    const font = { id: '1', name: 'Roboto', path: 'abc/Roboto.ttf' } as CustomFont;
    const err = (await run(
      Effect.flatMap(FontService, (s) => s.deleteFont(font)).pipe(Effect.flip),
      makeFs({ removeFile: () => Effect.fail(new Error('boom')) }),
    )) as AssetError;
    expect(err).toBeInstanceOf(AssetError);
    expect(err.operation).toBe('deleteFont');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/__tests__/application/fontService.test.ts`
Expected: FAIL — cannot resolve `@/application/services/FontService` / `@/infra/shared/FontService.layer`.

- [ ] **Step 3: Create the service tag**

Create `src/application/services/FontService.ts`:

```ts
import { Context, type Effect } from 'effect';
import type { CustomFont, CustomFontInfo } from '@/domain/fonts';
import type { AssetError } from '@/application/errors/AppError';

export interface FontServiceShape {
  readonly importFont: (file?: string | File) => Effect.Effect<CustomFontInfo | null, AssetError>;
  readonly deleteFont: (font: CustomFont) => Effect.Effect<void, AssetError>;
}

export class FontService extends Context.Tag('app/FontService')<FontService, FontServiceShape>() {}
```

- [ ] **Step 4: Create the live layer**

Create `src/infra/shared/FontService.layer.ts`:

```ts
import { Effect, Layer } from 'effect';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { FontService, type FontServiceShape } from '@/application/services/FontService';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as FontSvc from '@/services/fontService';

export const FontServiceLive = Layer.effect(
  FontService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const err = (operation: string) => (cause: unknown) => new AssetError({ operation, cause });
    return {
      importFont: (file) =>
        Effect.tryPromise({ try: () => FontSvc.importFont(fs, file), catch: err('importFont') }),
      deleteFont: (font) =>
        Effect.tryPromise({ try: () => FontSvc.deleteFont(fs, font), catch: err('deleteFont') }),
    } satisfies FontServiceShape;
  }),
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/__tests__/application/fontService.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Wire into the `ClientServices` union**

In `src/runtime/clientRuntime.ts`, add the import alongside the other service-tag type imports (near the `CoverService` import, line ~12):

```ts
import type { FontService } from '@/application/services/FontService';
```

Then add `FontService` to the `ClientServices` union (after `CoverService`):

```ts
export type ClientServices =
  | // ...existing members...
  | CoverService
  | FontService;
```

- [ ] **Step 7: Wire the layer into both runtimes**

In `src/runtime/client-tauri.ts`, add the import (after the `LibraryRepositoryLive` import):

```ts
import { FontServiceLive } from '@/infra/shared/FontService.layer';
```

Add `FontServiceLive` to the `SharedRepos` `Layer.mergeAll(...)` block:

```ts
const SharedRepos = Layer.provideMerge(
  Layer.mergeAll(
    SettingsRepositoryLive,
    MigrationServiceLive,
    BookRepositoryLive,
    LibraryRepositoryLive,
    FontServiceLive,
  ),
  SharedBaseWithCover,
);
```

Make the identical two edits in `src/runtime/client-web.ts` (same import line + same `FontServiceLive` addition to its `SharedRepos` `Layer.mergeAll`).

- [ ] **Step 8: Verify runtimes still resolve to `never`**

Run: `pnpm exec tsgo --noEmit -p tsconfig.json 2>&1 | grep -iE 'client-(tauri|web)|clientRuntime|FontService' || echo "runtime clean"`
Expected: `runtime clean`.

- [ ] **Step 9: Commit**

```bash
git add src/application/services/FontService.ts src/infra/shared/FontService.layer.ts \
  src/__tests__/application/fontService.test.ts src/runtime/clientRuntime.ts \
  src/runtime/client-tauri.ts src/runtime/client-web.ts
git commit -m "feat(effect): add FontService (tag + layer + runtime wiring)"
```

---

## Task 3: ImageService (tag + layer + runtime wiring + test)

**Files:**

- Create: `src/application/services/ImageService.ts`
- Create: `src/infra/shared/ImageService.layer.ts`
- Create: `src/__tests__/application/imageService.test.ts`
- Modify: `src/runtime/clientRuntime.ts`, `src/runtime/client-tauri.ts`, `src/runtime/client-web.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/application/imageService.test.ts`:

```ts
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ImageService } from '@/application/services/ImageService';
import { ImageServiceLive } from '@/infra/shared/ImageService.layer';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { AssetError } from '@/application/errors/AppError';
import type { CustomTextureInfo } from '@/domain/textures';

const baseResolver = Layer.provideMerge(TestPathResolverLive, PathStateLive);

const makeFs = (over: Partial<FileSystemShape> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    createDir: () => Effect.void,
    writeFile: () => Effect.void,
    openFile: (path: string) =>
      Effect.succeed(new File([new Uint8Array(1024)], path.split('/').pop() ?? 'bg.png')),
    removeFile: () => Effect.void,
    removeDir: () => Effect.void,
    ...over,
  } as unknown as FileSystemShape);

const mkLayer = (fs: Layer.Layer<FileSystem>) =>
  Layer.provide(ImageServiceLive, Layer.merge(fs, baseResolver));
const run = <A>(p: Effect.Effect<A, unknown, ImageService>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(mkLayer(fs))) as Effect.Effect<A, unknown, never>);

describe('ImageService (live over stub FileSystem)', () => {
  it('importImage writes a bundle and returns a populated CustomTextureInfo', async () => {
    const info = await run(
      Effect.flatMap(ImageService, (s) =>
        s.importImage(new File([new Uint8Array(1024)], 'bg.png')),
      ),
      makeFs(),
    );
    expect(info).toBeTruthy();
    expect(info!.path.endsWith('bg.png')).toBe(true);
    expect(typeof info!.bundleDir).toBe('string');
    expect(info!.byteSize).toBe(1024);
    expect(typeof info!.contentId).toBe('string');
    expect(typeof info!.name).toBe('string');
  });

  it('importImage returns null when no file is given', async () => {
    const info = await run(
      Effect.flatMap(ImageService, (s) => s.importImage(undefined)),
      makeFs(),
    );
    expect(info).toBeNull();
  });

  it('deleteImage removes the file', async () => {
    const removeFile = vi.fn(() => Effect.void);
    const texture = { name: 'bg', path: 'abc/bg.png', bundleDir: 'abc' } as CustomTextureInfo;
    await run(
      Effect.flatMap(ImageService, (s) => s.deleteImage(texture)),
      makeFs({ removeFile }),
    );
    expect(removeFile).toHaveBeenCalledWith('abc/bg.png', 'Images');
  });

  it('maps a failure to AssetError', async () => {
    const texture = { name: 'bg', path: 'abc/bg.png' } as CustomTextureInfo;
    const err = (await run(
      Effect.flatMap(ImageService, (s) => s.deleteImage(texture)).pipe(Effect.flip),
      makeFs({ removeFile: () => Effect.fail(new Error('boom')) }),
    )) as AssetError;
    expect(err).toBeInstanceOf(AssetError);
    expect(err.operation).toBe('deleteImage');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/__tests__/application/imageService.test.ts`
Expected: FAIL — cannot resolve `@/application/services/ImageService` / layer.

- [ ] **Step 3: Create the service tag**

Create `src/application/services/ImageService.ts`:

```ts
import { Context, type Effect } from 'effect';
import type { CustomTextureInfo } from '@/domain/textures';
import type { AssetError } from '@/application/errors/AppError';

export interface ImageServiceShape {
  readonly importImage: (
    file?: string | File,
  ) => Effect.Effect<CustomTextureInfo | null, AssetError>;
  readonly deleteImage: (texture: CustomTextureInfo) => Effect.Effect<void, AssetError>;
}

export class ImageService extends Context.Tag('app/ImageService')<
  ImageService,
  ImageServiceShape
>() {}
```

- [ ] **Step 4: Create the live layer**

Create `src/infra/shared/ImageService.layer.ts`:

```ts
import { Effect, Layer } from 'effect';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { ImageService, type ImageServiceShape } from '@/application/services/ImageService';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as ImageSvc from '@/services/imageService';

export const ImageServiceLive = Layer.effect(
  ImageService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const err = (operation: string) => (cause: unknown) => new AssetError({ operation, cause });
    return {
      importImage: (file) =>
        Effect.tryPromise({ try: () => ImageSvc.importImage(fs, file), catch: err('importImage') }),
      deleteImage: (texture) =>
        Effect.tryPromise({
          try: () => ImageSvc.deleteImage(fs, texture),
          catch: err('deleteImage'),
        }),
    } satisfies ImageServiceShape;
  }),
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/__tests__/application/imageService.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Wire into the `ClientServices` union**

In `src/runtime/clientRuntime.ts` add:

```ts
import type { ImageService } from '@/application/services/ImageService';
```

and append `| ImageService` to the `ClientServices` union (after `FontService`).

- [ ] **Step 7: Wire the layer into both runtimes**

In `src/runtime/client-tauri.ts` add the import:

```ts
import { ImageServiceLive } from '@/infra/shared/ImageService.layer';
```

and add `ImageServiceLive` to the `SharedRepos` `Layer.mergeAll(...)` (after `FontServiceLive`). Make the identical two edits in `src/runtime/client-web.ts`.

- [ ] **Step 8: Verify runtimes still resolve to `never`**

Run: `pnpm exec tsgo --noEmit -p tsconfig.json 2>&1 | grep -iE 'client-(tauri|web)|clientRuntime|ImageService' || echo "runtime clean"`
Expected: `runtime clean`.

- [ ] **Step 9: Commit**

```bash
git add src/application/services/ImageService.ts src/infra/shared/ImageService.layer.ts \
  src/__tests__/application/imageService.test.ts src/runtime/clientRuntime.ts \
  src/runtime/client-tauri.ts src/runtime/client-web.ts
git commit -m "feat(effect): add ImageService (tag + layer + runtime wiring)"
```

---

## Task 4: DictionaryService (tag + layer + runtime wiring + test)

**Files:**

- Create: `src/application/services/DictionaryService.ts`
- Create: `src/infra/shared/DictionaryService.layer.ts`
- Create: `src/__tests__/application/dictionaryService.test.ts`
- Modify: `src/runtime/clientRuntime.ts`, `src/runtime/client-tauri.ts`, `src/runtime/client-web.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/application/dictionaryService.test.ts`:

```ts
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { DictionaryService } from '@/application/services/DictionaryService';
import { DictionaryServiceLive } from '@/infra/shared/DictionaryService.layer';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { AssetError } from '@/application/errors/AppError';
import type { ImportedDictionary } from '@/domain/dictionaries';

const baseResolver = Layer.provideMerge(TestPathResolverLive, PathStateLive);

const makeFs = (over: Partial<FileSystemShape> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    exists: () => Effect.succeed(false),
    removeDir: () => Effect.void,
    ...over,
  } as unknown as FileSystemShape);

const mkLayer = (fs: Layer.Layer<FileSystem>) =>
  Layer.provide(DictionaryServiceLive, Layer.merge(fs, baseResolver));
const run = <A>(p: Effect.Effect<A, unknown, DictionaryService>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(mkLayer(fs))) as Effect.Effect<A, unknown, never>);

describe('DictionaryService (live over stub FileSystem)', () => {
  it('importDictionaries with no files returns an empty result', async () => {
    const result = await run(
      Effect.flatMap(DictionaryService, (s) => s.importDictionaries([])),
      makeFs(),
    );
    expect(result.imported).toEqual([]);
    expect(result.replacements).toEqual([]);
    expect(result.orphanFiles).toEqual([]);
  });

  it('deleteDictionary removes the bundle dir when it exists', async () => {
    const removeDir = vi.fn(() => Effect.void);
    const dict = { id: '1', bundleDir: 'b1' } as ImportedDictionary;
    await run(
      Effect.flatMap(DictionaryService, (s) => s.deleteDictionary(dict)),
      makeFs({ exists: () => Effect.succeed(true), removeDir }),
    );
    expect(removeDir).toHaveBeenCalledWith('b1', 'Dictionaries', true);
  });

  it('maps a failure to AssetError', async () => {
    const dict = { id: '1', bundleDir: 'b1' } as ImportedDictionary;
    const err = (await run(
      Effect.flatMap(DictionaryService, (s) => s.deleteDictionary(dict)).pipe(Effect.flip),
      makeFs({ exists: () => Effect.fail(new Error('boom')) }),
    )) as AssetError;
    expect(err).toBeInstanceOf(AssetError);
    expect(err.operation).toBe('deleteDictionary');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/__tests__/application/dictionaryService.test.ts`
Expected: FAIL — cannot resolve `@/application/services/DictionaryService` / layer.

- [ ] **Step 3: Create the service tag**

Create `src/application/services/DictionaryService.ts`:

```ts
import { Context, type Effect } from 'effect';
import type { SelectedFile } from '@/domain/file-selector';
import type { ImportDictionariesResult, ImportedDictionary } from '@/domain/dictionaries';
import type { AssetError } from '@/application/errors/AppError';

export interface DictionaryServiceShape {
  readonly importDictionaries: (
    files: SelectedFile[],
    existingDictionaries?: ImportedDictionary[],
  ) => Effect.Effect<ImportDictionariesResult, AssetError>;
  readonly deleteDictionary: (dict: ImportedDictionary) => Effect.Effect<void, AssetError>;
}

export class DictionaryService extends Context.Tag('app/DictionaryService')<
  DictionaryService,
  DictionaryServiceShape
>() {}
```

- [ ] **Step 4: Create the live layer (lazy-import the heavy module)**

Create `src/infra/shared/DictionaryService.layer.ts`. Note the dynamic `import()` inside the effects — `dictionaryService` pulls slob/stardict/mdict readers (~23KB) and is kept out of the main client chunk, matching how `appService` lazy-loads it:

```ts
import { Effect, Layer } from 'effect';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import {
  DictionaryService,
  type DictionaryServiceShape,
} from '@/application/services/DictionaryService';
import { makeLegacyFsAdapter } from './fsPortAdapter';

export const DictionaryServiceLive = Layer.effect(
  DictionaryService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const err = (operation: string) => (cause: unknown) => new AssetError({ operation, cause });
    return {
      importDictionaries: (files, existingDictionaries = []) =>
        Effect.tryPromise({
          try: async () => {
            const m = await import('@/services/dictionaries/dictionaryService');
            return m.importDictionaries(fs, files, existingDictionaries);
          },
          catch: err('importDictionaries'),
        }),
      deleteDictionary: (dict) =>
        Effect.tryPromise({
          try: async () => {
            const m = await import('@/services/dictionaries/dictionaryService');
            return m.deleteDictionary(fs, dict);
          },
          catch: err('deleteDictionary'),
        }),
    } satisfies DictionaryServiceShape;
  }),
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/__tests__/application/dictionaryService.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire into the `ClientServices` union**

In `src/runtime/clientRuntime.ts` add:

```ts
import type { DictionaryService } from '@/application/services/DictionaryService';
```

and append `| DictionaryService` to the `ClientServices` union (after `ImageService`).

- [ ] **Step 7: Wire the layer into both runtimes**

In `src/runtime/client-tauri.ts` add the import:

```ts
import { DictionaryServiceLive } from '@/infra/shared/DictionaryService.layer';
```

and add `DictionaryServiceLive` to the `SharedRepos` `Layer.mergeAll(...)` (after `ImageServiceLive`). Make the identical two edits in `src/runtime/client-web.ts`.

- [ ] **Step 8: Verify runtimes still resolve to `never`**

Run: `pnpm exec tsgo --noEmit -p tsconfig.json 2>&1 | grep -iE 'client-(tauri|web)|clientRuntime|DictionaryService' || echo "runtime clean"`
Expected: `runtime clean`.

- [ ] **Step 9: Commit**

```bash
git add src/application/services/DictionaryService.ts src/infra/shared/DictionaryService.layer.ts \
  src/__tests__/application/dictionaryService.test.ts src/runtime/clientRuntime.ts \
  src/runtime/client-tauri.ts src/runtime/client-web.ts
git commit -m "feat(effect): add DictionaryService (tag + layer + runtime wiring)"
```

---

## Task 5: Migrate the remaining Cover consumers

The `CoverService` port already exists and is wired. Repoint the 3 remaining `appService` cover call sites. Both files already import `Effect` and call `useRunEffect()`/`runEffect` — only the `CoverService` import + call swaps are needed.

**Files:**

- Modify: `src/app/library/index.tsx`
- Modify: `src/app/library/hooks/useBooksSync.ts`

- [ ] **Step 1: `library/index.tsx` — add the import**

After the existing `import { LibraryRepository } from '@/application/repositories/LibraryRepository';` (line ~13), add:

```ts
import { CoverService } from '@/application/services/CoverService';
```

- [ ] **Step 2: `library/index.tsx` — swap `updateCoverImage`**

Replace (around line 807):

```ts
await appService?.updateCoverImage(
  book,
  metadata.coverImageBlobUrl || metadata.coverImageUrl,
  metadata.coverImageFile,
);
```

with:

```ts
await runEffect(
  Effect.flatMap(CoverService, (c) =>
    c.updateCoverImage(
      book,
      metadata.coverImageBlobUrl || metadata.coverImageUrl,
      metadata.coverImageFile,
    ),
  ),
);
```

- [ ] **Step 3: `useBooksSync.ts` — add the import**

After `import { LibraryRepository } from '@/application/repositories/LibraryRepository';` (line ~8), add:

```ts
import { CoverService } from '@/application/services/CoverService';
```

- [ ] **Step 4: `useBooksSync.ts` — swap both `generateCoverImageUrl` calls**

Replace (line ~118, inside `processOldBook`):

```ts
oldBook.coverImageUrl = await appService?.generateCoverImageUrl(oldBook);
```

with:

```ts
oldBook.coverImageUrl = await runEffect(
  Effect.flatMap(CoverService, (c) => c.generateCoverImageUrl(oldBook)),
);
```

Replace (line ~146, inside `processNewBook`):

```ts
newBook.coverImageUrl = await appService?.generateCoverImageUrl(newBook);
```

with:

```ts
newBook.coverImageUrl = await runEffect(
  Effect.flatMap(CoverService, (c) => c.generateCoverImageUrl(newBook)),
);
```

> Leave `appService?.downloadBookCovers(batch)` in this file untouched — that's a cloud op deferred to E4.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsgo --noEmit -p tsconfig.json 2>&1 | grep -iE 'library/index|useBooksSync' || echo "cover consumers clean"`
Expected: `cover consumers clean`.

- [ ] **Step 6: Run the related test suites**

Run: `pnpm vitest run src/__tests__/app/library 2>/dev/null || pnpm vitest run -t booksSync 2>/dev/null; echo "done"`
Expected: existing suites pass (or no matching suite — `done`). If a suite mocks `appService.generateCoverImageUrl`/`updateCoverImage`, rebridge it per the E2a "test rebridge" note in Task 9.

- [ ] **Step 7: Commit**

```bash
git add src/app/library/index.tsx src/app/library/hooks/useBooksSync.ts
git commit -m "refactor(effect): route remaining cover ops through CoverService port"
```

---

## Task 6: Migrate the Font consumers

**Files:**

- Modify: `src/components/settings/CustomFonts.tsx`
- Modify: `src/components/settings/DialogMenu.tsx`

- [ ] **Step 1: `CustomFonts.tsx` — add imports**

After `import { useEnv } from '@/context/EnvContext';` (line 5) add:

```ts
import { Effect } from 'effect';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { FontService } from '@/application/services/FontService';
```

- [ ] **Step 2: `CustomFonts.tsx` — get `runEffect` in the component**

Immediately after the line `const { appService, envConfig } = useEnv();` (line ~29), add:

```ts
const runEffect = useRunEffect();
```

- [ ] **Step 3: `CustomFonts.tsx` — swap `importFont`**

Replace (line ~55):

```ts
const fontInfo = await appService?.importFont(selectedFile.path || selectedFile.file);
```

with:

```ts
const fontInfo = await runEffect(
  Effect.flatMap(FontService, (s) => s.importFont(selectedFile.path || selectedFile.file)),
);
```

- [ ] **Step 4: `CustomFonts.tsx` — swap `deleteFont`**

Replace (line ~83):

```ts
appService?.deleteFont(font);
```

with:

```ts
void runEffect(Effect.flatMap(FontService, (s) => s.deleteFont(font)));
```

> Leave the `if (appService) void queueReplicaBinaryUpload('font', customFont);` line untouched — cloud, E4. `appService` is still used by `useFileSelector(appService, _)`, so keep it destructured.

- [ ] **Step 5: `DialogMenu.tsx` — add imports**

After `import { useEnv } from '@/context/EnvContext';` (line 6) add:

```ts
import { Effect } from 'effect';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { FontService } from '@/application/services/FontService';
```

- [ ] **Step 6: `DialogMenu.tsx` — get `runEffect`**

Immediately after `const { envConfig, appService } = useEnv();` (line ~30), add:

```ts
const runEffect = useRunEffect();
```

- [ ] **Step 7: `DialogMenu.tsx` — swap `deleteFont`**

Replace (line ~55):

```ts
appService!.deleteFont(font);
```

with:

```ts
void runEffect(Effect.flatMap(FontService, (s) => s.deleteFont(font)));
```

- [ ] **Step 8: Typecheck**

Run: `pnpm exec tsgo --noEmit -p tsconfig.json 2>&1 | grep -iE 'CustomFonts|DialogMenu' || echo "font consumers clean"`
Expected: `font consumers clean`.

> If tsgo reports `appService` unused in `DialogMenu.tsx`, rename the destructure to `_appService` (the `_`-prefix is allowed by ESLint). It is likely still referenced elsewhere — check before renaming.

- [ ] **Step 9: Commit**

```bash
git add src/components/settings/CustomFonts.tsx src/components/settings/DialogMenu.tsx
git commit -m "refactor(effect): migrate font import/delete consumers to FontService"
```

---

## Task 7: Migrate the Image consumer

**Files:**

- Modify: `src/components/settings/ColorPanel.tsx`

- [ ] **Step 1: Add imports**

After `import { useEnv } from '@/context/EnvContext';` (line 4) add:

```ts
import { Effect } from 'effect';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { ImageService } from '@/application/services/ImageService';
```

- [ ] **Step 2: Get `runEffect` in the component**

Immediately after `const { envConfig, appService } = useEnv();` (line ~40), add:

```ts
const runEffect = useRunEffect();
```

- [ ] **Step 3: Swap `importImage`**

Replace (line ~252):

```ts
const textureInfo = await appService?.importImage(selectedFile.path || selectedFile.file);
```

with:

```ts
const textureInfo = await runEffect(
  Effect.flatMap(ImageService, (s) => s.importImage(selectedFile.path || selectedFile.file)),
);
```

> Leave `if (appService) void queueReplicaBinaryUpload('texture', customTexture);` untouched — cloud, E4. `appService` stays for `useFileSelector`.

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsgo --noEmit -p tsconfig.json 2>&1 | grep -iE 'ColorPanel' || echo "image consumer clean"`
Expected: `image consumer clean`.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/ColorPanel.tsx
git commit -m "refactor(effect): migrate texture import consumer to ImageService"
```

---

## Task 8: Migrate the Dictionary consumer

**Files:**

- Modify: `src/components/settings/CustomDictionaries.tsx`

- [ ] **Step 1: Add imports**

After `import { useEnv } from '@/context/EnvContext';` (line 26) add:

```ts
import { Effect } from 'effect';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { DictionaryService } from '@/application/services/DictionaryService';
```

- [ ] **Step 2: Get `runEffect` in the component**

Immediately after `const { appService, envConfig } = useEnv();` (line ~230), add:

```ts
const runEffect = useRunEffect();
```

- [ ] **Step 3: Swap `importDictionaries`**

Replace (line ~427):

```ts
const importResult = await appService?.importDictionaries(result.files, dictionaries);
if (!importResult) return;
```

with:

```ts
const importResult = await runEffect(
  Effect.flatMap(DictionaryService, (s) => s.importDictionaries(result.files, dictionaries)),
);
```

> The `if (!importResult) return;` guard is removed: `runEffect` always resolves the result (it throws on failure into the surrounding `try/catch`), whereas `appService?.` could be `undefined`. The downstream `importResult.imported` / `.replacements` / `.orphanFiles` reads are unchanged.

- [ ] **Step 4: Swap `deleteDictionary`**

Replace (line ~487):

```ts
await appService?.deleteDictionary(dict);
```

with:

```ts
await runEffect(Effect.flatMap(DictionaryService, (s) => s.deleteDictionary(dict)));
```

> Leave the `queueDictionaryBinaryUpload(...)` lines untouched — cloud, E4. `appService` stays for `useFileSelector` + the cloud queue guards.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsgo --noEmit -p tsconfig.json 2>&1 | grep -iE 'CustomDictionaries' || echo "dict consumer clean"`
Expected: `dict consumer clean`.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/CustomDictionaries.tsx
git commit -m "refactor(effect): migrate dictionary import/delete consumer to DictionaryService"
```

---

## Task 9: Full verification

**Files:** none (validation + any test rebridges surfaced below).

- [ ] **Step 1: Run the full unit-test suite**

Run: `pnpm test`
Expected: green except the known env-flaky suites (`hardcover`, `turso-node`, `edgeTTS`, `opds-req`).

> **Test rebridge (E2a gotcha):** if a consumer test fails at collection because migrating the component pulled the whole `@/runtime/clientRuntime` graph in, add `vi.mock('@/runtime/clientRuntime', ...)` to that test — run effects through fake service layers with `vi.hoisted` spies (see `src/__tests__/store/custom-font-store.test.ts` for the pattern), or a no-op stub if the path isn't exercised. Any test that previously mocked `appService.{importFont,deleteFont,importImage,deleteImage,importDictionaries,deleteDictionary,generateCoverImageUrl,updateCoverImage}` must move that expectation onto the runtime/service.

- [ ] **Step 2: Lint + full typecheck**

Run: `pnpm lint`
Expected: clean except the pre-existing `scripts/upload-cjk-fonts-r2.ts` error (ancestor of `main` — not introduced here).

- [ ] **Step 3: Confirm the legacy paths are still intact (additive check)**

Run: `git grep -nE 'importFont|deleteFont|importImage|deleteImage|importDictionaries|deleteDictionary' src/services/appService.ts src/domain/system.ts`
Expected: the `appService` wrappers and `domain/system.ts` interface declarations are still present (untouched — they remain live until E5).

- [ ] **Step 4: Final commit (only if Step 1 required test rebridges)**

```bash
git add -A
git commit -m "test(effect): rebridge asset-consumer tests to clientRuntime"
```
