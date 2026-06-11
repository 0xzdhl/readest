# Effect E6a — Settings De-adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Tasks are sequential. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rewrite `settingsService`'s fs-taking functions (`loadSettings`/`saveSettings`) into Effect-native functions on the `FileSystem`+`PathResolver` ports, so `SettingsRepositoryLive` drops `makeLegacyFsAdapter`; delete `settingsService.ts`. (The adapter file stays — other services still use it; it's removed in E6e.)

**Architecture:** New Effect-native functions in `application/services/settings/*` declare their port needs in the `R` channel (`yield* FileSystem` / `yield* PathResolver`); the live-layer `provideService`s the resolved ports to collapse `R` to `never`. Logic is **ported faithfully** from `settingsService.ts` (the source is the spec). A new Effect JSON helper replaces `persistence.ts` _for settings only_ (persistence.ts stays for `libraryService`).

**Tech Stack:** effect@3.21.2, Vitest, tsgo + Biome. `@/* → src/*`.

**Prereqs:** E1–E5 done. Ports + `TestFileSystem`/`TestPathResolver`/`TestPlatform` + `runtime/test.ts` exist. Spec: `docs/superpowers/specs/2026-06-11-effect-e6a-settings-deadapter-design.md`.

**Source of truth (read while porting):** `src/services/settingsService.ts` — `getDefaultViewSettings(ctx)` (38), `migrateHighlightColorPrefs(read)` (63), `loadSettings(ctx)` (105–171, uses `ctx.fs.getPrefix('Books')` ×2 + `safeLoadJSON` + internal `saveSettings` on missing uuids + `wikipedia→dictionary` coercion), `saveSettings(fs, settings)` (173). `src/services/persistence.ts` — `safeLoadJSON`/`safeSaveJSON` (the algorithm to mirror). `Context = { fs, isMobile, isEink, isAppDataSandbox }` (only `isMobile/isEink/isAppDataSandbox` used by the non-fs parts).

---

## File structure

```
src/application/services/settings/viewSettings.ts     # CREATE: pure getDefaultViewSettings + migrateHighlightColorPrefs (moved)
src/application/services/settings/json.ts             # CREATE: safeLoadJsonE / safeSaveJsonE (FileSystem-port Effect JSON helpers)
src/application/services/settings/systemSettings.ts   # CREATE: loadSystemSettings / saveSystemSettings (Effect-native)
src/infra/shared/SettingsRepository.layer.ts          # MODIFY: drop adapter; provide ports to the new functions
src/services/settingsService.ts                       # DELETE (single non-test caller was the layer)
src/__tests__/application/settingsJson.test.ts        # CREATE
src/__tests__/application/systemSettings.test.ts      # CREATE
# repoint any test that imported @/services/settingsService
```

---

## Task 1: Move the pure helpers (no behavior change)

**Files:** Create `src/application/services/settings/viewSettings.ts`; (Task 4 deletes `settingsService.ts`)

- [ ] **Step 1: Pre-flight grep** — list every importer of `@/services/settingsService` (incl. tests):

```bash
command grep -rn "from '@/services/settingsService'" src --include=*.ts --include=*.tsx
```

Record them; Task 4 repoints them to the new locations. (Expected non-test: only `SettingsRepository.layer.ts`.)

- [ ] **Step 2: Create `viewSettings.ts`** — MOVE `getDefaultViewSettings` and `migrateHighlightColorPrefs` verbatim from `settingsService.ts`, but change `getDefaultViewSettings`'s parameter from the legacy `Context` to a minimal `{ isMobile: boolean; isEink: boolean }` (it only reads those two). Keep all imports it needs (`@/services/constants`, `@/services/ai/constants`, `@/utils/misc` `isCJKEnv`/`getTargetLang`, `@/domain/*`). Signature:

```ts
// src/application/services/settings/viewSettings.ts
import type { ViewSettings, ReadSettings } from '@/domain/book'; // VERIFY exact homes via the original imports
// ...copy the original imports + bodies...
export type ViewSettingsCtx = { readonly isMobile: boolean; readonly isEink: boolean };
export function getDefaultViewSettings(ctx: ViewSettingsCtx): ViewSettings {
  /* original body, ctx.isMobile/ctx.isEink */
}
export function migrateHighlightColorPrefs(read: ReadSettings): void {
  /* original body verbatim */
}
```

