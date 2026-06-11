# Effect Foundation — Plan C: Tauri + Web Infra + Client Runtimes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the `infra/tauri/*` and `infra/web/*` layers (Platform, PathResolver, FileSystem, Dialog, Database) by **faithfully porting** the existing `nativeAppService`/`webAppService` I/O logic into the Plan B port shapes, and compose them into `runtime/client-tauri.ts` and `runtime/client-web.ts`.

**Architecture:** Each port gets a `Layer` per platform. `PathResolver` reads `PathState` (no more mutable `fs.resolvePath`). `FileSystem` does pure I/O. Logic is **ported verbatim** from the existing services (decision #5: preserve all edge-cases, same backing stores — Tauri plugin-fs + Rust `read_dir`; Web IndexedDB). Errors map to the Plan B tagged errors at the infra boundary via `Effect.tryPromise`. No consumer migration — the old `AppService` stays the live boot path.

**Tech Stack:** effect@3.21.2, `@tauri-apps/{api,plugin-fs,plugin-os,plugin-dialog}`, IndexedDB, Vitest (jsdom config + `vi.mock('@tauri-apps/*')`). Path alias `@/* → src/*`.

**Prereqs:** Plans A + B complete. Ports live in `@/application/ports/*`; errors in `@/application/errors/AppError`; `PathStateLive` exists; `runtime/test.ts` exists.

**Source of truth for faithful ports (read these while porting):**

- `src/services/nativeAppService.ts` — `getPathResolver()` (83–195), `nativeFileSystem` (197–419), platform booleans (423–461), dialog (544–616), `openDatabase` (622–635)
- `src/services/webAppService.ts` — `resolvePath` (19–36), `indexedDBFileSystem` (57–285), platform (289), dialog (326–394), `openDatabase` (400–417)
- `src/services/constants.ts` — `DATA_SUBDIR`, `LOCAL_BOOKS_SUBDIR`, `LOCAL_FONTS_SUBDIR`, `LOCAL_IMAGES_SUBDIR`, `LOCAL_DICTIONARIES_SUBDIR`, `SETTINGS_FILENAME`

**Conventions:** `Layer.effect(Port, Effect.gen(...))`; infra MAY import `@tauri-apps/*`, `@/domain/*`, `@/application/*`, `effect`, and existing `@/services/*` helpers it ports from — but NOT `@/app|components|store|hooks`. Map every thrown platform error to a tagged `FsError`/`PlatformError`/`DatabaseError` via `Effect.tryPromise({ try, catch })`.

---

## File structure (created by this plan)

```
src/infra/
  tauri/
    TauriPlatform.layer.ts
    TauriPathResolver.layer.ts
    TauriFileSystem.layer.ts
    TauriDialog.layer.ts
    TauriDatabase.layer.ts
  web/
    WebPlatform.layer.ts
    WebPathResolver.layer.ts
    WebFileSystem.layer.ts
    WebDialog.layer.ts
    WebDatabase.layer.ts
src/runtime/
  client-tauri.ts
  client-web.ts
src/__tests__/infra/
  tauriPathResolver.test.ts     # §19.3 gate: custom-root / portable / default
  webPathResolver.test.ts
  tauriPlatform.test.ts
  tauriFileSystem.test.ts        # CRUD via mocked plugin-fs
```

---

## Phase 1 — PathResolver (the centerpiece; §19.3 gate)

### Task 1: TauriPathResolver layer + tests

**Files:** Create `src/infra/tauri/TauriPathResolver.layer.ts`; Test `src/__tests__/infra/tauriPathResolver.test.ts`

The resolver reads `PathState` and reproduces `getPathResolver()` (nativeAppService.ts:83–195) + `getPrefix()` (200–205). Categories that nest under the custom root WITHOUT a leaf subdir name: `Settings, Data, Books, Fonts, Images, Dictionaries` (the `dataDirs` list). Subdir constants come from `@/services/constants`.

- [ ] **Step 1: Write the failing test** (the three §19.3 modes; mock the tauri path APIs)

```ts
// src/__tests__/infra/tauriPathResolver.test.ts
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('/appdata'),
  appConfigDir: vi.fn().mockResolvedValue('/appconfig'),
  appCacheDir: vi.fn().mockResolvedValue('/appcache'),
  appLogDir: vi.fn().mockResolvedValue('/applog'),
  tempDir: vi.fn().mockResolvedValue('/tmp'),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 8, AppConfig: 10, AppCache: 11, AppLog: 12, Temp: 1 },
}));

const load = async () => {
  const { TauriPathResolverLive } = await import('@/infra/tauri/TauriPathResolver.layer');
  const { PathResolver } = await import('@/application/ports/PathResolver');
  const { PathState, PathStateLive } = await import('@/application/ports/PathState');
  const layer = Layer.provideMerge(TauriPathResolverLive, PathStateLive);
  const run = <A>(p: Effect.Effect<A, unknown, never>) => Effect.runPromise(p);
  return { PathResolver, PathState, layer, run };
};

describe('TauriPathResolver', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('default (no custom root): Books absolute = appDataDir + Books subdir + path', async () => {
    const { PathResolver, layer, run } = await load();
    const abs = await run(
      Effect.flatMap(PathResolver, (r) => r.absolute('b.epub', 'Books')).pipe(
        Effect.provide(layer),
      ),
    );
    // LOCAL_BOOKS_SUBDIR is 'Books' by repo convention — assert the resolved shape:
    expect(abs.startsWith('/appdata/')).toBe(true);
    expect(abs.endsWith('/b.epub')).toBe(true);
  });

  it('custom root: Books path nests directly under customRootDir/Books', async () => {
    const { PathResolver, PathState, layer, run } = await load();
    const abs = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.set({ customRootDir: '/custom', isPortable: false });
        const r = yield* PathResolver;
        return yield* r.absolute('b.epub', 'Books');
      }).pipe(Effect.provide(layer)),
    );
    expect(abs).toBe('/custom/Books/b.epub');
  });

  it('portable: Settings resolves under execDir', async () => {
    const { PathResolver, PathState, layer, run } = await load();
    const abs = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.set({ isPortable: true, execDir: '/exec' });
        const r = yield* PathResolver;
        return yield* r.absolute('settings.json', 'Settings');
      }).pipe(Effect.provide(layer)),
    );
    expect(abs).toBe('/exec/settings.json');
  });

  it('resolve returns ResolvedPath with baseDir=0 under custom root', async () => {
    const { PathResolver, PathState, layer, run } = await load();
    const resolved = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.set({ customRootDir: '/custom', isPortable: false });
        const r = yield* PathResolver;
        return yield* r.resolve('x.json', 'Data');
      }).pipe(Effect.provide(layer)),
    );
    expect(resolved.baseDir).toBe(0);
    expect(resolved.base).toBe('Data');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm exec vitest run src/__tests__/infra/tauriPathResolver.test.ts`).

