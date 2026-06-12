# E6b — Font/Image/Dict de-adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `makeLegacyFsAdapter` from the `FontService`/`ImageService`/`DictionaryService` layers by rewriting their import/delete functions as Effect-native code on the `FileSystem` port (E6a Settings pattern).

**Architecture:** Three new Effect-native modules under `src/application/services/{fonts,images,dictionaries}/` — each `yield* FileSystem`, calls port methods directly, and maps its own failures to `AssetError({operation})` internally. The three live layers (`src/infra/shared/*.layer.ts`) drop the adapter + `PathResolver` and become trivial `provideService(FileSystem)` wrappers. Dictionary keeps its lazy `import()` code-split. Content-id helpers and `fsPortAdapter.ts`/`LegacyFileSystem`/`domain/system.ts` stay untouched (later E6 slices).

**Tech Stack:** Effect TS (`Effect.gen`, `Layer.effect`, `Effect.provideService`, `Effect.tryPromise`, `Effect.mapError`, `Effect.catchAll`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-effect-e6b-font-image-dict-deadapter-design.md`

---

## File Structure

**Create:**

- `src/application/services/fonts/fontAssets.ts` — Effect-native `importFont`/`deleteFont`.
- `src/application/services/images/imageAssets.ts` — Effect-native `importImage`/`deleteImage`.
- `src/application/services/dictionaries/dictionaryService.ts` — moved + Effect-native `importDictionaries`/`deleteDictionary` (+ fs-touching bundle helpers).

**Modify:**

- `src/infra/shared/FontService.layer.ts` — drop adapter/PathResolver; provide FileSystem only.
- `src/infra/shared/ImageService.layer.ts` — same.
- `src/infra/shared/DictionaryService.layer.ts` — same, keep lazy `import()`.
- `src/services/fontService.ts` — remove `importFont`/`deleteFont`; keep `computeFontContentId`.
- `src/services/imageService.ts` — remove `importImage`/`deleteImage`; keep `computeTextureContentId`.

**Delete:**

- `src/services/dictionaries/dictionaryService.ts` — replaced by the moved file (via `git mv`).

**Untouched (regression guards / later slices):**

- `src/__tests__/application/{fontService,imageService,dictionaryService}.test.ts` — already test at the port boundary; should stay green.
- `src/services/dictionaries/{stardictReader,slobReader,dictReader,dictZip,dictionaryDedup,contentId,registry,providers}` — siblings.
- `src/infra/shared/fsPortAdapter.ts`, `@/domain/system`, `@/application/errors/AppError` (`AssetError`/`FsError`).

---

## Task 1: Font de-adapter

**Files:**

- Create: `src/application/services/fonts/fontAssets.ts`
- Modify: `src/infra/shared/FontService.layer.ts`, `src/services/fontService.ts`
- Test (guard): `src/__tests__/application/fontService.test.ts`

- [ ] **Step 1: Create the Effect-native module**

Create `src/application/services/fonts/fontAssets.ts`:

```ts
import { Effect } from 'effect';
import type { CustomFont, CustomFontInfo } from '@/domain/fonts';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { computeFontContentId } from '@/services/fontService';
import { parseFontInfo } from '@/utils/font';
import { partialMd5 } from '@/utils/md5';
import { uniqueId } from '@/utils/misc';
import { getFilename } from '@/utils/path';

/**
 * Import a font into the user's `Fonts` base under a per-font bundle dir
 * (`<bundleDir>/<filename>`). Effect-native port of the legacy
 * `fontService.importFont`; maps any failure to `AssetError`.
 */
export const importFont = (
  file?: string | File,
): Effect.Effect<CustomFontInfo | null, AssetError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const bundleDir = uniqueId();
    let filename: string;
    let bytes: ArrayBuffer;

    if (typeof file === 'string') {
      const fileobj = yield* fs.openFile(file, 'None');
      filename = fileobj.name || getFilename(file);
      bytes = yield* Effect.tryPromise(() => fileobj.arrayBuffer());
    } else if (file) {
      filename = getFilename(file.name);
      bytes = yield* Effect.tryPromise(() => file.arrayBuffer());
    } else {
      return null;
    }

    const fontPath = `${bundleDir}/${filename}`;
    yield* fs.createDir(bundleDir, 'Fonts', true);
    yield* fs.writeFile(fontPath, 'Fonts', bytes);

    const fontFile = yield* fs.openFile(fontPath, 'Fonts');
    const partialMD5 = yield* Effect.tryPromise(() => partialMd5(fontFile));
    const byteSize = bytes.byteLength;
    const contentId = computeFontContentId(partialMD5, byteSize, filename);

    return {
      path: fontPath,
      bundleDir,
      contentId,
      byteSize,
      ...parseFontInfo(bytes, filename),
    };
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'importFont', cause })));

/**
 * Delete a font file and its (now-empty) per-font bundle dir. The bundle-dir
 * removal is best-effort (legacy logged + continued), so it is swallowed and
 * never surfaces as an `AssetError`.
 */
