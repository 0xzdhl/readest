# E6b — Font/Image/Dict de-adapter (design)

**Date:** 2026-06-12
**Branch:** `effect/domain-type-migration`
**Predecessor:** E6a (Settings de-adapter) — the template slice. See
`2026-06-11-effect-e6a-settings-deadapter-design.md`.

## Goal

E6 removes the `makeLegacyFsAdapter` compatibility shim service-by-service. E6b
de-adapters the three **asset** services — `FontService`, `ImageService`,
`DictionaryService` — by rewriting their import/delete functions as
Effect-native code on the `FileSystem` port, then dropping
`makeLegacyFsAdapter` from the three live layers.

These three are simpler than Settings: their pure functions touch **only plain
`FileSystem` methods** (`openFile`, `createDir`, `writeFile`, `removeFile`,
`removeDir`, `exists`) — no `PathResolver` (`getPrefix`/`resolvePath`), no
`Platform`, and they do **not** use `persistence.ts` (only settings/library
do). So the de-adaptered layers depend on `FileSystem` only.

## Non-goals / explicitly untouched

- `src/infra/shared/fsPortAdapter.ts` (`makeLegacyFsAdapter`), the legacy
  `FileSystem` interface in `@/domain/system`, and the `@/domain/system`
  module itself **stay as-is**. They are still consumed by the Book / Library /
  Cover / Cloud layers and the `exportBook` / `importBooks` usecases (the
  remaining 6 `makeLegacyFsAdapter` consumers after E6b). They are removed in
  E6c–E6e.
- `computeFontContentId` (`src/services/fontService.ts`) and
  `computeTextureContentId` (`src/services/imageService.ts`) — pure, no-fs
  content-id helpers — **stay where they are**. They are imported by
  `src/services/sync/adapters/{font,texture}.ts` and
  `src/store/custom{Font,Texture}Store.ts`; moving them would churn live
  consumers for no benefit. The old `fontService.ts`/`imageService.ts` shrink
  to just these helpers (+ their docs).
- The dict sibling modules — `stardictReader`, `slobReader`, `dictReader`,
  `dictZip`, `dictionaryDedup`, `contentId`, `registry`, `providers/*` — stay
  in `src/services/dictionaries/`.
- `AssetError` (`src/application/errors/AppError.ts`,
  `Data.TaggedError<{operation, cause}>`) — reused unchanged (shared by the
  font/image/dict family, established in E3).
- The application-service **tags** `FontService` / `ImageService` /
  `DictionaryService` (`src/application/services/*.ts`) and their `*Shape`
  interfaces — unchanged. Method signatures and error channels
  (`Effect.Effect<…, AssetError>`) are identical before and after.

## Architecture

Three new Effect-native modules under `src/application/services/`, mirroring
E6a's `src/application/services/settings/*`:

