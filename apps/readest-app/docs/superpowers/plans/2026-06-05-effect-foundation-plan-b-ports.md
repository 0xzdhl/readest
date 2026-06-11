# Effect Foundation — Plan B: Errors + Ports + Test Runtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the Effect contract layer — `application/errors` (tagged errors), the six port `Context.Tag` contracts (Platform, PathState, PathResolver, FileSystem, Dialog, Database), the real `PathStateLive` layer, in-memory test doubles, and `runtime/test.ts` — validated by unit tests against the test runtime.

**Architecture:** Pure Effect contracts depending only on `@/domain/*` types and `application/errors`. No infra/platform code yet (that's Plan C). Ports are `Context.Tag` interfaces; `PathStateLive` is the one real implementation (Ref-backed). Test doubles (`TestPlatform`, `TestPathResolver`, `TestFileSystem`) make `runtime/test.ts` runnable so the port shapes are exercised by real programs.

**Tech Stack:** effect@3.21.2 (`Context`, `Layer`, `Effect`, `Ref`, `Data`, `Option`, `ManagedRuntime`), Vitest, tsgo + Biome. Path alias `@/* → src/*`.

**Prereqs:** Plan A complete — types live in `@/domain/*`. Design: `docs/superpowers/specs/2026-06-05-effect-foundation-phase1-2-design.md`.

**Conventions (follow exactly):**

- Tags namespaced `app/<Name>` (e.g. `Context.Tag('app/FileSystem')`).
- Each port is a separate `<Name>Shape` interface + a `Context.Tag` class.
- Errors via `Data.TaggedError` (NOT the older `_tag`+Error style in `storage/errors.ts`; that module is not in scope).
- All port methods return `Effect.Effect<A, E>` (never `Promise`).
- Domain type homes: `BaseDir`, `ResolvedPath`, `FileItem`, `FileInfo`, `AppPlatform`, `OsPlatform`, `DistChannel`, `SelectDirectoryMode` → `@/domain/system`; `DatabaseService`, `DatabaseOpts` → `@/domain/database`; `SchemaType` → `@/domain/migration`.

---

## File structure (created by this plan)

```
src/application/
  errors/AppError.ts          # FsError, PlatformError, DatabaseError, SettingsError, MigrationError, UserCancelled, AppError
  ports/
    Platform.ts               # Platform tag + PlatformInfo
    PathState.ts              # PathState tag + PathConfig + PathStateLive
    PathResolver.ts           # PathResolver tag
    FileSystem.ts             # FileSystem tag
    Dialog.ts                 # Dialog tag + dialog option types
    Database.ts               # Database tag + OpenDatabaseInput
    index.ts                  # barrel
src/__tests__/support/
    TestPlatform.layer.ts     # fixed PlatformInfo
    TestPathResolver.layer.ts # simple PathState-aware resolver
    TestFileSystem.layer.ts   # in-memory Map-backed FileSystem
src/runtime/
    test.ts                   # ManagedRuntime: TestPlatform + PathStateLive + TestPathResolver + TestFileSystem
src/__tests__/application/
    pathState.test.ts
    testFileSystem.test.ts
    testPathResolver.test.ts
```

Dialog and Database get **contracts only** in this plan (no test double, no test) — their test doubles/usage arrive with Plan C/D when a consumer exists.

---

## Task 1: Tagged error taxonomy

**Files:** Create `src/application/errors/AppError.ts`; Test `src/__tests__/application/appError.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/application/appError.test.ts
import { describe, expect, it } from 'vitest';
import { FsError, UserCancelled, type AppError } from '@/application/errors/AppError';

describe('AppError taxonomy', () => {
  it('FsError carries operation/path/cause and a discriminant tag', () => {
    const err = new FsError({ operation: 'readFile', path: '/x', cause: new Error('boom') });
    expect(err._tag).toBe('FsError');
    expect(err.operation).toBe('readFile');
    expect(err.path).toBe('/x');
  });

  it('UserCancelled is part of the AppError union and discriminates by _tag', () => {
    const e: AppError = new UserCancelled({ operation: 'selectFiles' });
    expect(e._tag).toBe('UserCancelled');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

Run: `pnpm exec vitest run src/__tests__/application/appError.test.ts`
Expected: FAIL — cannot find `@/application/errors/AppError`.

- [ ] **Step 3: Implement**

```ts
// src/application/errors/AppError.ts
import { Data } from 'effect';

export class FsError extends Data.TaggedError('FsError')<{
  readonly operation: string;
  readonly path?: string;
  readonly cause: unknown;
}> {}

export class PlatformError extends Data.TaggedError('PlatformError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly operation: string;
  readonly path?: string;
  readonly cause: unknown;
}> {}

export class SettingsError extends Data.TaggedError('SettingsError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class MigrationError extends Data.TaggedError('MigrationError')<{
  readonly operation: string;
  readonly fromVersion?: number;
  readonly cause: unknown;
}> {}

export class UserCancelled extends Data.TaggedError('UserCancelled')<{
  readonly operation: string;
}> {}

export type AppError =
  | FsError
  | PlatformError
  | DatabaseError
  | SettingsError
  | MigrationError
  | UserCancelled;
```

- [ ] **Step 4: Run — expect PASS.** `pnpm exec vitest run src/__tests__/application/appError.test.ts`
- [ ] **Step 5: Commit**

```bash
git add src/application/errors/AppError.ts src/__tests__/application/appError.test.ts
git commit -m "feat(application): add tagged error taxonomy"
```

---

## Task 2: Platform port

**Files:** Create `src/application/ports/Platform.ts`

- [ ] **Step 1: Implement** (no standalone test — contract validated by `runtime/test` + TestPlatform in Task 8/10; tsgo is the gate here)

```ts
// src/application/ports/Platform.ts
import { Context, type Effect } from 'effect';
import type { AppPlatform, DistChannel, OsPlatform } from '@/domain/system';

// Mirrors the capability surface of the legacy AppService (faithful port target for Plan C).
export type PlatformInfo = {
  readonly appPlatform: AppPlatform;
  readonly osPlatform: OsPlatform;
  readonly hasTrafficLight: boolean;
  readonly hasWindow: boolean;
  readonly hasWindowBar: boolean;
  readonly hasContextMenu: boolean;
  readonly hasRoundedWindow: boolean;
  readonly hasSafeAreaInset: boolean;
  readonly hasHaptics: boolean;
  readonly hasUpdater: boolean;
  readonly hasOrientationLock: boolean;
  readonly hasScreenBrightness: boolean;
  readonly hasIAP: boolean;
  readonly isMobile: boolean;
  readonly isAppDataSandbox: boolean;
  readonly isMobileApp: boolean;
  readonly isAndroidApp: boolean;
  readonly isIOSApp: boolean;
  readonly isMacOSApp: boolean;
  readonly isLinuxApp: boolean;
  readonly isPortableApp: boolean;
  readonly isDesktopApp: boolean;
  readonly isAppImage: boolean;
  readonly isEink: boolean;
  readonly canCustomizeRootDir: boolean;
  readonly canReadExternalDir: boolean;
  readonly supportsCanvasContext2DFilter: boolean;
  readonly distChannel: DistChannel;
  readonly storefrontRegionCode: string | null;
  readonly isOnlineCatalogsAccessible: boolean;
};

export interface PlatformShape {
  readonly info: Effect.Effect<PlatformInfo>;
}

export class Platform extends Context.Tag('app/Platform')<Platform, PlatformShape>() {}
```

- [ ] **Step 2: Typecheck** `pnpm exec tsgo --noEmit` → only pre-existing `upload-cjk-fonts-r2` error.
- [ ] **Step 3: Commit** `git add src/application/ports/Platform.ts && git commit -m "feat(application): add Platform port"`

---

## Task 3: PathState port + PathStateLive (with test)

**Files:** Create `src/application/ports/PathState.ts`; Test `src/__tests__/application/pathState.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/application/pathState.test.ts
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { PathState, PathStateLive, type PathConfig } from '@/application/ports/PathState';

const run = <A>(program: Effect.Effect<A, never, PathState>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(PathStateLive)));