export const deleteFont = (font: CustomFont): Effect.Effect<void, AssetError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.removeFile(font.path, 'Fonts');
    if (font.bundleDir) {
      yield* fs
        .removeDir(font.bundleDir, 'Fonts', true)
        .pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => console.warn('Failed to remove font bundleDir', font.bundleDir, err)),
          ),
        );
    }
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'deleteFont', cause })));
```

- [ ] **Step 2: Shrink the legacy `fontService.ts` to the content-id helper**

In `src/services/fontService.ts`, DELETE the `importFont` and `deleteFont`
functions (lines ~19–76, the two `export async function` blocks and their doc
comments) and the now-unused imports. Keep `computeFontContentId` and its doc.
The file must end up as:

```ts
import { md5 } from '@/utils/md5';

/**
 * Build the cross-device content id for a font:
 * `md5(partialMd5 ‖ byteSize ‖ filename)`. Same recipe shape as
 * dictionary.computeReplicaId — keeps the kinds aligned.
 */
export const computeFontContentId = (
  partialMd5: string,
  byteSize: number,
  filename: string,
): string => md5(`${partialMd5}|${byteSize}|${filename}`);
```

(Removed imports: `CustomFont`/`CustomFontInfo`, `FileSystem`, `parseFontInfo`,
`partialMd5`, `uniqueId`, `getFilename` — all only used by the deleted fns.
Keep only `md5`.)

- [ ] **Step 3: Rewrite the layer**

Replace `src/infra/shared/FontService.layer.ts` entirely:

```ts
import { Effect, Layer } from 'effect';
import { FileSystem } from '@/application/ports/FileSystem';
import { FontService, type FontServiceShape } from '@/application/services/FontService';
import { importFont, deleteFont } from '@/application/services/fonts/fontAssets';

export const FontServiceLive = Layer.effect(
  FontService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem>) =>
      e.pipe(Effect.provideService(FileSystem, fsPort));
    return {
      importFont: (file) => provide(importFont(file)),
      deleteFont: (font) => provide(deleteFont(font)),
    } satisfies FontServiceShape;
  }),
);
```

- [ ] **Step 4: Run the guard test (must stay green)**

Run: `pnpm vitest run src/__tests__/application/fontService.test.ts`
Expected: PASS — all 5 tests (importFont populated info, importFont null,
deleteFont removes file, deleteFont skips removeDir for legacy fonts, maps
failure to `AssetError` with `operation === 'deleteFont'`). The test provides a
port-shaped `FileSystem` stub and merges `baseResolver` (now-unused but
harmless).

If anything fails, the rewrite diverged from legacy behavior — fix the module,
not the test.

- [ ] **Step 5: tsgo + biome on the touched files**

Run: `pnpm lint`
Expected: 0 new errors (only the pre-existing `scripts/upload-cjk-fonts-r2.ts`
and `SettingsDialog.tsx` baselines). `FontServiceLive`'s required context is now
`FileSystem` only.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/fonts/fontAssets.ts src/infra/shared/FontService.layer.ts src/services/fontService.ts
git commit -m "refactor(effect): FontService de-adapter — Effect-native importFont/deleteFont (E6b)"
```

---

## Task 2: Image de-adapter

**Files:**

- Create: `src/application/services/images/imageAssets.ts`
- Modify: `src/infra/shared/ImageService.layer.ts`, `src/services/imageService.ts`
- Test (guard): `src/__tests__/application/imageService.test.ts`

- [ ] **Step 1: Create the Effect-native module**

Create `src/application/services/images/imageAssets.ts`:

```ts
import { Effect } from 'effect';
import type { CustomTextureInfo } from '@/domain/textures';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { computeTextureContentId } from '@/services/imageService';
import { getTextureName } from '@/styles/textures';
import { partialMd5 } from '@/utils/md5';
import { uniqueId } from '@/utils/misc';
import { getFilename } from '@/utils/path';

/**
 * Import an image into the user's `Images` base under a per-texture bundle dir
 * (`<bundleDir>/<filename>`). Effect-native port of the legacy
 * `imageService.importImage`; maps any failure to `AssetError`.
 */
export const importImage = (
  file?: string | File,
): Effect.Effect<CustomTextureInfo | null, AssetError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const bundleDir = uniqueId();
    let filename: string;
    let bytes: ArrayBuffer;

    if (typeof file === 'string') {
      const fileobj = yield* fs.openFile(file, 'None');
      filename = fileobj.name || getFilename(file);
      bytes = yield* Effect.tryPromise(() => fileobj.arrayBuffer());
    } else if (file) {
      filename = getFilename(file.name);
      bytes = yield* Effect.tryPromise(() => file.arrayBuffer());
    } else {
      return null;
    }

    const texturePath = `${bundleDir}/${filename}`;
    yield* fs.createDir(bundleDir, 'Images', true);
    yield* fs.writeFile(texturePath, 'Images', bytes);

    const textureFile = yield* fs.openFile(texturePath, 'Images');
    const partialMD5 = yield* Effect.tryPromise(() => partialMd5(textureFile));
    const byteSize = bytes.byteLength;
    const contentId = computeTextureContentId(partialMD5, byteSize, filename);

    return {
      name: getTextureName(filename),
      path: texturePath,
      bundleDir,
      contentId,
      byteSize,
    };
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'importImage', cause })));

/**
 * Delete a texture file and its (now-empty) per-texture bundle dir. The
 * bundle-dir removal is best-effort (swallowed), never an `AssetError`.
 */
export const deleteImage = (
  texture: CustomTextureInfo,
): Effect.Effect<void, AssetError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.removeFile(texture.path, 'Images');
    if (texture.bundleDir) {
      yield* fs
        .removeDir(texture.bundleDir, 'Images', true)
        .pipe(
          Effect.catchAll((err) =>
            Effect.sync(() =>
              console.warn('Failed to remove texture bundleDir', texture.bundleDir, err),
            ),
          ),
        );
    }
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'deleteImage', cause })));
```