READ the original to copy types/bodies exactly. (If a referenced type lives elsewhere, keep its original import path.)

- [ ] **Step 3:** `pnpm exec tsgo --noEmit` (the new file compiles; the old `settingsService.ts` still exists and compiles too — no caller changed yet). Only the pre-existing `upload-cjk-fonts-r2` error.
- [ ] **Step 4: Commit** `git add src/application/services/settings/viewSettings.ts && git commit -m "feat(application): move getDefaultViewSettings/migrateHighlightColorPrefs to application (E6a)"`

---

## Task 2: Effect-native JSON helpers (`safeLoadJsonE` / `safeSaveJsonE`)

**Files:** Create `src/application/services/settings/json.ts`; Test `src/__tests__/application/settingsJson.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/application/settingsJson.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { FileSystem } from '@/application/ports/FileSystem';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { safeLoadJsonE, safeSaveJsonE } from '@/application/services/settings/json';

const run = <A, E>(p: Effect.Effect<A, E, FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(TestFileSystemLive)) as Effect.Effect<A, E, never>);

describe('settings JSON helpers (FileSystem port)', () => {
  it('save then load round-trips', async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* safeSaveJsonE('f.json', 'Settings', { a: 1 });
        return yield* safeLoadJsonE<{ a: number }>('f.json', 'Settings', { a: 0 });
      }),
    );
    expect(out).toEqual({ a: 1 });
  });

  it('load returns default when absent', async () => {
    const out = await run(safeLoadJsonE<{ a: number }>('missing.json', 'Settings', { a: 42 }));
    expect(out).toEqual({ a: 42 });
  });
});
```

- [ ] **Step 2: Run — FAIL** (`pnpm exec vitest run src/__tests__/application/settingsJson.test.ts`).

- [ ] **Step 3: Implement** — mirror `persistence.ts` (main → `.bak` restore → default; save writes `.bak` then main), on the FileSystem port:

```ts
// src/application/services/settings/json.ts
import { Effect } from 'effect';
import type { BaseDir } from '@/domain/system';
import { FsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';

const parse = <T>(text: unknown): T | undefined => {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/** Mirror of persistence.safeLoadJSON: main -> .bak (restore) -> default; never fails for absence. */
export const safeLoadJsonE = <T>(
  filename: string,
  base: BaseDir,
  defaultValue: T,
): Effect.Effect<T, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const main = parse<T>(
      yield* fs.readFile(filename, base, 'text').pipe(Effect.orElseSucceed(() => '')),
    );
    if (main !== undefined) return main;
    const bak = parse<T>(
      yield* fs.readFile(`${filename}.bak`, base, 'text').pipe(Effect.orElseSucceed(() => '')),
    );
    if (bak !== undefined) {
      yield* fs
        .writeFile(filename, base, JSON.stringify(bak, null, 2))
        .pipe(Effect.catchAll(() => Effect.void)); // restore is best-effort (legacy logs + continues)
      return bak;
    }
    return defaultValue;
  });

/** Mirror of persistence.safeSaveJSON: write .bak then main. */
export const safeSaveJsonE = (
  filename: string,
  base: BaseDir,
  data: unknown,
): Effect.Effect<void, FsError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const json = JSON.stringify(data);
    yield* fs.writeFile(`${filename}.bak`, base, json);
    yield* fs.writeFile(filename, base, json);
  });
```

> Verify against `persistence.ts`: same backup-first/restore behavior. (`safeSaveJSON` uses `JSON.stringify(data)` without indent; the restore path uses 2-space indent — matches the legacy.)

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(application): add Effect JSON helpers for settings (E6a)`.

---

## Task 3: `loadSystemSettings` / `saveSystemSettings` (Effect-native, faithful)

**Files:** Create `src/application/services/settings/systemSettings.ts`; Test `src/__tests__/application/systemSettings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/application/systemSettings.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathState, PathStateLive } from '@/application/ports/PathState';
import { PathResolver } from '@/application/ports/PathResolver';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import {
  loadSystemSettings,
  saveSystemSettings,
} from '@/application/services/settings/systemSettings';