describe('PathStateLive', () => {
  it('defaults to a non-portable empty config', async () => {
    const cfg = await run(Effect.flatMap(PathState, (s) => s.get));
    expect(cfg).toEqual<PathConfig>({ isPortable: false });
  });

  it('set replaces the whole config', async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.set({ customRootDir: '/root', isPortable: true });
        return yield* s.get;
      }),
    );
    expect(cfg).toEqual({ customRootDir: '/root', isPortable: true });
  });

  it('update mutates via a function', async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.update((c) => ({ ...c, customRootDir: '/changed' }));
        return yield* s.get;
      }),
    );
    expect(cfg.customRootDir).toBe('/changed');
    expect(cfg.isPortable).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm exec vitest run src/__tests__/application/pathState.test.ts`).

- [ ] **Step 3: Implement**

```ts
// src/application/ports/PathState.ts
import { Context, Effect, Layer, Ref } from 'effect';

export type PathConfig = {
  readonly customRootDir?: string;
  readonly execDir?: string;
  readonly isPortable: boolean;
};

export interface PathStateShape {
  readonly get: Effect.Effect<PathConfig>;
  readonly set: (config: PathConfig) => Effect.Effect<void>;
  readonly update: (f: (config: PathConfig) => PathConfig) => Effect.Effect<void>;
}