- [ ] **Step 2: Shrink the legacy `imageService.ts` to the content-id helper**

In `src/services/imageService.ts`, DELETE the `importImage` and `deleteImage`
functions and now-unused imports. Keep `computeTextureContentId`. Final file:

```ts
import { md5 } from '@/utils/md5';

/**
 * Build the cross-device content id for a texture:
 * `md5(partialMd5 ‖ byteSize ‖ filename)`. Same recipe shape as
 * fontService.computeFontContentId — keeps the kinds aligned.
 */
export const computeTextureContentId = (
  partialMd5: string,
  byteSize: number,
  filename: string,
): string => md5(`${partialMd5}|${byteSize}|${filename}`);
```

(Removed imports: `getTextureName`, `CustomTextureInfo`, `FileSystem`,
`partialMd5`, `uniqueId`, `getFilename`. Keep only `md5`.)

- [ ] **Step 3: Rewrite the layer**

Replace `src/infra/shared/ImageService.layer.ts` entirely:

```ts
import { Effect, Layer } from 'effect';
import { FileSystem } from '@/application/ports/FileSystem';
import { ImageService, type ImageServiceShape } from '@/application/services/ImageService';
import { importImage, deleteImage } from '@/application/services/images/imageAssets';

export const ImageServiceLive = Layer.effect(
  ImageService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem>) =>
      e.pipe(Effect.provideService(FileSystem, fsPort));
    return {
      importImage: (file) => provide(importImage(file)),
      deleteImage: (texture) => provide(deleteImage(texture)),
    } satisfies ImageServiceShape;
  }),
);
```

- [ ] **Step 4: Run the guard test (must stay green)**

Run: `pnpm vitest run src/__tests__/application/imageService.test.ts`
Expected: PASS — all tests (importImage populated info, importImage null,
deleteImage removes file, deleteImage skips removeDir without bundleDir, maps
failure to `AssetError` with `operation === 'deleteImage'`).

- [ ] **Step 5: tsgo + biome**

Run: `pnpm lint`
Expected: 0 new errors. `ImageServiceLive` requires `FileSystem` only.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/images/imageAssets.ts src/infra/shared/ImageService.layer.ts src/services/imageService.ts
git commit -m "refactor(effect): ImageService de-adapter — Effect-native importImage/deleteImage (E6b)"
```

---

## Task 3: Dictionary de-adapter

The dict file is large; most of it is pure (grouping, classify, parseIfo,
offset scanning, dedup) and is **moved verbatim**. Only the fs-touching
functions are converted to Effect-native. The heavy readers stay
dynamically-imported and the layer keeps lazy-loading the module, so code-split
is preserved.

**Files:**

- Move (`git mv`): `src/services/dictionaries/dictionaryService.ts` → `src/application/services/dictionaries/dictionaryService.ts`
- Modify: the moved file (imports + 9 fs-touching functions), `src/infra/shared/DictionaryService.layer.ts`
- Test (guard): `src/__tests__/application/dictionaryService.test.ts`

- [ ] **Step 1: Move the file**

```bash
mkdir -p src/application/services/dictionaries
git mv src/services/dictionaries/dictionaryService.ts src/application/services/dictionaries/dictionaryService.ts
```

- [ ] **Step 2: Repoint sibling imports + add Effect/port imports**

At the top of the moved file:

- Change `import type { FileSystem } from '@/domain/system';` →
  `import { FileSystem } from '@/application/ports/FileSystem';`
  (now a runtime tag, not just a type — it is `yield*`-ed).
- Repoint the relative sibling imports to absolute `@/services/dictionaries/*`:
  - `from './stardictReader'` → `from '@/services/dictionaries/stardictReader'`
  - `from './contentId'` → `from '@/services/dictionaries/contentId'`
  - `from './dictionaryDedup'` → `from '@/services/dictionaries/dictionaryDedup'`
  - the dynamic `import('./slobReader')` (inside `importSlobBundle`) →
    `import('@/services/dictionaries/slobReader')`
  - leave `import('js-mdict')` and `import('fflate')` as-is.
- Add at the top of the imports block:
  `import { Effect } from 'effect';`
  `import { AssetError, type FsError } from '@/application/errors/AppError';`

Leave every other import (`SelectedFile`, `ImportedDictionary`,
`ImportDictionariesResult`, `uniqueId`, `getFilename`, `uuidv4`) unchanged.

- [ ] **Step 3: Convert the leaf fs helpers**

Replace `readSource`, `writeBundleFile`, and `createBundleDir` with Effect
versions:

```ts
/** Read the source file as a `File` (web) or via the path (Tauri filesystem). */
const readSource = (source: SelectedFile): Effect.Effect<File, FsError | Error, FileSystem> =>
  Effect.gen(function* () {
    if (source.file) return source.file;
    if (source.path) {
      const fs = yield* FileSystem;
      // Open from absolute filesystem path. `'None'` keeps the path as-is.
      return yield* fs.openFile(source.path, 'None');
    }
    return yield* Effect.fail(new Error('SelectedFile has neither path nor file'));
  });

