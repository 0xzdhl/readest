# Effect Foundation — Plan D: Boot + Settings + Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the Phase 1+2 design — `SettingsRepository`, `MigrationService`, `BootApp`, and the settings usecases (`LoadSettings`, `SaveSettings`, `ChangeRootDirectory`, `ResetSettings`) — wiring the Plan B/C ports into the boot/settings flow, validated against the test runtime. Reuse the proven `settingsService`/migration logic via a thin port-adapter (no reimplementation, no divergence).

**Architecture:** `SettingsRepository` (port in `application/repositories`) + `MigrationService` (port in `application/services`) get `infra/shared/*` live layers that **reuse** the existing `@/services/settingsService` + migration logic by bridging the new `FileSystem`/`PathResolver`/`Platform` ports into the old `FileSystem`-interface `Context` those functions expect. `BootApp` (usecase) orchestrates: load `Platform.info` → `SettingsRepository.load` → seed `PathState` from `settings.customRootDir` → `MigrationService.run`. Settings usecases are thin Effect wrappers. Additive: the old `AppService` boot path is untouched; `BootApp` runs only in the new runtimes/tests.

**Tech Stack:** effect@3.21.2, Vitest. Reuses `@/services/{settingsService,persistence,constants}` + the migration helpers. Path alias `@/* → src/*`.

**Prereqs:** Plans A+B+C complete. Ports + `PathStateLive` + test doubles + `runtime/test.ts` exist. `@/domain/*` types in place.

**Source of truth (read while porting):**

- `src/services/settingsService.ts` — `loadSettings(ctx)`, `saveSettings(fs, settings)`, `getDefaultViewSettings(ctx)`; `Context = { fs, isMobile, isEink, isAppDataSandbox }`. Uses only `fs.getPrefix`, `fs.readFile`, `fs.writeFile` (all async).
- `src/services/appService.ts` — `runMigrations(lastMigrationVersion)` (gated `< 20251124`), `migrate20251124()` (renames `getLibraryBackupFilename()` → `${getLibraryFilename()}.bak` under `'Books'` via `fs.exists/readFile/writeFile/removeFile`), `CURRENT_MIGRATION_VERSION = 20251124`. **Find** `getLibraryBackupFilename`/`getLibraryFilename` (likely `@/utils/book` or `@/services/constants`) and how the live boot reads the _last_ migration version (grep `runMigrations(` call sites — note the version source).
- `src/domain/settings` — `SystemSettings` shape (confirm the migration-version + `customRootDir` + `localBooksDir` fields).

**Conventions:** Ports use `Context.Tag('app/<Name>')`. Live layers in `infra/shared/`. Errors: `SettingsError`, `MigrationError` (already in `@/application/errors/AppError`). Usecases return `Effect`. The old-`FileSystem` adapter delegates async methods to the new ports via `Effect.runPromise(portEffect)` (the resolved port shapes carry no remaining requirement, so `runPromise` is valid); the two sync legacy methods (`resolvePath`, `getURL`) are never called by settings/migration — implement them as throwing stubs to satisfy the interface.

---

## File structure (created by this plan)

```
src/application/
  repositories/SettingsRepository.ts     # port
  services/MigrationService.ts           # port
  usecases/
    boot/BootApp.ts
    settings/{LoadSettings,SaveSettings,ChangeRootDirectory,ResetSettings}.ts
src/infra/shared/
  fsPortAdapter.ts                        # bridges new ports -> old FileSystem interface
  SettingsRepository.layer.ts
  MigrationService.layer.ts
src/__tests__/support/
  TestSettingsRepository.layer.ts         # (optional) simple in-memory repo, if needed
src/__tests__/application/
  settingsRepository.test.ts
  migrationService.test.ts
  bootApp.test.ts
  changeRootDirectory.test.ts
src/runtime/test.ts                        # MODIFY: add SettingsRepositoryLive + MigrationServiceLive
```

---

## Task 1: SettingsRepository + MigrationService ports

**Files:** Create `src/application/repositories/SettingsRepository.ts`, `src/application/services/MigrationService.ts`

- [ ] **Step 1: Implement SettingsRepository port**

```ts
// src/application/repositories/SettingsRepository.ts
import { Context, type Effect } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import type { ViewSettings } from '@/domain/book';
import type { SettingsError } from '@/application/errors/AppError';

export interface SettingsRepositoryShape {
  readonly load: Effect.Effect<SystemSettings, SettingsError>;
  readonly save: (settings: SystemSettings) => Effect.Effect<void, SettingsError>;
  readonly getDefaultViewSettings: Effect.Effect<ViewSettings>;
}

export class SettingsRepository extends Context.Tag('app/SettingsRepository')<
  SettingsRepository,
  SettingsRepositoryShape
>() {}
```