export class PathState extends Context.Tag('app/PathState')<PathState, PathStateShape>() {}

export const PathStateLive = Layer.effect(
  PathState,
  Effect.gen(function* () {
    const ref = yield* Ref.make<PathConfig>({ isPortable: false });
    return {
      get: Ref.get(ref),
      set: (config) => Ref.set(ref, config),
      update: (f) => Ref.update(ref, f),
    } satisfies PathStateShape;
  }),
);
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/application/ports/PathState.ts src/__tests__/application/pathState.test.ts && git commit -m "feat(application): add PathState port + PathStateLive"`

---

## Task 4: PathResolver port

**Files:** Create `src/application/ports/PathResolver.ts`

- [ ] **Step 1: Implement**

```ts
// src/application/ports/PathResolver.ts
import { Context, type Effect } from 'effect';
import type { BaseDir, ResolvedPath } from '@/domain/system';
import type { FsError } from '@/application/errors/AppError';

export interface PathResolverShape {
  readonly resolve: (path: string, base: BaseDir) => Effect.Effect<ResolvedPath, FsError>;
  readonly prefix: (base: BaseDir) => Effect.Effect<string, FsError>;
  readonly absolute: (path: string, base: BaseDir) => Effect.Effect<string, FsError>;
}

export class PathResolver extends Context.Tag('app/PathResolver')<
  PathResolver,
  PathResolverShape
>() {}
```

- [ ] **Step 2: Typecheck** → clean. **Step 3: Commit** `git add src/application/ports/PathResolver.ts && git commit -m "feat(application): add PathResolver port"`

---

## Task 5: FileSystem port

**Files:** Create `src/application/ports/FileSystem.ts`

- [ ] **Step 1: Implement**

```ts
// src/application/ports/FileSystem.ts
import { Context, type Effect } from 'effect';
import type { BaseDir, FileInfo, FileItem } from '@/domain/system';
import type { FsError } from '@/application/errors/AppError';

export interface FileSystemShape {
  readonly openFile: (
    path: string,
    base: BaseDir,
    filename?: string,
  ) => Effect.Effect<File, FsError>;
  readonly readFile: (
    path: string,
    base: BaseDir,
    mode: 'text' | 'binary',
  ) => Effect.Effect<string | ArrayBuffer, FsError>;
  readonly writeFile: (
    path: string,
    base: BaseDir,
    content: string | ArrayBuffer | File,
  ) => Effect.Effect<void, FsError>;
  readonly copyFile: (
    srcPath: string,
    srcBase: BaseDir,
    dstPath: string,
    dstBase: BaseDir,
  ) => Effect.Effect<void, FsError>;
  readonly removeFile: (path: string, base: BaseDir) => Effect.Effect<void, FsError>;
  readonly createDir: (
    path: string,
    base: BaseDir,
    recursive?: boolean,
  ) => Effect.Effect<void, FsError>;
  readonly removeDir: (
    path: string,
    base: BaseDir,
    recursive?: boolean,
  ) => Effect.Effect<void, FsError>;
  readonly readDir: (path: string, base: BaseDir) => Effect.Effect<FileItem[], FsError>;
  readonly exists: (path: string, base: BaseDir) => Effect.Effect<boolean>;
  readonly stat: (path: string, base: BaseDir) => Effect.Effect<FileInfo, FsError>;
  readonly getUrl: (path: string) => Effect.Effect<string, FsError>;
  readonly getBlobUrl: (path: string, base: BaseDir) => Effect.Effect<string, FsError>;
}