const writeBundleFile = (
  bundleDir: string,
  filename: string,
  source: File,
): Effect.Effect<void, FsError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.writeFile(`${bundleDir}/${filename}`, 'Dictionaries', source);
  });

/** Build a fresh bundle directory `'Dictionaries'/<id>/`. */
const createBundleDir = (): Effect.Effect<string, FsError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const id = uniqueId();
    yield* fs.createDir(id, 'Dictionaries', true);
    return id;
  });
```

(`isGzip` stays an `async function` — it only reads the `File`, no fs.)

- [ ] **Step 4: Convert `importStarDictBundle`**

Replace the whole `importStarDictBundle` function with:

```ts
const importStarDictBundle = (
  group: StarDictGroup,
): Effect.Effect<ImportedDictionary, FsError | Error, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const bundleDir = yield* createBundleDir();
    const ifoFile = yield* readSource(group.ifo.source);
    const idxFile = yield* readSource(group.idx.source);
    const dictFile = yield* readSource(group.dict.source);
    const synFile = group.syn ? yield* readSource(group.syn.source) : undefined;

    yield* writeBundleFile(bundleDir, group.ifo.name, ifoFile);
    yield* writeBundleFile(bundleDir, group.idx.name, idxFile);
    yield* writeBundleFile(bundleDir, group.dict.name, dictFile);
    if (synFile && group.syn) {
      yield* writeBundleFile(bundleDir, group.syn.name, synFile);
    }

    // Pre-compute offsets sidecars at import time. Subsequent provider inits
    // skip the full `.idx` (and `.syn`) scan — the only reads are the small
    // sidecar plus per-lookup probes. Net effect on cmudict-class bundles:
    // ~62% init IO reduction.
    const idxOffsetsName = `${group.idx.stem}.idx.offsets`;
    {
      const idxBytes = new Uint8Array(yield* Effect.tryPromise(() => idxFile.arrayBuffer()));
      const offsets = scanEntryOffsets(idxBytes, /* payloadBytes */ 8);
      const sidecar = serializeOffsetsSidecar(offsets);
      // Wrap as a File so writeFile's `string | ArrayBuffer | File` signature
      // accepts it without an unsafe ArrayBuffer cast (Uint8Array.buffer is
      // typed `ArrayBufferLike` in TS strict mode).
      const sidecarFile = new File([new Uint8Array(sidecar)], idxOffsetsName);
      yield* fs.writeFile(`${bundleDir}/${idxOffsetsName}`, 'Dictionaries', sidecarFile);
    }
    let synOffsetsName: string | undefined;
    if (synFile && group.syn) {
      synOffsetsName = `${group.syn.stem}.syn.offsets`;
      const synBytes = new Uint8Array(yield* Effect.tryPromise(() => synFile.arrayBuffer()));
      const offsets = scanEntryOffsets(synBytes, /* payloadBytes */ 4);
      const sidecar = serializeOffsetsSidecar(offsets);
      const sidecarFile = new File([new Uint8Array(sidecar)], synOffsetsName);
      yield* fs.writeFile(`${bundleDir}/${synOffsetsName}`, 'Dictionaries', sidecarFile);
    }

    const ifoText = yield* Effect.tryPromise(() => ifoFile.text());
    const ifo = parseIfo(ifoText);
    const name = ifo['bookname'] || group.stem;
    const lang = ifo['lang'] || ifo['idxoffsetlang'] || undefined;

    // v1 scope: only DictZip-compressed `.dict.dz` and single-type sametypesequence ∈ {m, h, x, t}.
    // Bundles outside this surface as `unsupported` so the popup hides them
    // and the settings UI shows a clear reason; the import itself still succeeds.
    let unsupported = false;
    let unsupportedReason: string | undefined;
    if (!(yield* Effect.tryPromise(() => isGzip(dictFile)))) {
      unsupported = true;
      unsupportedReason = 'Raw .dict files are not supported in v1; please use .dict.dz format.';
    } else {
      const seq = ifo['sametypesequence'];
      if (!seq || seq.length !== 1) {
        unsupported = true;
        unsupportedReason = seq
          ? `Multi-type sametypesequence "${seq}" is not supported in v1.`
          : 'StarDict bundles without sametypesequence are not supported in v1.';
      } else if (!'mhxt'.includes(seq)) {
        unsupported = true;
        unsupportedReason = `StarDict entry type "${seq}" is not supported in v1.`;
      }
    }

    // Stardict primary = .ifo (small text; partialMd5 is effectively full-hash).
    const stardictFilenames = [group.ifo.name, group.idx.name, group.dict.name];
    if (group.syn?.name) stardictFilenames.push(group.syn.name);
    const contentId = yield* Effect.tryPromise(() =>
      computeDictionaryContentId(ifoFile, stardictFilenames),
    );

    return {
      id: contentId,
      contentId,
      kind: 'stardict',
      name,
      bundleDir,
      files: {
        ifo: group.ifo.name,
        idx: group.idx.name,
        dict: group.dict.name,
        syn: group.syn?.name,
        idxOffsets: idxOffsetsName,
        synOffsets: synOffsetsName,
      },
      lang,
      addedAt: Date.now(),
      unsupported: unsupported || undefined,
      unsupportedReason,
    };
  });