- [ ] **Step 3: Implement** — port `getPathResolver` into a `PathState`-reading layer. READ `nativeAppService.ts:83–205` and `@/services/constants` for the exact subdir constants. Use the spec §11.1 sketch as the base; the structure:

```ts
// src/infra/tauri/TauriPathResolver.layer.ts
import { Effect, Layer } from 'effect';
import { BaseDirectory } from '@tauri-apps/plugin-fs';
import {
  appCacheDir,
  appConfigDir,
  appDataDir,
  appLogDir,
  join,
  tempDir,
} from '@tauri-apps/api/path';
import type { BaseDir, ResolvedPath } from '@/domain/system';
import { FsError } from '@/application/errors/AppError';
import { PathResolver, type PathResolverShape } from '@/application/ports/PathResolver';
import { PathState } from '@/application/ports/PathState';
import {
  DATA_SUBDIR,
  LOCAL_BOOKS_SUBDIR,
  LOCAL_DICTIONARIES_SUBDIR,
  LOCAL_FONTS_SUBDIR,
  LOCAL_IMAGES_SUBDIR,
} from '@/services/constants';

const NESTED_DIRS: BaseDir[] = ['Settings', 'Data', 'Books', 'Fonts', 'Images', 'Dictionaries'];

export const TauriPathResolverLive = Layer.effect(
  PathResolver,
  Effect.gen(function* () {
    const state = yield* PathState;

    // Pure synchronous resolver (mirrors getPathResolver), parameterised by current PathConfig.
    const buildResolved = (
      path: string,
      base: BaseDir,
      cfg: { customRootDir?: string; isPortable: boolean; execDir?: string },
    ): ResolvedPath => {
      const { customRootDir, isPortable, execDir } = cfg;
      const customBaseDir = customRootDir ? 0 : undefined;
      const customPrefix = (b: BaseDir): string | undefined => {
        if (!customRootDir) return undefined;
        const leaf = NESTED_DIRS.includes(b) ? '' : b;
        return leaf ? `${customRootDir}/${leaf}` : customRootDir;
      };
      const sub = (subdir: string, prefix?: string) =>
        prefix
          ? `${prefix}/${subdir}${path ? `/${path}` : ''}`
          : `${subdir}${path ? `/${path}` : ''}`;

      switch (base) {
        case 'Settings':
          return {
            baseDir: isPortable ? 0 : BaseDirectory.AppConfig,
            basePrefix: isPortable && execDir ? async () => execDir : appConfigDir,
            fp: isPortable && execDir ? `${execDir}${path ? `/${path}` : ''}` : path,
            base,
          };
        case 'Cache':
          return { baseDir: BaseDirectory.AppCache, basePrefix: appCacheDir, fp: path, base };
        case 'Log': {
          const prefix = customPrefix(base);
          return {
            baseDir: customBaseDir ?? BaseDirectory.AppLog,
            basePrefix: prefix ? async () => prefix : appLogDir,
            fp: prefix ? `${prefix}${path ? `/${path}` : ''}` : path,
            base,
          };
        }
        case 'Data': {
          const prefix = customPrefix(base);
          return {
            baseDir: customBaseDir ?? BaseDirectory.AppData,
            basePrefix: prefix ? async () => prefix : appDataDir,
            fp: sub(DATA_SUBDIR, prefix),
            base,
          };
        }
        case 'Books': {
          const prefix = customPrefix(base);
          return {
            baseDir: customBaseDir ?? BaseDirectory.AppData,
            basePrefix: prefix ? async () => prefix : appDataDir,
            fp: sub(LOCAL_BOOKS_SUBDIR, prefix),
            base,
          };
        }
        case 'Fonts': {
          const prefix = customPrefix(base);
          return {
            baseDir: customBaseDir ?? BaseDirectory.AppData,
            basePrefix: prefix ? async () => prefix : appDataDir,
            fp: sub(LOCAL_FONTS_SUBDIR, prefix),
            base,
          };
        }
        case 'Images': {
          const prefix = customPrefix(base);
          return {
            baseDir: customBaseDir ?? BaseDirectory.AppData,
            basePrefix: prefix ? async () => prefix : appDataDir,
            fp: sub(LOCAL_IMAGES_SUBDIR, prefix),
            base,
          };
        }
        case 'Dictionaries': {
          const prefix = customPrefix(base);
          return {
            baseDir: customBaseDir ?? BaseDirectory.AppData,
            basePrefix: prefix ? async () => prefix : appDataDir,
            fp: sub(LOCAL_DICTIONARIES_SUBDIR, prefix),
            base,
          };
        }
        case 'None':
          return { baseDir: 0, basePrefix: async () => '', fp: path, base };
        default: // 'Temp'
          return { baseDir: BaseDirectory.Temp, basePrefix: tempDir, fp: path, base };
      }
    };

    const resolve = (path: string, base: BaseDir) =>
      state.get.pipe(Effect.map((cfg) => buildResolved(path, base, cfg)));

    const prefix = (base: BaseDir) =>
      resolve('', base).pipe(
        Effect.flatMap((r) =>
          Effect.tryPromise({
            try: async () => {
              const basePath = (await r.basePrefix()).replace(/\/+$/, '');
              if (!r.fp) return basePath;
              return r.baseDir === 0 ? r.fp : await join(basePath, r.fp);
            },
            catch: (cause) => new FsError({ operation: 'prefix', path: base, cause }),
          }),
        ),
      );

    const absolute = (path: string, base: BaseDir) =>
      prefix(base).pipe(
        Effect.flatMap((p) =>
          path
            ? Effect.tryPromise({
                try: () => join(p, path),
                catch: (cause) => new FsError({ operation: 'absolute', path, cause }),
              })
            : Effect.succeed(p),
        ),
      );

    return { resolve, prefix, absolute } satisfies PathResolverShape;
  }),
);
```