export class FileSystem extends Context.Tag('app/FileSystem')<FileSystem, FileSystemShape>() {}
```

- [ ] **Step 2: Typecheck** → clean. **Step 3: Commit** `git add src/application/ports/FileSystem.ts && git commit -m "feat(application): add FileSystem port"`

---

## Task 6: Dialog port

**Files:** Create `src/application/ports/Dialog.ts`

- [ ] **Step 1: Implement**

```ts
// src/application/ports/Dialog.ts
import { Context, type Effect, type Option } from 'effect';
import type { SelectDirectoryMode } from '@/domain/system';
import type { PlatformError } from '@/application/errors/AppError';

export type SharePosition = {
  readonly x: number;
  readonly y: number;
  readonly preferredEdge?: 'top' | 'bottom' | 'left' | 'right';
};

export type SaveFileOptions = {
  readonly filePath?: string;
  readonly mimeType?: string;
  readonly share?: boolean;
  readonly sharePosition?: SharePosition;
};

export interface DialogShape {
  readonly ask: (message: string) => Effect.Effect<boolean, PlatformError>;
  readonly selectDirectory: (
    mode: SelectDirectoryMode,
  ) => Effect.Effect<Option.Option<string>, PlatformError>;
  readonly selectFiles: (
    name: string,
    extensions: string[],
  ) => Effect.Effect<readonly string[], PlatformError>;
  readonly saveFile: (
    filename: string,
    content: string | ArrayBuffer,
    options?: SaveFileOptions,
  ) => Effect.Effect<Option.Option<string>, PlatformError>;
}

export class Dialog extends Context.Tag('app/Dialog')<Dialog, DialogShape>() {}
```

- [ ] **Step 2: Typecheck** → clean. **Step 3: Commit** `git add src/application/ports/Dialog.ts && git commit -m "feat(application): add Dialog port"`

---

## Task 7: Database port + ports barrel

**Files:** Create `src/application/ports/Database.ts`, `src/application/ports/index.ts`

- [ ] **Step 1: Implement Database port**

```ts
// src/application/ports/Database.ts
import { Context, type Effect } from 'effect';
import type { BaseDir } from '@/domain/system';
import type { DatabaseOpts, DatabaseService } from '@/domain/database';
import type { SchemaType } from '@/domain/migration';
import type { DatabaseError } from '@/application/errors/AppError';

export type OpenDatabaseInput = {
  readonly schema: SchemaType;
  readonly path: string;
  readonly base: BaseDir;
  readonly opts?: DatabaseOpts;
};

export interface DatabaseShape {
  readonly open: (input: OpenDatabaseInput) => Effect.Effect<DatabaseService, DatabaseError>;
}

export class Database extends Context.Tag('app/Database')<Database, DatabaseShape>() {}
```

- [ ] **Step 2: Create the barrel**

```ts
// src/application/ports/index.ts
export * from './Platform';
export * from './PathState';
export * from './PathResolver';
export * from './FileSystem';
export * from './Dialog';
export * from './Database';
```

- [ ] **Step 3: Typecheck** → clean. **Step 4: Commit** `git add src/application/ports/Database.ts src/application/ports/index.ts && git commit -m "feat(application): add Database port + ports barrel"`

---

## Task 8: TestPlatform layer

**Files:** Create `src/__tests__/support/TestPlatform.layer.ts`

- [ ] **Step 1: Implement** (a fixed desktop-like PlatformInfo)

```ts
// src/__tests__/support/TestPlatform.layer.ts
import { Effect, Layer } from 'effect';
import { Platform, type PlatformInfo } from '@/application/ports/Platform';

export const TEST_PLATFORM_INFO: PlatformInfo = {
  appPlatform: 'web',
  osPlatform: 'linux',
  hasTrafficLight: false,
  hasWindow: false,
  hasWindowBar: false,
  hasContextMenu: false,
  hasRoundedWindow: false,
  hasSafeAreaInset: false,
  hasHaptics: false,
  hasUpdater: false,
  hasOrientationLock: false,
  hasScreenBrightness: false,
  hasIAP: false,
  isMobile: false,
  isAppDataSandbox: false,
  isMobileApp: false,
  isAndroidApp: false,
  isIOSApp: false,
  isMacOSApp: false,
  isLinuxApp: false,
  isPortableApp: false,
  isDesktopApp: false,
  isAppImage: false,
  isEink: false,
  canCustomizeRootDir: false,
  canReadExternalDir: false,
  supportsCanvasContext2DFilter: true,
  distChannel: 'readest',
  storefrontRegionCode: null,
  isOnlineCatalogsAccessible: true,
};