```

- [ ] **Step 5: Convert `importMdictBundle`**

Replace the whole function with:

```ts
const importMdictBundle = (
  group: MDictGroup,
): Effect.Effect<ImportedDictionary, FsError | Error, FileSystem> =>
  Effect.gen(function* () {
    const bundleDir = yield* createBundleDir();
    const mdxFile = yield* readSource(group.mdx.source);
    const mddFiles = yield* Effect.all(group.mdd.map((m) => readSource(m.source)));
    const cssFiles = yield* Effect.all(group.css.map((c) => readSource(c.source)));

    yield* writeBundleFile(bundleDir, group.mdx.name, mdxFile);
    for (let i = 0; i < group.mdd.length; i++) {
      yield* writeBundleFile(bundleDir, group.mdd[i]!.name, mddFiles[i]!);
    }
    for (let i = 0; i < group.css.length; i++) {
      yield* writeBundleFile(bundleDir, group.css[i]!.name, cssFiles[i]!);
    }

    // Parse the MDX header via the forked js-mdict (browser-friendly path).
    // Loaded lazily so users without MDict imports never pull in the parser.
    let name = group.stem;
    let lang: string | undefined;
    let unsupported = false;
    let unsupportedReason: string | undefined;
    const parsed = yield* Effect.tryPromise(async () => {
      const { MDX } = await import('js-mdict');
      const mdx = await MDX.create(mdxFile);
      return mdx;
    }).pipe(Effect.either);
    if (parsed._tag === 'Right') {
      const mdx = parsed.right;
      const header = mdx.header as Record<string, unknown>;
      if (typeof header['Title'] === 'string' && (header['Title'] as string).trim()) {
        name = (header['Title'] as string).trim();
      }
      if (typeof header['Encoding'] === 'string') {
        lang = (header['Encoding'] as string).toLowerCase();
      }
      // `meta.encrypt` is a bitmap: 0x01 = record block encrypted (needs a
      // user-supplied passcode/regcode — js-mdict doesn't implement that path),
      // 0x02 = key info block encrypted (handled transparently via the
      // ripemd128-based `mdxDecrypt`, no passcode needed). Only bit 0 is
      // genuinely unsupported.
      if ((mdx.meta.encrypt & 1) !== 0) {
        unsupported = true;
        unsupportedReason =
          'This MDX is registered to a specific user (record-block encryption); passcode-protected dictionaries are not supported.';
      }
    } else {
      const err = parsed.left;
      const message = (err as Error).message ?? String(err);
      unsupported = true;
      if (/encrypted file|user identification/i.test(message)) {
        unsupportedReason =
          'This MDX is registered to a specific user (record-block encryption); passcode-protected dictionaries are not supported.';
      } else {
        unsupportedReason = `Failed to parse MDX header: ${message}`;
      }
    }

    // MDict primary = .mdx (the body file).
    const mdictFilenames = [
      group.mdx.name,
      ...group.mdd.map((m) => m.name),
      ...group.css.map((c) => c.name),
    ];
    const contentId = yield* Effect.tryPromise(() =>
      computeDictionaryContentId(mdxFile, mdictFilenames),
    );

    return {
      id: contentId,
      contentId,
      kind: 'mdict',
      name,
      bundleDir,
      files: {
        mdx: group.mdx.name,
        mdd: group.mdd.map((m) => m.name),
        css: group.css.length ? group.css.map((c) => c.name) : undefined,
      },
      lang,
      addedAt: Date.now(),
      unsupported: unsupported || undefined,
      unsupportedReason,
    };
  });
