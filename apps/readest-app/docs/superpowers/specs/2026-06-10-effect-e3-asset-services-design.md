# E3 — Cover (remaining) / Font / Image / Dictionary asset services (Effect migration)

**Branch:** `effect/domain-type-migration`
**Status:** design approved 2026-06-10
**Predecessors:** E1 (portable-consumer migration), E2a (Book/Library/Cover data layer), E2b (import/export usecases + library.json consolidation) — all done.

## Goal

Migrate the remaining local asset operations off the legacy `getAppService()` god-object onto the Effect ports/services architecture, reusing the existing pure service functions verbatim via `makeLegacyFsAdapter` — the same pattern E2a used for `CoverService`/`BookRepository`. Strictly additive: the legacy `appService` wrappers and `domain/system.ts` interface entries stay live until E5.

In scope:

- **Cover (remaining):** repoint the 3 call sites still on `appService.{updateCoverImage,generateCoverImageUrl}` to the already-existing `CoverService` port. No new code.
- **Font:** new `FontService` (Tag + live layer) reusing `services/fontService.{importFont,deleteFont}`.
- **Image:** new `ImageService` (Tag + live layer) reusing `services/imageService.{importImage,deleteImage}`.
- **Dictionary:** new `DictionaryService` (Tag + live layer) reusing `services/dictionaries/dictionaryService.{importDictionaries,deleteDictionary}`.
- Migrate the 4 consumer components for the above.

Out of scope (stays on legacy — E4 cloud / E5 god-object removal):

- Cloud sync adapters `services/sync/adapters/{font,texture}.ts`; `queueReplicaBinaryUpload`, `queueDictionaryBinaryUpload`; `appService.downloadBookCovers`.
- The `appService.{importFont,deleteFont,importImage,deleteImage,importDictionaries,deleteDictionary}` wrappers and their `domain/system.ts` interface declarations.
- The asset-loading paths already on the runtime (`customFontStore`/`customTextureStore` blob-URL loading via `getClientRuntime()`) — untouched, already migrated in E1.

## Why this shape (decision log)