> While implementing: confirm the real subdir constant VALUES in `@/services/constants` and the exact `dataDirs` membership in `nativeAppService.ts`. If `LOCAL_BOOKS_SUBDIR !== 'Books'` etc., the first test's assertions still hold (they check structure, not the literal subdir); the custom-root test asserts `/custom/Books/b.epub` because under a custom root the leaf dir IS the BaseDir name `Books` (per `customPrefix`), NOT the subdir constant — verify this matches `getPathResolver` and adjust the test's expected literal if the source differs.

- [ ] **Step 4: Run — expect PASS.** Fix the resolver until the three §19.3 modes pass. **Step 5: Commit** `git add src/infra/tauri/TauriPathResolver.layer.ts src/__tests__/infra/tauriPathResolver.test.ts && git commit -m "feat(infra): add TauriPathResolver layer (ports getPathResolver, §19.3 tested)"`

### Task 2: WebPathResolver layer + test

**Files:** Create `src/infra/web/WebPathResolver.layer.ts`; Test `src/__tests__/infra/webPathResolver.test.ts`

Port `webAppService.ts:19–36,59–64`: flat relative paths, `baseDir=0`, `basePrefix=async()=>''`, category subdir prefix.

- [ ] **Step 1: Write failing test** (Books → `${LOCAL_BOOKS_SUBDIR}/x.epub`, prefix empty/relative). Mirror the structure of the Tauri test but simpler (no mocks needed — pure string logic). Assert `absolute('x.epub','Books')` equals the subdir-prefixed relative path and `resolve(...).baseDir === 0`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `WebPathResolverLive = Layer.succeed(PathResolver, {...})` (no PathState dependency needed — web ignores custom root; mirror `webAppService` resolvePath exactly, reading subdir constants from `@/services/constants`).
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(infra): add WebPathResolver layer`.

---

## Phase 2 — Platform

### Task 3: TauriPlatform layer + test

**Files:** Create `src/infra/tauri/TauriPlatform.layer.ts`; Test `src/__tests__/infra/tauriPlatform.test.ts`

Port the ~30 boolean fields (nativeAppService.ts:423–461) into a `PlatformInfo` computed from `osType()` (`@tauri-apps/plugin-os`), `DIST_CHANNEL`, `clientEnv`, and window globals. `Platform.info` is `Effect.Effect<PlatformInfo>` (it may read async `osType`/region — wrap in `Effect.sync`/`Effect.promise` as the source dictates).

- [ ] **Step 1: Write failing test** — `vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'macos' }))` (+ mock whatever `getOSPlatform`/`DIST_CHANNEL` source needs); assert `info.appPlatform === 'tauri'`, `isMacOSApp === true`, `isMobile === false`, `hasTrafficLight === true`. Add a second case for `'ios'` asserting `isIOSApp`, `hasHaptics`, `hasSafeAreaInset`, `isMobile` true.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `TauriPlatformLive = Layer.succeed(Platform, { info: Effect.sync(() => computeInfo()) })` (or `Layer.effect` if the OS type/region read must be async). Port the boolean expressions verbatim from nativeAppService.ts:423–461. `storefrontRegionCode` may stay `null` (the async iOS update happens in the legacy init; for the port, default `null` and leave a `// TODO(plan-D): async region in BootApp` note).
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(infra): add TauriPlatform layer`.

### Task 4: WebPlatform layer

**Files:** Create `src/infra/web/WebPlatform.layer.ts`

Port `webAppService.ts:289` (UA-based `isMobile`, `appPlatform='web'`, `supportsCanvasContext2DFilter=!isSafariBrowser()`, `hasSafeAreaInset=isPWA()`, all else false). Mirror the legacy defaults for every `PlatformInfo` field.

- [ ] **Step 1: Implement** `WebPlatformLive = Layer.succeed(Platform, { info: Effect.sync(() => ({...})) })`. **Step 2: tsgo clean. Step 3: Commit** `feat(infra): add WebPlatform layer`. (No standalone test — covered by the client-web runtime smoke test in Task 9; tsgo is the gate.)

---

## Phase 3 — FileSystem (faithful port)

### Task 5: TauriFileSystem layer + CRUD test

**Files:** Create `src/infra/tauri/TauriFileSystem.layer.ts`; Test `src/__tests__/infra/tauriFileSystem.test.ts`

Port `nativeFileSystem` (nativeAppService.ts:197–419) method-by-method into `FileSystemShape`. Each method wraps its `@tauri-apps/plugin-fs` call in `Effect.tryPromise({ try, catch: (cause) => new FsError({ operation, path, cause }) })`. The `resolve(path, base)` it needs comes from the **`PathResolver` port** (inject it) — do NOT re-implement path logic here. `exists` returns `Effect.Effect<boolean>` (catch → `false`, matching the legacy try/catch).

**PRESERVE these edge-cases (do not simplify):**

- `openFile` (216–262): URL→RemoteFile; `content://`→copy-to-cache; `file://` iOS decode; Android external; per-platform RemoteFile-vs-NativeFile fallback.
- `copyFile` (263–292): `content://` via `copyURIToPath`; else plugin-fs `copyFile` with `fromPathBaseDir`/`toPathBaseDir`.
- `readDir` (336–403): absolute-path (`baseDir===0`) → Rust `invoke('read_dir', { path, recursive: true, extensions: ['*'] })`; else recursive JS walk.
- `writeFile` (300–320): string/ArrayBuffer/`File.stream()`; create parent dir first.