- [ ] **Step 2: Implement MigrationService port**

```ts
// src/application/services/MigrationService.ts
import { Context, type Effect } from 'effect';
import type { MigrationError } from '@/application/errors/AppError';

export type RunMigrationsInput = {
  readonly lastMigrationVersion: number;
};

export interface MigrationServiceShape {
  // Runs any migrations newer than lastMigrationVersion; resolves to the current version.
  readonly run: (input: RunMigrationsInput) => Effect.Effect<number, MigrationError>;
  readonly currentVersion: number;
}

export class MigrationService extends Context.Tag('app/MigrationService')<
  MigrationService,
  MigrationServiceShape
>() {}
```

- [ ] **Step 3: tsgo clean. Step 4: Commit** `git add src/application/repositories/SettingsRepository.ts src/application/services/MigrationService.ts && git commit -m "feat(application): add SettingsRepository + MigrationService ports"`

---

## Task 2: FileSystem port → old-FileSystem adapter

**Files:** Create `src/infra/shared/fsPortAdapter.ts`

Bridges the new `FileSystem`/`PathResolver` resolved shapes into the legacy `FileSystem` interface (`@/domain/system`) that `settingsService`/`persistence`/migration expect. Only `getPrefix`, `readFile`, `writeFile`, `exists`, `removeFile` are exercised; the rest delegate too (for completeness), and the two sync legacy methods throw.

- [ ] **Step 1: Implement**

```ts
// src/infra/shared/fsPortAdapter.ts
import { Effect } from 'effect';
import type { BaseDir, FileSystem as LegacyFileSystem, ResolvedPath } from '@/domain/system';
import type { FileSystemShape } from '@/application/ports/FileSystem';
import type { PathResolverShape } from '@/application/ports/PathResolver';

/**
 * Adapts the new Effect-based FileSystem + PathResolver ports to the legacy
 * Promise-based `FileSystem` interface that settingsService/persistence/migration
 * still consume. `fsPort`/`resolver` are RESOLVED shapes (no remaining R), so
 * `Effect.runPromise` on their methods is valid. Sync legacy methods
 * (resolvePath, getURL) are never called by those consumers — they throw.
 */
export const makeLegacyFsAdapter = (
  fsPort: FileSystemShape,
  resolver: PathResolverShape,
): LegacyFileSystem => ({
  getPrefix: (base: BaseDir) => Effect.runPromise(resolver.prefix(base)),
  readFile: (path, base, mode) => Effect.runPromise(fsPort.readFile(path, base, mode)),
  writeFile: (path, base, content) => Effect.runPromise(fsPort.writeFile(path, base, content)),
  exists: (path, base) => Effect.runPromise(fsPort.exists(path, base)),
  removeFile: (path, base) => Effect.runPromise(fsPort.removeFile(path, base)),
  openFile: (path, base, filename) => Effect.runPromise(fsPort.openFile(path, base, filename)),
  copyFile: (s, sb, d, db) => Effect.runPromise(fsPort.copyFile(s, sb, d, db)),
  createDir: (path, base, recursive) => Effect.runPromise(fsPort.createDir(path, base, recursive)),
  removeDir: (path, base, recursive) => Effect.runPromise(fsPort.removeDir(path, base, recursive)),
  readDir: (path, base) => Effect.runPromise(fsPort.readDir(path, base)),
  stats: (path, base) => Effect.runPromise(fsPort.stat(path, base)),
  getBlobURL: (path, base) => Effect.runPromise(fsPort.getBlobUrl(path, base)),
  getImageURL: (path) => Effect.runPromise(fsPort.getUrl(path)),
  resolvePath: (_path: string, _base: BaseDir): ResolvedPath => {
    throw new Error(
      'resolvePath is not supported by the port adapter (unused by settings/migration)',
    );
  },
  getURL: (_path: string): string => {
    throw new Error('getURL is not supported by the port adapter (unused by settings/migration)');
  },
});
```

> While implementing: READ `@/domain/system` `FileSystem` interface and match EVERY method signature exactly (names, arg order, return types). If a method's legacy signature differs from the new port (e.g. `stats` vs `stat`, `getURL` vs `getUrl`, `removeFile` present?), map accordingly. tsgo will flag any mismatch.