export const TestPlatformLive = Layer.succeed(Platform, {
  info: Effect.succeed(TEST_PLATFORM_INFO),
});
```

- [ ] **Step 2: Typecheck** → clean. **Step 3: Commit** `git add src/__tests__/support/TestPlatform.layer.ts && git commit -m "test(application): add TestPlatform layer"`

---

## Task 9: TestFileSystem layer (in-memory) + test

**Files:** Create `src/__tests__/support/TestFileSystem.layer.ts`; Test `src/__tests__/application/testFileSystem.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/application/testFileSystem.test.ts
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { FileSystem } from '@/application/ports/FileSystem';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';

const run = <A>(program: Effect.Effect<A, unknown, FileSystem>): Promise<A> =>
  Effect.runPromise(
    program.pipe(Effect.provide(TestFileSystemLive)) as Effect.Effect<A, unknown, never>,
  );

describe('TestFileSystem (in-memory)', () => {
  it('writes then reads text back', async () => {
    const out = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        yield* fs.writeFile('a.txt', 'Books', 'hello');
        return yield* fs.readFile('a.txt', 'Books', 'text');
      }),
    );
    expect(out).toBe('hello');
  });

  it('exists reflects writes and removes', async () => {
    const [before, afterWrite, afterRemove] = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const b = yield* fs.exists('x.txt', 'Books');
        yield* fs.writeFile('x.txt', 'Books', 'v');
        const w = yield* fs.exists('x.txt', 'Books');
        yield* fs.removeFile('x.txt', 'Books');
        const r = yield* fs.exists('x.txt', 'Books');
        return [b, w, r] as const;
      }),
    );
    expect([before, afterWrite, afterRemove]).toEqual([false, true, false]);
  });

  it('copyFile duplicates content; readDir lists by prefix', async () => {
    const items = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        yield* fs.writeFile('dir/a.txt', 'Books', 'A');
        yield* fs.copyFile('dir/a.txt', 'Books', 'dir/b.txt', 'Books');
        return yield* fs.readDir('dir', 'Books');
      }),
    );
    expect(items.map((i) => i.path).sort()).toEqual(['dir/a.txt', 'dir/b.txt']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm exec vitest run src/__tests__/application/testFileSystem.test.ts`).

- [ ] **Step 3: Implement** the in-memory double. Key is `${base}::${path}`. Stores `string | ArrayBuffer`.

```ts
// src/__tests__/support/TestFileSystem.layer.ts
import { Effect, Layer } from 'effect';
import type { BaseDir, FileInfo, FileItem } from '@/domain/system';
import { FsError } from '@/application/errors/AppError';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';

const key = (base: BaseDir, path: string) => `${base}::${path}`;

const byteLength = (v: string | ArrayBuffer): number =>
  typeof v === 'string' ? new TextEncoder().encode(v).byteLength : v.byteLength;

export const TestFileSystemLive = Layer.effect(
  FileSystem,
  Effect.sync(() => {
    const store = new Map<string, string | ArrayBuffer>();

    const shape: FileSystemShape = {
      writeFile: (path, base, content) =>
        Effect.sync(() => {
          if (content instanceof File) {
            // Tests use string/ArrayBuffer; File is not exercised by the in-memory double.
            throw new FsError({
              operation: 'writeFile',
              path,
              cause: 'File not supported in TestFileSystem',
            });
          }
          store.set(key(base, path), content);
        }).pipe(
          Effect.catchAllDefect((cause) =>
            Effect.fail(new FsError({ operation: 'writeFile', path, cause })),
          ),
        ),
      readFile: (path, base) =>
        Effect.suspend(() => {
          const v = store.get(key(base, path));
          return v === undefined
            ? Effect.fail(new FsError({ operation: 'readFile', path, cause: 'ENOENT' }))
            : Effect.succeed(v);
        }),
      copyFile: (srcPath, srcBase, dstPath, dstBase) =>
        Effect.suspend(() => {
          const v = store.get(key(srcBase, srcPath));
          if (v === undefined)
            return Effect.fail(
              new FsError({ operation: 'copyFile', path: srcPath, cause: 'ENOENT' }),
            );
          store.set(key(dstBase, dstPath), v);
          return Effect.void;
        }),
      removeFile: (path, base) =>
        Effect.sync(() => {
          store.delete(key(base, path));
        }),
      createDir: () => Effect.void,
      removeDir: (path, base) =>
        Effect.sync(() => {
          const prefix = key(base, path);
          for (const k of store.keys())
            if (k === prefix || k.startsWith(`${prefix}/`)) store.delete(k);
        }),
      readDir: (path, base) =>
        Effect.sync<FileItem[]>(() => {
          const prefix = key(base, path);
          const items: FileItem[] = [];
          for (const [k, v] of store) {
            if (k.startsWith(`${prefix}/`)) {
              items.push({ path: k.slice(`${base}::`.length), size: byteLength(v) });
            }
          }
          return items;
        }),
      exists: (path, base) => Effect.sync(() => store.has(key(base, path))),
      stat: (path, base) =>
        Effect.suspend(() => {
          const v = store.get(key(base, path));
          return v === undefined
            ? Effect.fail(new FsError({ operation: 'stat', path, cause: 'ENOENT' }))
            : Effect.succeed<FileInfo>({
                isFile: true,
                isDirectory: false,
                size: byteLength(v),
                mtime: null,
                atime: null,
                birthtime: null,
              });
        }),
      openFile: (path) =>
        Effect.fail(
          new FsError({ operation: 'openFile', path, cause: 'not supported in TestFileSystem' }),
        ),
      getUrl: (path) => Effect.succeed(`mem://${path}`),
      getBlobUrl: (path, base) =>
        Effect.suspend(() =>
          store.has(key(base, path))
            ? Effect.succeed(`blob://${base}/${path}`)
            : Effect.fail(new FsError({ operation: 'getBlobUrl', path, cause: 'ENOENT' })),
        ),
    };

    return shape;
  }),
);
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/__tests__/support/TestFileSystem.layer.ts src/__tests__/application/testFileSystem.test.ts && git commit -m "test(application): add in-memory TestFileSystem + tests"`

---

## Task 10: TestPathResolver layer + test

**Files:** Create `src/__tests__/support/TestPathResolver.layer.ts`; Test `src/__tests__/application/testPathResolver.test.ts`

- [ ] **Step 1: Write the failing test** (resolver is PathState-aware: custom root prefixes the path)

```ts
// src/__tests__/application/testPathResolver.test.ts
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { PathResolver } from '@/application/ports/PathResolver';
import { PathState, PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';

const layer = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const run = <A>(program: Effect.Effect<A, unknown, PathResolver | PathState>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('TestPathResolver', () => {
  it('default: prefix is the base name', async () => {
    const p = await run(Effect.flatMap(PathResolver, (r) => r.prefix('Books')));
    expect(p).toBe('Books');
  });

  it('custom root: absolute joins root + base + path', async () => {
    const abs = await run(
      Effect.gen(function* () {
        const state = yield* PathState;
        yield* state.set({ customRootDir: '/root', isPortable: false });
        const r = yield* PathResolver;
        return yield* r.absolute('f.epub', 'Books');
      }),
    );
    expect(abs).toBe('/root/Books/f.epub');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// src/__tests__/support/TestPathResolver.layer.ts
import { Effect, Layer } from 'effect';
import type { BaseDir, ResolvedPath } from '@/domain/system';
import { PathResolver, type PathResolverShape } from '@/application/ports/PathResolver';
import { PathState } from '@/application/ports/PathState';

export const TestPathResolverLive = Layer.effect(
  PathResolver,
  Effect.gen(function* () {
    const state = yield* PathState;

    const prefix = (base: BaseDir) =>
      state.get.pipe(
        Effect.map((cfg) => (cfg.customRootDir ? `${cfg.customRootDir}/${base}` : `${base}`)),
      );

    const absolute = (path: string, base: BaseDir) =>
      prefix(base).pipe(Effect.map((p) => (path ? `${p}/${path}` : p)));

    const resolve = (path: string, base: BaseDir) =>
      prefix(base).pipe(
        Effect.map(
          (p): ResolvedPath => ({
            baseDir: 0,
            basePrefix: () => Promise.resolve(p),
            fp: path,
            base,
          }),
        ),
      );

    return { resolve, prefix, absolute } satisfies PathResolverShape;
  }),
);
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/__tests__/support/TestPathResolver.layer.ts src/__tests__/application/testPathResolver.test.ts && git commit -m "test(application): add TestPathResolver + tests"`

---

## Task 11: Test runtime + smoke test

**Files:** Create `src/runtime/test.ts`; Test `src/__tests__/application/testRuntime.test.ts`

- [ ] **Step 1: Write the failing smoke test** (proves the composed runtime provides every layer and a multi-port program runs)

```ts
// src/__tests__/application/testRuntime.test.ts
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { testRuntime } from '@/runtime/test';
import { Platform } from '@/application/ports/Platform';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { PathState } from '@/application/ports/PathState';

describe('testRuntime', () => {
  it('provides Platform, PathState, PathResolver, FileSystem together', async () => {
    const result = await testRuntime.runPromise(
      Effect.gen(function* () {
        const platform = yield* Platform;
        const info = yield* platform.info;
        const state = yield* PathState;
        yield* state.set({ customRootDir: '/r', isPortable: false });
        const resolver = yield* PathResolver;
        const abs = yield* resolver.absolute('book.epub', 'Books');
        const fs = yield* FileSystem;
        yield* fs.writeFile('book.epub', 'Books', 'data');
        const back = yield* fs.readFile('book.epub', 'Books', 'text');
        return { platform: info.appPlatform, abs, back };
      }),
    );
    expect(result).toEqual({ platform: 'web', abs: '/r/Books/book.epub', back: 'data' });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** (the program and the resolver MUST share one `PathState` ref — the smoke test sets the root via the program's `PathState` then reads it back through the resolver. `Layer.provideMerge(TestPathResolverLive, PathStateLive)` builds `PathStateLive` once and exposes BOTH `PathResolver` and `PathState` from it, so they share. Do NOT use `Layer.provide(...)` + a second `PathStateLive` in the merge — that gives the resolver its own ref and the smoke test would see `/Books/...` instead of `/r/Books/...`.)

```ts
// src/runtime/test.ts
import { Layer, ManagedRuntime } from 'effect';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';

// provideMerge: build PathStateLive once, expose both PathResolver AND PathState from it (shared ref).
const ResolverWithState = Layer.provideMerge(TestPathResolverLive, PathStateLive);

export const TestLayer = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, ResolverWithState);

export const testRuntime = ManagedRuntime.make(TestLayer);
```

- [ ] **Step 4: Run — expect PASS.** If `abs` comes back as `/Books/book.epub` (missing the `/r` root), the resolver and program are NOT sharing a `PathState` — re-check you used `provideMerge` (shared) and did not add a second `PathStateLive` to the `mergeAll`.

- [ ] **Step 5: Commit** `git add src/runtime/test.ts src/__tests__/application/testRuntime.test.ts && git commit -m "feat(runtime): add test runtime composing port layers"`

---

## Task 12: Full verification (Plan B done)

- [ ] **Step 1:** `pnpm exec vitest run src/__tests__/application src/__tests__/domain` → all PASS.
- [ ] **Step 2:** `pnpm exec tsgo --noEmit` → only pre-existing `upload-cjk-fonts-r2` error.
- [ ] **Step 3:** `pnpm exec biome check src/application src/runtime src/__tests__/application src/__tests__/support` → clean.
- [ ] **Step 4:** `pnpm test` → no new failures beyond the documented sandbox-flaky set (edgeTTS, opds-req, storage/config, runAuth-routes-under-load) + the two pre-existing lint errors.
- [ ] **Step 5:** Confirm `application/` and `runtime/` import only `@/domain/*`, `@/application/*`, and `effect` — never `@/services|store|styles|hooks|components|app|infra`:

```bash
grep -rnE "from '@/(services|store|styles|hooks|components|app|infra)" src/application src/runtime || echo "OK: application/runtime depend only on domain + effect"
```

## Done-conditions

- All Task tests pass; tsgo + biome clean (modulo the two pre-existing unrelated errors).
- Six port contracts + error taxonomy + `PathStateLive` + test runtime exist and are exercised by tests.
- No dependency on `infra`/platform code (that is Plan C).

## Risks

- **Layer composition for shared PathState** — addressed in Task 11 with the `provideMerge` fallback. If the first composition fails the smoke test, switch to the shared-state variant.
- **`File` in TestFileSystem** — intentionally unsupported (tests use string/ArrayBuffer); `writeFile(File)` and `openFile` fail with `FsError`. Real File handling lands in Plan C infra.
- **PlatformInfo field drift** — mirrors the current `AppService` boolean surface; if Plan C's real platform code needs a field not here, add it then (and to `TEST_PLATFORM_INFO`).