- **Services, not usecases.** The pure fns (`importFont(fs, file)`, etc.) take a _legacy_ `FileSystem`, which can only be constructed via `makeLegacyFsAdapter(fsPort, resolver)` — and that helper lives in `infra/`. Usecases must not import `infra/` (dependency direction: `app → ports/repos → domain`; `infra → ports + domain`). So the adapter must be built inside an **infra layer**, which makes these **services** (`Context.Tag`) with live layers — identical to `CoverService`/`BookRepository`. This matches the "same pattern as E2a" instruction. (The brief's word "usecases" resolves to services here.)
- **Single `AssetError`.** One `Data.TaggedError('AssetError')` shared by all three services, mirroring E2a where the whole book/library/cover family shares `BookError` (`CoverService.layer` raises `BookError`, not a `CoverError`). Consumers only toast `cause`; per-tag discrimination is unused. (Considered: per-domain `FontError`/`ImageError`/`DictionaryError` — rejected as 3 classes for thin wrappers.)
- **`ImageService` / `importImage` naming.** Match the underlying `imageService.importImage`/`deleteImage` fn names and the `Images` base dir, minimizing translation when reading the layer (even though the domain type is `CustomTextureInfo`). (Considered: `TextureService`/`importTexture` — rejected to keep parity with the service fns.)
- **No `Platform` dependency.** Unlike `CoverService` (which snapshots `platform.info` + `localBooksDir`), these fns only touch `fs`, so the layers yield just `FileSystem` + `PathResolver`.

## Components

### 1. Error contract — `src/application/errors/AppError.ts`

```ts
export class AssetError extends Data.TaggedError('AssetError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}
```

Add `AssetError` to the `AppError` union.

### 2. Service tags — `src/application/services/`

Each follows the `CoverService.ts` shape (separate `<Name>Shape` interface, `Context.Tag('app/<Name>')`).

- **`FontService.ts`** — `app/FontService`
  ```ts
  interface FontServiceShape {
    readonly importFont: (file?: string | File) => Effect.Effect<CustomFontInfo | null, AssetError>;
    readonly deleteFont: (font: CustomFont) => Effect.Effect<void, AssetError>;
  }
  ```
- **`ImageService.ts`** — `app/ImageService`
  ```ts
  interface ImageServiceShape {
    readonly importImage: (
      file?: string | File,
    ) => Effect.Effect<CustomTextureInfo | null, AssetError>;
    readonly deleteImage: (texture: CustomTextureInfo) => Effect.Effect<void, AssetError>;
  }
  ```
- **`DictionaryService.ts`** — `app/DictionaryService`
  ```ts
  interface DictionaryServiceShape {
    readonly importDictionaries: (
      files: SelectedFile[],
      existingDictionaries?: ImportedDictionary[],
    ) => Effect.Effect<ImportDictionariesResult, AssetError>;
    readonly deleteDictionary: (dict: ImportedDictionary) => Effect.Effect<void, AssetError>;
  }
  ```
  (Mirror the exact param/return types of `dictionaryService.importDictionaries`/`deleteDictionary`: `SelectedFile[]`, `ImportedDictionary[]`, `Promise<ImportDictionariesResult>`.)

### 3. Live layers — `src/infra/shared/{FontService,ImageService,DictionaryService}.layer.ts`

Each is a `Layer.effect` that yields `FileSystem` + `PathResolver`, builds the legacy adapter, and wraps each pure fn in `Effect.tryPromise` mapping rejections to `AssetError`. Template (Font):

```ts
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

`ImageService.layer.ts` is structurally identical (reusing `ImageSvc`).

**`DictionaryService.layer.ts` — preserve code-splitting.** `appService` lazy-loads `dictionaryService` via dynamic `import('./dictionaries/dictionaryService')` (it's a heavy ~23KB module pulling slob/stardict/mdict readers) to keep it out of the initial bundle. A static top-level import in the layer would defeat that — `client-tauri.ts`/`client-web.ts` import the layer statically, so the dict readers would land in the main client chunk. Preserve laziness by dynamic-importing inside the effect:

```ts
importDictionaries: (files, existing = []) =>
  Effect.tryPromise({
    try: async () => {
      const m = await import('@/services/dictionaries/dictionaryService');
      return m.importDictionaries(fs, files, existing);
    },
    catch: err('importDictionaries'),
  }),
```

Same for `deleteDictionary`. (`fontService`/`imageService` are tiny — static imports are fine.) Zero logic divergence from the pure fns.

### 4. Runtime wiring

- **`src/runtime/clientRuntime.ts`:** add `FontService | ImageService | DictionaryService` to the `ClientServices` union (import the Tags as `type`).
- **`src/runtime/client-tauri.ts` + `src/runtime/client-web.ts`:** the three layers depend only on `FileSystem` + `PathResolver` (present in `SharedBase`/`SharedBaseWithCover`). Add `FontServiceLive`, `ImageServiceLive`, `DictionaryServiceLive` to the existing `SharedRepos` `Layer.mergeAll(...)` block (alongside `BookRepositoryLive`/`LibraryRepositoryLive`). No new base needed — they don't depend on `CoverService`.

### 5. Consumer migration

Pattern: `runEffect(Effect.flatMap(<Service>, (s) => s.<method>(...)))` where `runEffect = useRunEffect()` (components) or the existing `runEffect` already in scope (`useBooksSync`). `runEffect` falls back to the singleton, so the `appService?` null-guards on these calls are dropped.

- **Cover — `src/app/library/index.tsx` (~807):** `appService?.updateCoverImage(book, url, file)` → `runEffect(Effect.flatMap(CoverService, (c) => c.updateCoverImage(book, url, file)))`. Keep the surrounding `try/catch`.
- **Cover — `src/app/library/hooks/useBooksSync.ts` (118, 146):** `appService?.generateCoverImageUrl(book)` → `runEffect(Effect.flatMap(CoverService, (c) => c.generateCoverImageUrl(book)))`. Leave `downloadBookCovers` (cloud, E4) on `appService`.
- **Font — `src/components/settings/CustomFonts.tsx` (55 import, 83 delete)** and **`src/components/settings/DialogMenu.tsx` (55 delete)** → `FontService`. Keep `queueReplicaBinaryUpload` (cloud) guarded by `appService`.
- **Image — `src/components/settings/ColorPanel.tsx` (252 import)** → `ImageService`. Keep `queueReplicaBinaryUpload` (cloud) guarded by `appService`.
- **Dict — `src/components/settings/CustomDictionaries.tsx` (427 import, 487 delete)** → `DictionaryService`. Keep `queueDictionaryBinaryUpload` (cloud) guarded by `appService`.

Components add `useRunEffect` (and the relevant `import { <Service> }`). They retain `useEnv().appService` where still needed for non-E3 concerns (`useFileSelector(appService, _)`, cloud queue calls).

## Error handling

Pure fns throw on FS failure; layers map every rejection to `AssetError({ operation, cause })`. Consumers run via `runEffect`/`runPromise`, which rejects with the `AssetError` on failure — caught by the existing component `try/catch` (toast). `cause` carries the original error for message localization (E2b convention: preserve the unwrapped cause). `importFont`/`importImage` returning `null` (no file selected) is a success value, not an error — preserved.

## Testing (test-first)

Per `.claude/rules/test-first.md` and `verification.md`.

- **Per service (new tests under `src/__tests__/`):** build the live layer on a runtime providing the in-memory `FileSystem` + `PathResolver` doubles (`src/__tests__/support/*`, `src/runtime/test.ts`). Assert:
  - `importFont`/`importImage` write the `<bundleDir>/<filename>` under the correct base and return a populated `CustomFontInfo`/`CustomTextureInfo` (path, bundleDir, contentId, byteSize); `null` when no file given.
  - `deleteFont`/`deleteImage` remove the file and the empty `bundleDir`.
  - `importDictionaries`/`deleteDictionary` round-trip against representative inputs.
  - A failing fs double surfaces as `AssetError` with the original `cause`.
- **Consumer tests:** any test mocking `appService.{importFont,deleteFont,importImage,deleteImage,importDictionaries,deleteDictionary}` rebridges to `vi.mock('@/runtime/clientRuntime')` (E2a "test rebridge" gotcha — migrating a component pulls the whole runtime graph at collection; run effects through fake service layers with `vi.hoisted` spies, or a no-op stub if the path isn't exercised).
- **Full suite:** `pnpm test` green (pre-existing env-flaky: hardcover/turso-node/edgeTTS/opds-req); `pnpm lint` clean (tsgo: each runtime's `ManagedRuntime.make` must still resolve to requirement `never`).

## Net change

1 error + 3 service tags + 3 layers + runtime wiring (3 files) + ~6 consumer files (`CustomFonts`, `DialogMenu`, `ColorPanel`, `CustomDictionaries`, `library/index`, `useBooksSync`) + per-service tests.