- [ ] **Step 2: tsgo clean. Step 3: Commit** `git add src/infra/shared/fsPortAdapter.ts && git commit -m "feat(infra): add new-port -> legacy-FileSystem adapter"`

---

## Task 3: SettingsRepository live layer + tests

**Files:** Create `src/infra/shared/SettingsRepository.layer.ts`; Test `src/__tests__/application/settingsRepository.test.ts`

Reuses `@/services/settingsService` with a `Context` built from the adapter + `Platform.info`.

- [ ] **Step 1: Write the failing test** (against the test runtime's ports)

```ts
// src/__tests__/application/settingsRepository.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';
import { SettingsRepositoryLive } from '@/infra/shared/SettingsRepository.layer';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Deps = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, Base);
const layer = Layer.provide(SettingsRepositoryLive, Deps);
const run = <A>(p: Effect.Effect<A, unknown, SettingsRepository>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('SettingsRepository (live, over test ports)', () => {
  it('load returns defaulted settings when no file exists', async () => {
    const settings = await run(Effect.flatMap(SettingsRepository, (r) => r.load));
    expect(settings.version).toBeGreaterThan(0);
    expect(settings.globalViewSettings).toBeDefined();
    expect(settings.localBooksDir).toBeDefined();
  });

  it('save then load round-trips a custom field', async () => {
    const loaded = await run(
      Effect.gen(function* () {
        const repo = yield* SettingsRepository;
        const s = yield* repo.load;
        yield* repo.save({ ...s, customRootDir: '/picked' });
        return yield* repo.load;
      }),
    );
    expect(loaded.customRootDir).toBe('/picked');
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — reuse settingsService:

```ts
// src/infra/shared/SettingsRepository.layer.ts
import { Effect, Layer } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import { SettingsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import {
  SettingsRepository,
  type SettingsRepositoryShape,
} from '@/application/repositories/SettingsRepository';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import {
  getDefaultViewSettings,
  loadSettings as legacyLoadSettings,
  saveSettings as legacySaveSettings,
} from '@/services/settingsService';

export const SettingsRepositoryLive = Layer.effect(
  SettingsRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const platform = yield* Platform;
    const info = yield* platform.info;

    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const ctx = {
      fs,
      isMobile: info.isMobile,
      isEink: info.isEink,
      isAppDataSandbox: info.isAppDataSandbox,
    };

    return {
      load: Effect.tryPromise({
        try: () => legacyLoadSettings(ctx),
        catch: (cause) => new SettingsError({ operation: 'load', cause }),
      }),
      save: (settings: SystemSettings) =>
        Effect.tryPromise({
          try: () => legacySaveSettings(fs, settings),
          catch: (cause) => new SettingsError({ operation: 'save', cause }),
        }),
      getDefaultViewSettings: Effect.sync(() => getDefaultViewSettings(ctx)),
    } satisfies SettingsRepositoryShape;
  }),
);
```

> If `legacyLoadSettings` calls `fs` methods the adapter throws on (it should only use getPrefix/readFile/writeFile), the test will fail — widen the adapter. If it imports something that breaks under jsdom/test (e.g. `isCJKEnv`/`getTargetLang` from `@/utils/misc`), those are pure and should work; if not, report.

- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(infra): add SettingsRepository live layer (reuses settingsService)`.

---

## Task 4: MigrationService live layer + test

**Files:** Create `src/infra/shared/MigrationService.layer.ts`; Test `src/__tests__/application/migrationService.test.ts`

Port `runMigrations`/`migrate20251124` onto the new `FileSystem` port. READ `appService.ts` for the exact migration body and the lib filename helpers.

- [ ] **Step 1: Write the failing test** — set up an old backup library file in TestFileSystem under `'Books'`, run migration with `lastMigrationVersion: 0`, assert the file is renamed to `${libraryFilename}.bak` and the old name removed; and that `run({ lastMigrationVersion: 20251124 })` is a no-op (already current). Assert `run` resolves to `currentVersion` (20251124).