```

Note: the legacy `try/catch` around MDX parsing (best-effort; failure →
`unsupported`) is preserved as `Effect.either` over the parse, then a
`Right`/`Left` branch — semantically identical (parse failure does NOT fail the
import).

- [ ] **Step 6: Convert `importDictBundle`**

Replace the whole function with:

```ts
const importDictBundle = (
  group: DictGroup,
): Effect.Effect<ImportedDictionary, FsError | Error, FileSystem> =>
  Effect.gen(function* () {
    const bundleDir = yield* createBundleDir();
    const indexFile = yield* readSource(group.index.source);
    const dictFile = yield* readSource(group.dict.source);
    yield* writeBundleFile(bundleDir, group.index.name, indexFile);
    yield* writeBundleFile(bundleDir, group.dict.name, dictFile);

    // Try to read the `00databaseshort` body for a friendly bundle name. The
    // index lists it; the body lives in the dict. We do this best-effort: any
    // failure falls back to the stem.
    let name = group.stem;
    let unsupported = false;
    let unsupportedReason: string | undefined;
    const friendlyName = yield* Effect.tryPromise(async () => {
      const indexText = await indexFile.text();
      // Find the "00databaseshort\t<offset>\t<size>" line.
      const m = indexText.match(/^00databaseshort\t([^\t]+)\t([^\t\r\n]+)/m);
      if (!m) return undefined;
      const decode = (s: string): number => {
        let n = 0;
        const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        for (const ch of s) {
          const v = A.indexOf(ch);
          if (v < 0) throw new Error('bad b64');
          n = n * 64 + v;
        }
        return n;
      };
      const off = decode(m[1]!);
      const size = decode(m[2]!);
      // Read the dict body. If gzipped we need the whole thing — but for
      // the friendly-name read, that's still cheap (the freedict bundles
      // are <300 KB compressed).
      const buf = await dictFile.arrayBuffer();
      const u8 = new Uint8Array(buf);
      let body: Uint8Array;
      if (u8[0] === 0x1f && u8[1] === 0x8b) {
        const { gunzipSync } = await import('fflate');
        body = gunzipSync(u8);
      } else {
        body = u8;
      }
      return new TextDecoder('utf-8').decode(body.subarray(off, off + size)).trim() || group.stem;
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (friendlyName) name = friendlyName;

    if (!(yield* Effect.tryPromise(() => isGzip(dictFile)))) {
      // Plain `.dict` is technically supported by the reader, but we keep
      // v1 scope identical to StarDict for consistency.
      unsupported = true;
      unsupportedReason = 'Raw .dict files are not supported in v1; please use .dict.dz format.';
    }

    // DICT primary = .dict (or .dict.dz) — the gzipped body file.
    const dictFilenames = [group.dict.name, group.index.name];
    const contentId = yield* Effect.tryPromise(() =>
      computeDictionaryContentId(dictFile, dictFilenames),
    );

    return {
      id: contentId,
      contentId,
      kind: 'dict',
      name,
      bundleDir,
      files: {
        index: group.index.name,
        dict: group.dict.name,
      },
      addedAt: Date.now(),
      unsupported: unsupported || undefined,
      unsupportedReason,
    };
  });
```

Note: the legacy best-effort `try { … } catch { /* fall back to stem */ }` for
the friendly name becomes `Effect.tryPromise(async () => …).pipe(Effect.orElseSucceed(() => undefined))`
— failure yields `undefined`, name stays `group.stem`. Identical behavior.

- [ ] **Step 7: Convert `importSlobBundle`**

Replace the whole function with:

```ts
const importSlobBundle = (
  group: SlobGroup,
): Effect.Effect<ImportedDictionary, FsError | Error, FileSystem> =>
  Effect.gen(function* () {
    const bundleDir = yield* createBundleDir();
    const slobFile = yield* readSource(group.slob.source);
    yield* writeBundleFile(bundleDir, group.slob.name, slobFile);

    // Read header bytes to derive the friendly name + sanity-check compression.
    let name = group.stem;
    let unsupported = false;
    let unsupportedReason: string | undefined;
    const parsed = yield* Effect.tryPromise(async () => {
      const { SlobReader } = await import('@/services/dictionaries/slobReader');
      const reader = new SlobReader();
      await reader.load({ slob: slobFile });
      return reader;
    }).pipe(Effect.either);
    if (parsed._tag === 'Right') {
      const reader = parsed.right;
      const labelTag = reader.header.tags['label'];
      if (labelTag) name = labelTag.replace(/\0+$/u, '') || group.stem;
    } else {
      const err = parsed.left;
      const message = (err as Error).message ?? String(err);
      unsupported = true;
      if (/Unsupported Slob compression/i.test(message)) {
        unsupportedReason = message;
      } else if (/Unsupported Slob encoding/i.test(message)) {
        unsupportedReason = message;
      } else {
        unsupportedReason = `Failed to parse Slob header: ${message}`;
      }
    }

    // Slob primary = .slob (single-file bundle).
    const contentId = yield* Effect.tryPromise(() =>
      computeDictionaryContentId(slobFile, [group.slob.name]),
    );

    return {
      id: contentId,
      contentId,
      kind: 'slob',
      name,
      bundleDir,
      files: { slob: group.slob.name },
      addedAt: Date.now(),
      unsupported: unsupported || undefined,
      unsupportedReason,
    };
  });
```

(Confirm the return-object shape matches the original `importSlobBundle` return
lines — `kind: 'slob'`, `files: { slob: group.slob.name }`, `addedAt`,
`unsupported`, `unsupportedReason`. Copy any field the original had that is not
shown here verbatim.)

- [ ] **Step 8: Convert `importDictionaries` (top-level)**

Replace the `export async function importDictionaries(...)` with:

```ts
export const importDictionaries = (
  files: SelectedFile[],
  existingDictionaries: ImportedDictionary[] = [],
): Effect.Effect<ImportDictionariesResult, AssetError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const { bundles, orphans } = groupBundlesByStem(files);
    // Track all existing entries; findExistingDictionaryMatches handles the
    // contentId-vs-name tier logic. Re-importing a renamed dict still matches
    // because contentId is stable per file content.
    const existing: ImportedDictionary[] = [...existingDictionaries];

    const imported: ImportedDictionary[] = [];
    const replacements: { oldIds: string[]; newDict: ImportedDictionary }[] = [];
    const seenContentIds = new Set<string>();
    const seenLegacyNames = new Set<string>();

    for (const bundle of bundles) {
      let dict: ImportedDictionary;
      if (bundle.kind === 'stardict') {
        dict = yield* importStarDictBundle(bundle);
      } else if (bundle.kind === 'mdict') {
        dict = yield* importMdictBundle(bundle);
      } else if (bundle.kind === 'dict') {
        dict = yield* importDictBundle(bundle);
      } else {
        dict = yield* importSlobBundle(bundle);
      }

      const isIntraCallDup = dict.contentId
        ? seenContentIds.has(dict.contentId)
        : seenLegacyNames.has(dict.name);
      if (isIntraCallDup) {
        yield* fs
          .removeDir(dict.bundleDir, 'Dictionaries', true)
          .pipe(
            Effect.catchAll((err) =>
              Effect.sync(() =>
                console.warn('Failed to clean up duplicate bundle dir', dict.bundleDir, err),
              ),
            ),
          );
        continue;
      }
      if (dict.contentId) seenContentIds.add(dict.contentId);
      else seenLegacyNames.add(dict.name);

      const olds = findExistingDictionaryMatches(dict, existing);
      if (olds.length > 0) {
        for (const old of olds) {
          yield* fs
            .removeDir(old.bundleDir, 'Dictionaries', true)
            .pipe(
              Effect.catchAll((err) =>
                Effect.sync(() =>
                  console.warn('Failed to remove replaced bundle dir', old.bundleDir, err),
                ),
              ),
            );
        }
        // Drop matched entries from `existing` so subsequent bundles in this
        // call don't double-replace them.
        const oldIdSet = new Set(olds.map((o) => o.id));
        for (let i = existing.length - 1; i >= 0; i--) {
          if (oldIdSet.has(existing[i]!.id)) existing.splice(i, 1);
        }
        // Preserve durable live-entry state across re-import while keeping
        // parsed/file-backed fields from the fresh bundle.
        const preserved = preserveLiveDictionaryState(dict, olds);
        const newDict = shouldMintReincarnationForLiveReimport(dict, olds)
          ? { ...preserved, reincarnation: uuidv4() }
          : preserved;
        replacements.push({ oldIds: olds.map((o) => o.id), newDict });
        continue;
      }

      // No live match — but check for a tombstoned (soft-deleted) entry
      // with the same contentId. If found, this is a reincarnation: mint
      // a fresh token so the server-side row surfaces as alive again on
      // every device that pulls.
      const tombstoned = findTombstonedDictionaryMatches(dict, existing);
      if (tombstoned.length > 0) {
        const tombstonedIdSet = new Set(tombstoned.map((o) => o.id));
        for (let i = existing.length - 1; i >= 0; i--) {
          if (tombstonedIdSet.has(existing[i]!.id)) existing.splice(i, 1);
        }
        const reincarnatedDict = preserveUserCustomName(
          { ...dict, reincarnation: uuidv4() },
          tombstoned,
        );
        replacements.push({ oldIds: tombstoned.map((o) => o.id), newDict: reincarnatedDict });
        continue;
      }

      imported.push(dict);
    }

    return {
      imported,
      replacements,
      orphanFiles: orphans.map((o) => o.name),
    };
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'importDictionaries', cause })));
```

(Note: dropped the dead `intraCallKey`/`void intraCallKey` lines from legacy —
they were computed and discarded.)

- [ ] **Step 9: Convert `deleteDictionary`**

Replace the `export async function deleteDictionary(...)` with:

```ts
/** Remove a dictionary's bundle directory. The metadata is dropped by the caller. */
export const deleteDictionary = (
  dict: ImportedDictionary,
): Effect.Effect<void, AssetError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (yield* fs.exists(dict.bundleDir, 'Dictionaries')) {
      yield* fs.removeDir(dict.bundleDir, 'Dictionaries', true);
    }
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'deleteDictionary', cause })));
```

- [ ] **Step 10: Rewrite the layer (keep lazy import for code-split)**

Replace `src/infra/shared/DictionaryService.layer.ts` entirely:

```ts
import { Effect, Layer } from 'effect';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import {
  DictionaryService,
  type DictionaryServiceShape,
} from '@/application/services/DictionaryService';