| New module                                                   | Functions                                                                                                                                                                              | Reuses (unchanged)                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/application/services/fonts/fontAssets.ts`               | `importFont`, `deleteFont`                                                                                                                                                             | `computeFontContentId` from `@/services/fontService`; `parseFontInfo`, `md5`/`partialMd5`, `uniqueId`, `getFilename`      |
| `src/application/services/images/imageAssets.ts`             | `importImage`, `deleteImage`                                                                                                                                                           | `computeTextureContentId` from `@/services/imageService`; `getTextureName`, `md5`/`partialMd5`, `uniqueId`, `getFilename` |
| `src/application/services/dictionaries/dictionaryService.ts` | `importDictionaries`, `deleteDictionary` + their fs-touching bundle-import helpers (`readSource`, `importStarDictBundle`, `importMdictBundle`, `importDictBundle`, `importSlobBundle`) | sibling readers/dedup/contentId from `@/services/dictionaries/*`                                                          |

Each function:

- Is written as `Effect.gen(function* () { … })` that does `const fs = yield*
FileSystem` and calls port methods directly (`yield* fs.openFile(...)`,
  `yield* fs.writeFile(...)`, …), so its requirement is `FileSystem`.
- Maps its own failures to `AssetError({ operation })` **internally** via one
  top-level `Effect.mapError(cause => new AssetError({ operation, cause }))`,
  with the operation label (`'importFont'`, `'deleteFont'`, `'importImage'`,
  `'deleteImage'`, `'importDictionaries'`, `'deleteDictionary'`) hardcoded in
  the function (E6a `systemSettings.ts` does exactly this with `SettingsError`).
- Returns the same result type as today (`CustomFontInfo | null`,
  `CustomTextureInfo | null`, `ImportDictionariesResult`, `void`).

This makes the **layers trivial** — a `Layer.effect` that resolves `FileSystem`
once and `provideService`s it into each method's effect (the
`SettingsRepository.layer` `provide<A,E>` helper pattern), with **no inline
`err` wrapper and no `PathResolver`**:

```ts
export const FontServiceLive = Layer.effect(
  FontService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const provide = <A>(e: Effect.Effect<A, AssetError, FileSystem>) =>
      e.pipe(Effect.provideService(FileSystem, fsPort));
    return {
      importFont: (file) => provide(importFont(file)),
      deleteFont: (font) => provide(deleteFont(font)),
    } satisfies FontServiceShape;
  }),
);
```

### Dictionary code-split (preserved)

`dictionaryService.ts` statically imports `scanEntryOffsets` /
`serializeOffsetsSidecar` from `./stardictReader`, and **dynamically** imports
the heavy readers inside the bundle importers (`await import('js-mdict')`,
`await import('./slobReader')`). Both structures are kept verbatim after the
move (the static import repoints to `@/services/dictionaries/stardictReader`;
the dynamic imports are unchanged). The module is itself code-split because the
**layer lazy-loads it**:

```ts
importDictionaries: (files, existingDictionaries = []) =>
  Effect.tryPromise({
    try: () => import('@/application/services/dictionaries/dictionaryService'),
    catch: (cause) => new AssetError({ operation: 'importDictionaries', cause }),
  }).pipe(
    Effect.flatMap((m) => m.importDictionaries(files, existingDictionaries)),
    Effect.provideService(FileSystem, fsPort),
  ),
```

Both error branches (chunk-load failure from the dynamic `import`, and the
function's internal `AssetError`) resolve to `AssetError` — faithful to the
current single-`tryPromise` wrapping.

## Fidelity details

- **Best-effort swallows stay swallowed.** `deleteFont`/`deleteImage`'s
  bundle-dir cleanup (`if (bundleDir) try { removeDir } catch { console.warn }`)
  and dict's duplicate-bundle / replaced-bundle / reincarnation cleanup
  (`try { removeDir } catch { console.warn }`) become
  `fs.removeDir(...).pipe(Effect.catchAll(() => Effect.sync(() => console.warn(...))))`.
  These do **not** reach the `AssetError` channel — matching legacy, where the
  swallow happens before the outer `tryPromise`.
- **Propagating fs ops** — `removeFile`, `writeFile`, `createDir`, `openFile`,
  `exists`, and the propagating `removeDir` in `deleteDictionary` — flow `FsError`
  into the error channel, caught by the one top-level `mapError → AssetError`.
- **`readSource` hard error.** `dictionaryService.readSource` throws
  `new Error('SelectedFile has neither path nor file')` when a `SelectedFile`
  has neither `path` nor `file`. Modeled as `yield* Effect.fail(new Error(...))`
  so the `mapError` boundary wraps it into `AssetError` (currently surfaced via
  promise rejection → `tryPromise` catch).
- **`null` returns** for the no-file-given path of `importFont`/`importImage`
  preserved (the function returns `Effect.succeed(null)` for that branch).
- **`Date.now()` / `uuidv4()` / `console.warn`** calls inside the pure logic
  are kept verbatim (dict uses `Date.now()` for `addedAt`, `uuidv4()` for
  reincarnation tokens). These run inside `Effect.gen`/`Effect.sync` bodies.

## Layers after E6b

`FontService.layer.ts`, `ImageService.layer.ts`,
`DictionaryService.layer.ts`:

- Drop `import { makeLegacyFsAdapter } from './fsPortAdapter'` and the
  `const fs = makeLegacyFsAdapter(fsPort, resolver)` line.
- Drop `const resolver = yield* PathResolver` (no longer needed) and the
  `@/application/ports/PathResolver` import.
- Drop the inline `err` helper (mapping now lives in the functions, except the
  dict layer's `tryPromise` catch for the dynamic-import branch).
- Required context shrinks `FileSystem | PathResolver` → `FileSystem`.

No change to `clientRuntime.ts` `ClientServices` union or the
`client-tauri`/`client-web` `SharedRepos` wiring: the tags are unchanged and
both runtimes already provide `FileSystem`. Providing the (now-unused)
`PathResolver` to these layers is harmless, but the wiring already merges it
for the other layers regardless.

## Test strategy (regression guards)

**Existing layer tests are the primary guard and already test at the new
boundary.** `src/__tests__/application/{fontService,imageService,dictionaryService}.test.ts`
build `Layer.succeed(FileSystem, stub)` where the stub's methods already return
`Effect`s (`removeFile: () => Effect.void`, `Effect.fail(new FsError(...))`),
provide it under the live layer, and assert `AssetError.operation` on failure.
Because the rewrite consumes those same port-Effect stubs directly (instead of
through `makeLegacyFsAdapter`'s `Effect.runPromise`), these tests stay green
with **little or no change**. Per the test-first rule: run them first; if any
assertion goes red due to a behavioral shift, the rewrite is wrong — fix the
rewrite, not the test.

Notes:

- The font/image tests merge `baseResolver` (`TestPathResolver` + `PathState`)
  into the layer. After the rewrite the layers no longer require
  `PathResolver`; the extra provided layer is harmless, so the tests need no
  edit on that account. (Optionally simplify, but not required.)
- The dict test's `makeFs` already loosens the stub type to
  `Record<string, unknown>` (because `exists` has a `never`-error variant) —
  kept.
- Failure mocks use `FsError`, not bare `Error` — kept.

**Consumer tests** from E3 (`CustomFonts`, `DialogMenu`, `ColorPanel`,
`CustomDictionaries`) already mock `@/runtime/clientRuntime` and call through
the service tags; they are unaffected by the layer-internal rewrite and remain
as end-to-end guards.

**New direct tests** for the moved modules only where a behavior is not already
covered by the layer tests (e.g. dict's intra-call dedup / replacement branch
if not exercised) — added sparingly.

## Verification (done-conditions)

1. `pnpm test` — the 3 layer tests + the E3 consumer tests pass; full suite
   green minus the known pre-existing env/timer-flaky set (auth-page /
   useBookShortcuts / theme-store import-time env, ProgressBar / ReadingRuler
   timers, clientRuntime / edgeTTS / opds-req sandbox, hardcover).
2. `pnpm lint` — tsgo 0-new (only the pre-existing
   `scripts/upload-cjk-fonts-r2.ts` baseline error); biome only the pre-existing
   `SettingsDialog.tsx` baseline. The 3 layers' required context correctly
   shrinks to `FileSystem`.
3. Gate: `grep -rl makeLegacyFsAdapter src` no longer lists
   `FontService.layer.ts` / `ImageService.layer.ts` /
   `DictionaryService.layer.ts` — consumer count drops 9 → 6 (Book / Library /
   Cover / Cloud layers + `exportBook` / `importBooks` usecases remain).
4. Gate: nothing statically imports
   `@/application/services/dictionaries/dictionaryService` except the layer's
   dynamic `import()` — code-split intact (`stardictReader` still only reachable
   via that lazy chunk; `js-mdict`/`slobReader` still dynamically imported).
5. No `src-tauri/` or `*.koplugin` Lua changes → Rust/Lua checks N/A.

## Decision log

- **Move (E6a-style), not in-place.** The rewritten import/delete functions go
  to `src/application/services/{fonts,images,dictionaries}/` rather than being
  rewritten in `src/services/`. Chosen by the user for uniformity with the
  Settings slice. Cost (dict's sibling-reader imports crossing
  application→services, content-id left behind in `services/`) is accepted;
  application→services is already an established direction (E6a settings imports
  `@/services/constants`).
- **Error mapping in the function, trivial layer.** Each function maps to
  `AssetError({operation})` internally; the layer only `provideService`s
  `FileSystem`. Mirrors `SettingsRepository.layer` and E6a `systemSettings.ts`.
  The operation labels move from the layer's `err(...)` calls into the
  functions. The dict layer additionally maps the dynamic-`import()` chunk-load
  failure to `AssetError` in its `tryPromise` catch.
- **`PathResolver` dropped from the three layers.** The pure functions never
  call `getPrefix`/`resolvePath`, so the de-adaptered layers need `FileSystem`
  only.
- **Content-id helpers stay in `services/`.** Pure, no-fs, multi-consumer;
  out of scope for an fs de-adapter.