```ts
// src/__tests__/application/migrationService.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { MigrationService } from '@/application/services/MigrationService';
import { MigrationServiceLive } from '@/infra/shared/MigrationService.layer';
import { FileSystem } from '@/application/ports/FileSystem';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
// READ appService.ts for getLibraryBackupFilename / getLibraryFilename import paths and use them here.

const layer = Layer.provideMerge(MigrationServiceLive, TestFileSystemLive);
const run = <A>(p: Effect.Effect<A, unknown, MigrationService | FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('MigrationService', () => {
  it('migrate20251124 renames the legacy backup library file', async () => {
    const result = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        // seed legacy backup file (use the real getLibraryBackupFilename()):
        yield* fs.writeFile(
          /* getLibraryBackupFilename() */ 'library.json.old.bak',
          'Books',
          'DATA',
        );
        const m = yield* MigrationService;
        const version = yield* m.run({ lastMigrationVersion: 0 });
        const renamedExists = yield* fs.exists(
          /* `${getLibraryFilename()}.bak` */ 'library.json.bak',
          'Books',
        );
        const oldExists = yield* fs.exists('library.json.old.bak', 'Books');
        return { version, renamedExists, oldExists };
      }),
    );
    expect(result.renamedExists).toBe(true);
    expect(result.oldExists).toBe(false);
    expect(result.version).toBe(20251124);
  });
});
```

> Replace the placeholder filenames with the REAL `getLibraryBackupFilename()` / `${getLibraryFilename()}.bak` values (import the helpers; do not hardcode if the helpers are available).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — port the migration onto the FileSystem port:

```ts
// src/infra/shared/MigrationService.layer.ts
import { Effect, Layer } from 'effect';
import { MigrationError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import {
  MigrationService,
  type MigrationServiceShape,
} from '@/application/services/MigrationService';
// READ appService.ts: import getLibraryBackupFilename, getLibraryFilename from their real module.
import { getLibraryBackupFilename, getLibraryFilename } from '@/utils/book'; // VERIFY path

const CURRENT_MIGRATION_VERSION = 20251124;

export const MigrationServiceLive = Layer.effect(
  MigrationService,
  Effect.gen(function* () {
    const fs = yield* FileSystem;

    const migrate20251124 = Effect.gen(function* () {
      const oldBackup = getLibraryBackupFilename();
      const newBackup = `${getLibraryFilename()}.bak`;
      const present = yield* fs.exists(oldBackup, 'Books');
      if (!present) return;
      const content = yield* fs.readFile(oldBackup, 'Books', 'text');
      yield* fs.writeFile(newBackup, 'Books', content);
      yield* fs.removeFile(oldBackup, 'Books');
    }).pipe(
      // legacy swallows migration errors (logs only); preserve that — fold to void.
      Effect.catchAll(() => Effect.void),
    );

    const run = (input: { lastMigrationVersion: number }) =>
      Effect.gen(function* () {
        if (input.lastMigrationVersion < 20251124) {
          yield* migrate20251124;
        }
        return CURRENT_MIGRATION_VERSION;
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.fail(
            new MigrationError({
              operation: 'run',
              fromVersion: input.lastMigrationVersion,
              cause,
            }),
          ),
        ),
      );

    return { run, currentVersion: CURRENT_MIGRATION_VERSION } satisfies MigrationServiceShape;
  }),
);
```

> Match the legacy `migrate20251124` body EXACTLY (it logs + swallows errors). Verify the helper import path (`getLibraryBackupFilename`/`getLibraryFilename`) by grepping; adjust the import. If they live in a module that pulls forbidden deps into infra, that's fine (infra may import `@/services|utils`).

- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(infra): add MigrationService live layer (ports migrate20251124)`.

---

## Task 5: BootApp usecase + test

**Files:** Create `src/application/usecases/boot/BootApp.ts`; Test `src/__tests__/application/bootApp.test.ts`

- [ ] **Step 1: Write the failing test** (end-to-end on a runtime providing Platform + PathState + SettingsRepository + MigrationService)

```ts
// src/__tests__/application/bootApp.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { BootApp } from '@/application/usecases/boot/BootApp';
import { PathState, PathStateLive } from '@/application/ports/PathState';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { SettingsRepositoryLive } from '@/infra/shared/SettingsRepository.layer';
import { MigrationServiceLive } from '@/infra/shared/MigrationService.layer';

const PathLayer = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Ports = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, PathLayer);
const Repos = Layer.provide(Layer.mergeAll(SettingsRepositoryLive, MigrationServiceLive), Ports);
const layer = Layer.merge(Ports, Repos);
const run = <A>(p: Effect.Effect<A, unknown, never>) => Effect.runPromise(p);