- [ ] **Step 1: Write failing CRUD test** — `vi.mock('@tauri-apps/plugin-fs', ...)` returning controllable `writeFile/readTextFile/readFile/copyFile/remove/mkdir/exists/stat` plus `BaseDirectory`; `vi.mock('@tauri-apps/api/path', ...)`; provide `TauriFileSystemLive` over `TauriPathResolverLive` over `PathStateLive`. Test: writeFile then readFile('text') returns content (assert the mocked plugin-fs `writeFile` was called with the resolved path/baseDir); removeFile calls `remove`; copyFile calls plugin-fs `copyFile`. (These assert correct delegation + path resolution, the realistic unit-test scope; deep platform behavior like `content://` is covered by `.tauri.test.ts` later, out of scope here.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — port each method; inject `PathResolver` + `Platform` (for the per-OS `openFile` branch) via `Effect.gen`. Map throws to `FsError`.
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(infra): add TauriFileSystem layer (ported, CRUD tested)`.

### Task 6: WebFileSystem layer

**Files:** Create `src/infra/web/WebFileSystem.layer.ts`

Port `indexedDBFileSystem` (webAppService.ts:57–285) — **same IndexedDB store** (`'AppFileSystem'` / `'files'` / keyPath `'path'`). Wrap IDB ops in `Effect.tryPromise` → `FsError`. Uses `WebPathResolver` for the key path.

- [ ] **Step 1: Implement** the full port (no unit test here — IndexedDB needs jsdom+fake-indexeddb or `.browser.test.ts`; defer real CRUD coverage to a `.browser.test.ts` follow-up, and rely on tsgo + the client-web smoke test). Add a `// NOTE: CRUD covered by Plan-B TestFileSystem contract; real IDB coverage via .browser.test.ts (follow-up)`.
- [ ] **Step 2: tsgo clean. Step 3: Commit** `feat(infra): add WebFileSystem layer (ported IndexedDB store)`.

---

## Phase 4 — Dialog + Database (faithful port, contracts wired)

### Task 7: TauriDialog + WebDialog layers

**Files:** Create `src/infra/tauri/TauriDialog.layer.ts`, `src/infra/web/WebDialog.layer.ts`

- **Tauri** (port 544–616): `ask`→plugin-dialog `ask`; `selectDirectory`→`open({directory:true})` returning `Option.fromNullable`; `selectFiles`→`open({multiple:true, filters})` (iOS path-decode); `saveFile`→sharekit share OR `save()` dialog, returning `Option<string>` (`None` on cancel) per the Plan B `DialogShape`. Map failures to `PlatformError`.
- **Web** (port 326–394): `ask`→`Effect.succeed(window.confirm(...))` or as source does; `selectDirectory`/`selectFiles`→`Effect.fail(new PlatformError(...))` (unsupported); `saveFile`→`navigator.share`/`<a download>` returning `Option`.

- [ ] **Step 1: Implement both.** **Step 2: tsgo clean.** **Step 3: Commit** `feat(infra): add Tauri + Web Dialog layers`. (Tested via runtime smoke + later usecases; tsgo gate here.)

### Task 8: TauriDatabase + WebDatabase layers

**Files:** Create `src/infra/tauri/TauriDatabase.layer.ts`, `src/infra/web/WebDatabase.layer.ts`

Port `openDatabase` (native 622–635 / web 400–417): resolve full path via `PathResolver.absolute`, dynamic-import the existing `NativeDatabaseService`/`WebDatabaseService`, run `migrate(db, getMigrations(schema))`. Return `Effect<DatabaseService, DatabaseError>`. **Reuse the existing DB service + migrate modules** — do not reimplement the driver.

- [ ] **Step 1: Implement both** (inject `PathResolver`). **Step 2: tsgo clean. Step 3: Commit** `feat(infra): add Tauri + Web Database layers`.

---

## Phase 5 — Client runtimes + composition smoke

### Task 9: client-tauri + client-web runtimes + smoke test

**Files:** Create `src/runtime/client-tauri.ts`, `src/runtime/client-web.ts`; Test `src/__tests__/infra/clientRuntime.test.ts`

```ts
// src/runtime/client-tauri.ts
import { Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { TauriPlatformLive } from '@/infra/tauri/TauriPlatform.layer';
import { TauriPathResolverLive } from '@/infra/tauri/TauriPathResolver.layer';
import { TauriFileSystemLive } from '@/infra/tauri/TauriFileSystem.layer';
import { TauriDialogLive } from '@/infra/tauri/TauriDialog.layer';
import { TauriDatabaseLive } from '@/infra/tauri/TauriDatabase.layer';

// PathState is shared by PathResolver, FileSystem, Database — build once, expose to all.
const Base = Layer.provideMerge(
  Layer.mergeAll(TauriPathResolverLive, TauriFileSystemLive, TauriDatabaseLive),
  PathStateLive,
);
export const TauriClientLayer = Layer.mergeAll(TauriPlatformLive, TauriDialogLive, Base);
export const tauriClientRuntime = ManagedRuntime.make(TauriClientLayer);
```

(`client-web.ts` is the analogous composition with the `Web*` layers. WebPathResolver has no PathState dep, but composing the same way is harmless and consistent.)

> Composition note: `TauriFileSystemLive`/`TauriDatabaseLive` depend on `PathResolver` (and FileSystem on `Platform`). Ensure the merge provides those: build `PathResolver` + `Platform` first, then provide them to `FileSystem`/`Database`. If `Layer.mergeAll` leaves an unmet requirement, switch to nested `Layer.provide(FileSystem, Layer.merge(PathResolver, Platform))`. tsgo will flag any unmet `R` channel on `ManagedRuntime.make` — resolve until the runtime's requirement is `never`.

- [ ] **Step 1: Write failing smoke test** — import `tauriClientRuntime`; with the `@tauri-apps/*` mocks, run a program that yields `Platform` + `PathResolver`, sets a custom root via `PathState`, and resolves a Books path; assert it composes (requirement `never`) and returns the expected absolute path. (Mirror the Plan B `testRuntime` smoke test.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** both runtimes; fix composition until tsgo shows the runtime requirement is `never` and the smoke test passes.
- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(runtime): add client-tauri + client-web runtimes`.

---

## Phase 6 — Verification (Plan C done)

### Task 10: full verification

- [ ] **Step 1:** `pnpm exec vitest run src/__tests__/infra src/__tests__/application src/__tests__/domain` → all PASS.
- [ ] **Step 2:** `pnpm exec tsgo --noEmit` → only pre-existing `upload-cjk-fonts-r2` error. CRITICAL: each `ManagedRuntime.make(...)` must have requirement `never` (no unmet ports) — a leftover `R` shows as a tsgo error at the `ManagedRuntime.make` call.
- [ ] **Step 3:** `pnpm exec biome check src/infra src/runtime src/__tests__/infra` → clean.
- [ ] **Step 4: Dependency direction** — infra may import `@tauri-apps/*`, `@/domain`, `@/application`, `effect`, and `@/services/*` (helpers it ports from), but NOT `@/app`, `@/components`, `@/store`, `@/hooks`:

```bash
grep -rnE "from '@/(app|components|store|hooks)" src/infra src/runtime/client-*.ts || echo "OK: infra/client-runtime free of app/components/store/hooks"
```

- [ ] **Step 5:** `pnpm test` → no new failures beyond the documented sandbox-flaky set + two pre-existing lint errors.

## Done-conditions

- All infra layers + both client runtimes exist; each runtime composes with requirement `never`.
- `TauriPathResolver` passes the §19.3 custom-root/portable/default tests; `TauriPlatform` detection tested; `TauriFileSystem` CRUD-delegation tested.
- Faithful port: edge-cases preserved (`content://`, iOS URI, RemoteFile fallback, Rust `read_dir`), same IndexedDB store, same DB drivers.
- tsgo + biome clean (modulo the two pre-existing unrelated errors); old `AppService` untouched.

## Risks

- **Layer requirement plumbing** (FileSystem→PathResolver+Platform, Database→PathResolver). tsgo is the safety net: an unmet requirement surfaces at `ManagedRuntime.make`. Resolve with `provideMerge`/nested `provide`.
- **Deep Tauri FS behavior** (`content://`, security-scoped URIs) is not unit-testable in jsdom — covered by delegation tests now + `.tauri.test.ts` follow-up. Port the branches verbatim; don't drop them for lack of a unit test.
- **WebFileSystem IDB** not unit-tested in this plan (jsdom lacks IndexedDB) — port faithfully, cover via `.browser.test.ts` follow-up. Flagged, not silently skipped.
- **Subdir-constant vs BaseDir-name under custom root** — verify against `getPathResolver`: under a custom root the leaf is the BaseDir NAME (`Books`), not the subdir constant. The Task 1 test pins this; adjust expected literals to match the source if they differ.