const loadModule = () => import('@/application/services/dictionaries/dictionaryService');

export const DictionaryServiceLive = Layer.effect(
  DictionaryService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    return {
      importDictionaries: (files, existingDictionaries = []) =>
        Effect.tryPromise({
          try: loadModule,
          catch: (cause) => new AssetError({ operation: 'importDictionaries', cause }),
        }).pipe(
          Effect.flatMap((m) => m.importDictionaries(files, existingDictionaries)),
          Effect.provideService(FileSystem, fsPort),
        ),
      deleteDictionary: (dict) =>
        Effect.tryPromise({
          try: loadModule,
          catch: (cause) => new AssetError({ operation: 'deleteDictionary', cause }),
        }).pipe(
          Effect.flatMap((m) => m.deleteDictionary(dict)),
          Effect.provideService(FileSystem, fsPort),
        ),
    } satisfies DictionaryServiceShape;
  }),
);
```

(The module is loaded lazily via `import()` so the heavy readers stay in a
split chunk; `FileSystem` is provided into the returned effect. Both the
chunk-load failure and the function's internal `AssetError` resolve to
`AssetError`.)

- [ ] **Step 11: Run the guard test (must stay green)**

Run: `pnpm vitest run src/__tests__/application/dictionaryService.test.ts`
Expected: PASS — 4 tests (importDictionaries with no files → empty result;
deleteDictionary removes bundle dir when it exists; skips removeDir when absent;
maps `exists` failure to `AssetError` with `operation === 'deleteDictionary'`).

- [ ] **Step 12: tsgo + biome**

Run: `pnpm lint`
Expected: 0 new errors. Watch for: unused imports left in the moved file, the
`FileSystem` import being value (not `type`) since it is `yield*`-ed, and the
bundle-importer return-object shapes type-checking against `ImportedDictionary`.

- [ ] **Step 13: Verify code-split is intact**

Run: `grep -rn "application/services/dictionaries/dictionaryService" src --include=*.ts --include=*.tsx`
Expected: exactly one hit — the `loadModule`/`import()` in
`DictionaryService.layer.ts`. No **static** `import … from '…/dictionaries/dictionaryService'`
anywhere (that would pull the heavy chunk into the main bundle).

- [ ] **Step 14: Commit**

```bash
git add src/application/services/dictionaries/dictionaryService.ts src/infra/shared/DictionaryService.layer.ts
git commit -m "refactor(effect): DictionaryService de-adapter — Effect-native import/delete, keep lazy code-split (E6b)"
```

---

## Task 4: Whole-slice verification

**Files:** none (verification only).

- [ ] **Step 1: Adapter-consumer gate**

Run: `grep -rl makeLegacyFsAdapter src --include=*.ts`
Expected: 6 files — `fsPortAdapter.ts` (def), `BookRepository.layer.ts`,
`LibraryRepository.layer.ts`, `CoverService.layer.ts`, `CloudService.layer.ts`,
`usecases/book/exportBook.ts`, `usecases/book/importBooks.ts`. **NOT**
`FontService.layer.ts` / `ImageService.layer.ts` / `DictionaryService.layer.ts`.
(Count was 10 files incl. the 3 now-removed; the 2 usecases bring the non-def
total to 6.)

- [ ] **Step 2: No stale legacy-FileSystem imports in the new modules**

Run: `grep -rn "@/domain/system" src/application/services/fonts src/application/services/images src/application/services/dictionaries`
Expected: empty (the new modules use `@/application/ports/FileSystem`, not the
legacy `@/domain/system` `FileSystem`). `@/domain/*` _type_ imports for
`CustomFont`, `CustomTextureInfo`, `ImportedDictionary`, etc. are fine — but
those come from `@/domain/{fonts,textures,dictionaries,file-selector}`, not
`@/domain/system`.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: green except the known pre-existing env/timer-flaky set (auth-page,
useBookShortcuts, theme-store import-time env; ProgressBar/ReadingRuler timers;
clientRuntime/edgeTTS/opds-req sandbox; hardcover). Confirm the migrated E3
consumer tests (CustomFonts, DialogMenu, ColorPanel, CustomDictionaries) pass.

- [ ] **Step 4: Full lint**

Run: `pnpm lint`
Expected: only the pre-existing `scripts/upload-cjk-fonts-r2.ts` (tsgo) and
`SettingsDialog.tsx` (biome) baselines.

- [ ] **Step 5: Request whole-slice review**

Use superpowers:requesting-code-review. Reviewer should check: fidelity of each
converted function vs the pre-move git history (`git show HEAD~N:src/services/dictionaries/dictionaryService.ts`),
the best-effort-swallow `catchAll` placements, the `Effect.either`/`orElseSucceed`
best-effort branches in the dict bundle importers, code-split preservation, and
that no behavior or error-operation label changed.

---

## Self-Review Notes

- **Spec coverage:** Font (Task 1), Image (Task 2), Dict + code-split (Task 3),
  layers trivialized (Tasks 1/2/3 step 3/10), content-id helpers kept (Tasks 1/2
  step 2), `makeLegacyFsAdapter` gate (Task 4 step 1), fsPortAdapter/domain
  untouched (no task modifies them). All spec sections covered.
- **Type consistency:** `importFont`/`deleteFont`/`importImage`/`deleteImage`/
  `importDictionaries`/`deleteDictionary` names and signatures match the
  `*Shape` interfaces unchanged. Internal dict Effect channel is
  `FsError | Error` (or `UnknownException` from `Effect.tryPromise`), collapsed
  to `AssetError` at each exported boundary.
- **Operation labels** preserved exactly: `'importFont'`, `'deleteFont'`,
  `'importImage'`, `'deleteImage'`, `'importDictionaries'`, `'deleteDictionary'`.

```

```