describe('BootApp', () => {
  it('loads settings, seeds PathState from customRootDir, runs migrations', async () => {
    const out = await run(
      Effect.gen(function* () {
        const result = yield* BootApp; // { platform, settings }
        const cfg = yield* PathState; // PathState seeded by BootApp
        const pathCfg = yield* cfg.get;
        return {
          appPlatform: result.platform.appPlatform,
          hasSettings: !!result.settings,
          pathCfg,
        };
      }).pipe(Effect.provide(layer)),
    );
    expect(out.appPlatform).toBe('web'); // TestPlatform
    expect(out.hasSettings).toBe(true);
    // default settings have no customRootDir → PathState stays default; assert it's defined & non-portable
    expect(out.pathCfg.isPortable).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (spec §10.1; the migration-version source is `settings.<field>` — verify the real field name, default 0)

```ts
// src/application/usecases/boot/BootApp.ts
import { Effect } from 'effect';
import { Platform } from '@/application/ports/Platform';
import { PathState } from '@/application/ports/PathState';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';
import { MigrationService } from '@/application/services/MigrationService';

export const BootApp = Effect.gen(function* () {
  const platform = yield* Platform;
  const pathState = yield* PathState;
  const settingsRepo = yield* SettingsRepository;
  const migration = yield* MigrationService;

  const info = yield* platform.info;
  const settings = yield* settingsRepo.load;

  if (settings.customRootDir) {
    yield* pathState.update((current) => ({ ...current, customRootDir: settings.customRootDir }));
  }

  // VERIFY the real last-migration-version field on SystemSettings (grep settingsService/appService);
  // fall back to 0 if absent.
  const lastMigrationVersion = (settings as { migrationVersion?: number }).migrationVersion ?? 0;
  yield* migration.run({ lastMigrationVersion });

  return { platform: info, settings };
});
```

- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(application): add BootApp usecase`.

---

## Task 6: Settings usecases + tests

**Files:** Create `src/application/usecases/settings/{LoadSettings,SaveSettings,ChangeRootDirectory,ResetSettings}.ts`; Test `src/__tests__/application/changeRootDirectory.test.ts`

- [ ] **Step 1: Implement the four usecases**

```ts
// src/application/usecases/settings/LoadSettings.ts
import { Effect } from 'effect';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';
export const LoadSettings = Effect.flatMap(SettingsRepository, (r) => r.load);
```

```ts
// src/application/usecases/settings/SaveSettings.ts
import { Effect } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';
export const SaveSettings = (settings: SystemSettings) =>
  Effect.flatMap(SettingsRepository, (r) => r.save(settings));
```

```ts
// src/application/usecases/settings/ChangeRootDirectory.ts (spec §10.2)
import { Effect } from 'effect';
import { PathState } from '@/application/ports/PathState';
import { PathResolver } from '@/application/ports/PathResolver';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';

export const ChangeRootDirectory = (customRootDir: string) =>
  Effect.gen(function* () {
    const pathState = yield* PathState;
    const resolver = yield* PathResolver;
    const settingsRepo = yield* SettingsRepository;

    const settings = yield* settingsRepo.load;
    yield* pathState.update((current) => ({ ...current, customRootDir }));
    const localBooksDir = yield* resolver.prefix('Books');
    yield* settingsRepo.save({ ...settings, customRootDir, localBooksDir });
    return { localBooksDir };
  });
```

```ts
// src/application/usecases/settings/ResetSettings.ts
// Reset = load fresh defaults and persist. Reuse the repository's default path:
// the simplest faithful reset writes default settings by removing the file then loading.
import { Effect } from 'effect';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';
import { FileSystem } from '@/application/ports/FileSystem';
import { SETTINGS_FILENAME } from '@/services/constants';

export const ResetSettings = Effect.gen(function* () {
  const fs = yield* FileSystem;
  yield* fs.removeFile(SETTINGS_FILENAME, 'Settings').pipe(Effect.orElse(() => Effect.void));
  yield* fs
    .removeFile(`${SETTINGS_FILENAME}.bak`, 'Settings')
    .pipe(Effect.orElse(() => Effect.void));
  const repo = yield* SettingsRepository;
  return yield* repo.load; // returns regenerated defaults
});
```

> Verify `removeFile`/`orElse` types. `ResetSettings` requires both `FileSystem` and `SettingsRepository`. If you prefer, model reset as `settingsRepo` re-deriving defaults — but removing the file + reload matches the legacy "no file → defaults" behavior exactly.

- [ ] **Step 2: Write ChangeRootDirectory test**

```ts
// src/__tests__/application/changeRootDirectory.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { ChangeRootDirectory } from '@/application/usecases/settings/ChangeRootDirectory';
import { LoadSettings } from '@/application/usecases/settings/LoadSettings';
import { PathState, PathStateLive } from '@/application/ports/PathState';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { SettingsRepositoryLive } from '@/infra/shared/SettingsRepository.layer';

const PathLayer = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Ports = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, PathLayer);
const layer = Layer.provideMerge(SettingsRepositoryLive, Ports);
const run = <A>(p: Effect.Effect<A, unknown, never>) => Effect.runPromise(p);

describe('ChangeRootDirectory', () => {
  it('updates PathState and persists customRootDir + localBooksDir', async () => {
    const out = await run(
      Effect.gen(function* () {
        const { localBooksDir } = yield* ChangeRootDirectory('/picked');
        const cfg = yield* (yield* PathState).get;
        const settings = yield* LoadSettings;
        return { localBooksDir, cfg, settings };
      }).pipe(Effect.provide(layer)),
    );
    expect(out.cfg.customRootDir).toBe('/picked');
    expect(out.settings.customRootDir).toBe('/picked');
    expect(out.settings.localBooksDir).toBe(out.localBooksDir);
  });
});
```

- [ ] **Step 3: Run — FAIL → implement → PASS.**
- [ ] **Step 4: Commit** `feat(application): add settings usecases (Load/Save/ChangeRootDirectory/Reset)`.

---

## Task 7: Wire repos into the test runtime

**Files:** Modify `src/runtime/test.ts`

- [ ] **Step 1: Add `SettingsRepositoryLive` + `MigrationServiceLive`** to the test runtime so usecases run against it. They depend on the existing test ports — `Layer.provide(Layer.mergeAll(SettingsRepositoryLive, MigrationServiceLive), <existing ports>)`, merged into `TestLayer`. Keep the existing exports working.
- [ ] **Step 2:** Add a `testRuntime` smoke that runs `BootApp` and asserts `{ platform, settings }`. (Append to `testRuntime.test.ts` or a new file.)
- [ ] **Step 3:** `pnpm exec vitest run src/__tests__/application` → all PASS. **Step 4: Commit** `feat(runtime): wire SettingsRepository + MigrationService into test runtime`.

---

## Task 8: Full verification (Plan D done — Phase 1+2 complete)

- [ ] **Step 1:** `pnpm exec vitest run src/__tests__/application src/__tests__/infra src/__tests__/domain` → all PASS.
- [ ] **Step 2:** `pnpm exec tsgo --noEmit` → only pre-existing `upload-cjk-fonts-r2`.
- [ ] **Step 3:** `pnpm exec biome check src/application src/infra src/runtime src/__tests__/application` → clean.
- [ ] **Step 4: Dependency direction** — `application/` must not import `infra/app/components/store/hooks`; `infra/shared` may import `@/services`:

```bash
grep -rnE "from '@/(infra|app|components|store|hooks)/" src/application || echo "OK: application depends only on domain/application/effect"
```

- [ ] **Step 5:** `pnpm test` → no new failures beyond the documented sandbox-flaky set + two pre-existing lint errors.

## Done-conditions (Phase 1+2 complete)

- `SettingsRepository` (reuses settingsService), `MigrationService` (ports migrate20251124), `BootApp`, and the four settings usecases exist and pass tests against the test runtime.
- §19.3 gate satisfied: `SettingsRepository` load-defaults/save-roundtrip, `MigrationService` version+steps, `BootApp` load→seed-PathState→migrate, `ChangeRootDirectory` PathState+settings.
- tsgo + biome clean (modulo the two pre-existing unrelated errors); old `AppService` untouched (still the live boot path).

## Risks

- **Adapter coverage** — if `legacyLoadSettings` calls an old-FS method the adapter throws on, widen it (only getPrefix/readFile/writeFile expected). The Task 3 test exercises the real path and will surface any gap.
- **Migration helper import paths** (`getLibraryBackupFilename`/`getLibraryFilename`, last-migration-version field) — VERIFY by grepping the source; don't assume the path/field. tsgo + the migration test pin them.
- **`Effect.runPromise` inside the adapter** — valid only because the port shapes are resolved (no remaining R). Do NOT move the adapter above the layer that resolves the ports.
- **ResetSettings semantics** — modeled as remove-file + reload-defaults to match legacy "no file → defaults"; if the team wants in-place default writing instead, adjust (behavior-equivalent).