const layer = Layer.merge(
  TestFileSystemLive,
  Layer.provideMerge(TestPathResolverLive, PathStateLive),
);
const run = <A, E>(p: Effect.Effect<A, E, FileSystem | PathResolver>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
const info = { isMobile: false, isEink: false, isAppDataSandbox: false };

describe('loadSystemSettings / saveSystemSettings', () => {
  it('load with no file returns defaulted settings', async () => {
    const s = await run(loadSystemSettings(info));
    expect(s.version).toBeGreaterThan(0);
    expect(s.globalViewSettings).toBeDefined();
    expect(s.localBooksDir).toBeDefined();
  });

  it('save then load round-trips a custom field', async () => {
    const loaded = await run(
      Effect.gen(function* () {
        const s = yield* loadSystemSettings(info);
        yield* saveSystemSettings({ ...s, customRootDir: '/picked' });
        return yield* loadSystemSettings(info);
      }),
    );
    expect(loaded.customRootDir).toBe('/picked');
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — READ `settingsService.ts:105–174` and reproduce the sequence in `Effect.gen`, with these swaps (everything else verbatim):
  - `ctx.fs.getPrefix('Books')` → `yield* (yield* PathResolver).prefix('Books')` (both occurrences; map its `FsError`→`SettingsError`).
  - `safeLoadJSON(ctx.fs, …)` → `yield* safeLoadJsonE(…)`.
  - internal `await saveSettings(ctx.fs, settings)` (missing-uuid path) → `yield* saveSystemSettings(settings)` (map its error → `SettingsError`).
  - `getDefaultViewSettings(ctx)` / `migrateHighlightColorPrefs(...)` → import from `./viewSettings` (Task 1); pass `{ isMobile, isEink }`.
  - `ctx.isMobile/isEink/isAppDataSandbox` come from the `info` param.
  - Wrap the whole thing so failures surface as `SettingsError` (`Effect.mapError`/`catchTag` on the `FsError` boundary). Keep "absent/corrupt file → defaults" (handled by `safeLoadJsonE`, not an error).

Signature + skeleton:

```ts
// src/application/services/settings/systemSettings.ts
import { Effect } from 'effect';
import { v4 as uuidv4 } from 'uuid';
import type { SystemSettings } from '@/domain/settings';
import {
  SETTINGS_FILENAME /* DEFAULT_SYSTEM_SETTINGS, etc. — copy from settingsService */,
} from '@/services/constants';
import { SettingsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { getDefaultViewSettings, migrateHighlightColorPrefs } from './viewSettings';
import { safeLoadJsonE, safeSaveJsonE } from './json';

export type SettingsCtx = {
  readonly isMobile: boolean;
  readonly isEink: boolean;
  readonly isAppDataSandbox: boolean;
};

export const saveSystemSettings = (
  settings: SystemSettings,
): Effect.Effect<void, SettingsError, FileSystem> =>
  safeSaveJsonE(SETTINGS_FILENAME, 'Settings', settings).pipe(
    Effect.mapError((cause) => new SettingsError({ operation: 'save', cause })),
  );

export const loadSystemSettings = (
  ctx: SettingsCtx,
): Effect.Effect<SystemSettings, SettingsError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const resolver = yield* PathResolver;
    const booksPrefix = () =>
      resolver
        .prefix('Books')
        .pipe(Effect.mapError((cause) => new SettingsError({ operation: 'load', cause })));
    // ...reproduce settingsService.loadSettings(105-171) here, using booksPrefix(), safeLoadJsonE, saveSystemSettings...
  });
```

> Reproduce EVERY step of the original (default merge incl. mobile overrides, `version` handling, `migrateHighlightColorPrefs`, `globalViewSettings`/`aiSettings` merge, `localBooksDir`, `wikipedia→dictionary` coercion, the two uuid-fill-and-save branches). Confirm exact constant names by reading `settingsService.ts`'s import block.

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(application): add Effect-native loadSystemSettings/saveSystemSettings (E6a)`.

---

## Task 4: Rewrite the layer, delete `settingsService.ts`, repoint imports

**Files:** Modify `src/infra/shared/SettingsRepository.layer.ts`; Delete `src/services/settingsService.ts`; repoint test importers from Task 1's grep.

- [ ] **Step 1: Rewrite `SettingsRepository.layer.ts`** — drop `makeLegacyFsAdapter`; provide the ports to the new functions:

```ts
// src/infra/shared/SettingsRepository.layer.ts
import { Effect, Layer } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import {
  SettingsRepository,
  type SettingsRepositoryShape,
} from '@/application/repositories/SettingsRepository';
import { getDefaultViewSettings } from '@/application/services/settings/viewSettings';
import {
  loadSystemSettings,
  saveSystemSettings,
} from '@/application/services/settings/systemSettings';

export const SettingsRepositoryLive = Layer.effect(
  SettingsRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const info = yield* (yield* Platform).info;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem | PathResolver>) =>
      e.pipe(
        Effect.provideService(FileSystem, fsPort),
        Effect.provideService(PathResolver, resolver),
      );
    const ctx = {
      isMobile: info.isMobile,
      isEink: info.isEink,
      isAppDataSandbox: info.isAppDataSandbox,
    };
    return {
      load: provide(loadSystemSettings(ctx)),
      save: (s: SystemSettings) => provide(saveSystemSettings(s)),
      getDefaultViewSettings: Effect.sync(() =>
        getDefaultViewSettings({ isMobile: info.isMobile, isEink: info.isEink }),
      ),
    } satisfies SettingsRepositoryShape;
  }),
);
```

> `saveSystemSettings` only needs `FileSystem`; `provide` supplies both ports harmlessly. Confirm `SettingsRepositoryShape.getDefaultViewSettings` is `Effect<ViewSettings>` (no R) — the `Effect.sync` satisfies it.

- [ ] **Step 2: Repoint any test importers** of `@/services/settingsService` (from Task 1's grep) to `@/application/services/settings/viewSettings` (for `getDefaultViewSettings`/`migrateHighlightColorPrefs`) or the new `systemSettings` module. If a test imported `loadSettings`/`saveSettings` directly, switch it to `loadSystemSettings`/`saveSystemSettings` run over the test ports.

- [ ] **Step 3: Delete** `src/services/settingsService.ts` (`git rm src/services/settingsService.ts`).

- [ ] **Step 4: Verify** — `pnpm exec tsgo --noEmit` → only pre-existing error (no dangling `@/services/settingsService` import; `SettingsRepository.layer.ts` resolves with the ports provided). Then the regression gate:
      `pnpm exec vitest run src/__tests__/application/settingsRepository.test.ts src/__tests__/application/bootApp.test.ts src/__tests__/application/systemSettings.test.ts src/__tests__/application/settingsJson.test.ts` → all PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "refactor(effect): SettingsRepository drops makeLegacyFsAdapter; delete settingsService (E6a)"`

---

## Task 5: Verification (E6a done)

- [ ] **Step 1:** `pnpm exec tsgo --noEmit` → only pre-existing `upload-cjk-fonts-r2`. Both client runtimes still resolve to requirement `never` (the layer's shape is unchanged externally).
- [ ] **Step 2:** `pnpm exec biome check src/application src/infra/shared/SettingsRepository.layer.ts src/__tests__/application` → clean.
- [ ] **Step 3:** `pnpm test` → no new failures beyond documented flaky.
- [ ] **Step 4: Gates:**
  - `command grep -rn "makeLegacyFsAdapter" src/infra/shared/SettingsRepository.layer.ts` → empty (the layer no longer uses it).
  - `command grep -rn "from '@/services/settingsService'" src` → empty (file deleted, all importers repointed).
  - `command grep -rn "makeLegacyFsAdapter" src | wc -l` → decreased by one vs. the start (adapter still used by the other 7 layers + 2 usecases — that's expected).

## Done-conditions

- `SettingsRepositoryLive` no longer imports/uses `makeLegacyFsAdapter`; `settingsService.ts` deleted; the Effect-native settings functions live in `application/services/settings/*`.
- `persistence.ts` + `fsPortAdapter.ts` + `LegacyFileSystem` untouched (used by the remaining services; removed in later E6 slices).
- Regression tests (`settingsRepository`, `bootApp`) + new unit tests green; tsgo + biome at baseline.

## Risks

- **Behavioral divergence** — reproduce `settingsService.loadSettings` line-by-line; the green-throughout regression tests are the safety net.
- **Hidden test imports** of `settingsService` — Task 1 greps; Task 4 repoints. A missed one → tsgo "cannot find module" after the delete.
- **`R` not `never`** — the layer must `provideService` both ports; tsgo enforces it at `ManagedRuntime.make`.
- **`localBooksDir` value** — `PathResolver.prefix('Books')` must equal what the legacy `fs.getPrefix('Books')` produced; the round-trip test + bootApp test cover it.
