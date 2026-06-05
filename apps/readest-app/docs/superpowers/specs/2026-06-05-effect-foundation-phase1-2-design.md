# Effect TS Foundation — Phase 1 + 2 Design

**Date:** 2026-06-05
**Status:** Approved (brainstorm) → pending implementation plan
**Scope:** Client-runtime foundation (ports/errors/runtimes) + Boot/Settings/Migration. One slice of the larger Effect TS rewrite described in the architecture doc.

---

## 0. Context

`readest-app` already uses `effect@3.21.2`. The **storage module** (`src/storage/*`) and `libs/crypto/md5` are already Effect-migrated (Context.Tag + Layer + Effect.gen established). A separate backend Effect migration is in flight (storage done, sync next).

The client still boots through `environmentConfig.getAppService()`, a god-object cluster:
`appService.ts` (420), `nativeAppService.ts` (648), `nodeAppService.ts` (440), `webAppService.ts` (418), `environment.ts` (77) — consumed by ~30 files.

`domain/` exists but is empty. `application/`, `infra/`, `runtime/` do not exist.

This design covers **Phase 1 (foundation ports + runtimes)** and **Phase 2 (Boot/Settings/Migration)** as a single additive, parallel, test-validated slice. It does **not** migrate consumers or delete the god-objects.

---

## 1. Decisions (locked during brainstorm)

| #   | Decision        | Choice                                                                                                                                                                  |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Slice           | Phase 1 + Phase 2                                                                                                                                                       |
| 2   | Coexistence     | **Parallel / test-validated.** Old `AppService` stays the live boot path, untouched. New layer validated by unit tests against a test runtime. No proof-point consumer. |
| 3   | Platform scope  | **Tauri + Web + Test** only. Node runtime/infra deferred.                                                                                                               |
| 4   | Type strategy   | **Full move into `domain/`, rewrite all consumer imports, no shims.**                                                                                                   |
| 5   | Infra fidelity  | **Port existing logic faithfully** into the new port shape; preserve platform edge-cases; same backing stores (Web stays IndexedDB, not new OPFS).                      |
| 6   | Migration scope | **Framework + version tracking + ported existing migration steps.** Executes only in the new runtime (test + future Boot wiring); not on the live boot path this slice. |
| 7   | React bridge    | **Deferred** (`EffectRuntimeProvider`/`useRunEffect`) to the first consumer phase (YAGNI — no consumers yet).                                                           |
| 8   | Database port   | **Included** (`TauriDatabase`/`WebDatabase` wrapping existing DB services).                                                                                             |

---

## 2. Scope boundary

### In scope

- `application/errors` — tagged error taxonomy
- `application/ports` — Platform, PathState, PathResolver, FileSystem, Dialog, Database
- `application/repositories/SettingsRepository`
- `application/services/MigrationService`
- `application/usecases` — `boot/BootApp`, `settings/{LoadSettings, SaveSettings, ChangeRootDirectory, ResetSettings}`
- `infra/tauri/*`, `infra/web/*`, `infra/shared/*` (platform-agnostic live layers) — logic ported faithfully from existing `nativeAppService`/`webAppService`, same backing stores
- `runtime/{client-web, client-tauri, test}`
- `__tests__/support/*` test layers
- **Type migration workstream:** move `types/{book,settings,system}.ts` → `domain/{book,settings,shared}` (+ capability types referenced by `Platform`), rewrite all consumer imports, delete old type files

### Out of scope (later phases)

- React bridge (`EffectRuntimeProvider`/`useRunEffect`)
- Node runtime / `infra/node`
- Library / Book / Sync / AI / Metadata / OPDS / TTS / Translator
- Migrating the **logic** of the 30 `getAppService()` consumers
- Deleting `appService`/`nativeAppService`/`nodeAppService`/`webAppService`/`environment.getAppService`

> The type move mechanically edits `import` lines in the 30 consumers (and elsewhere) — **import statements only**, no logic. This is the single place this additive slice reaches into existing files.

---

## 3. Architecture & dependency direction

```
runtime/*           composes infra layers into a ManagedRuntime
  └─ infra/{tauri,web,shared}   implement ports; port existing I/O logic verbatim
       └─ application/{ports,repositories,services,usecases,errors}
            └─ domain/{book,settings,shared}   pure types / rules
```

Forbidden directions: `domain → application/infra`, `application → infra/app`, `infra → app`.

**Key untangling — path resolution:**

- `PathState` (Ref-backed) holds `{ customRootDir?, execDir?, isPortable }`.
- `PathResolver` reads `PathState` + `Platform` to resolve a `(path, BaseDir)` → absolute/prefixed path.
- `FileSystem` performs pure I/O only.
- Eliminates the existing mutable `fs.resolvePath` reassignment on custom-root/portable changes; path config becomes explicit state.

**BootApp** (only init flow): load Platform info → load settings → seed `PathState` from `settings.customRootDir` → run migrations from `settings.migrationVersion`. Built and tested; **not** wired into live boot this slice.

---

## 4. File layout (new)

```
src/
├── domain/
│   ├── book/         (from types/book.ts)
│   ├── settings/     (from types/settings.ts)
│   └── shared/       (from types/system.ts: BaseDir, ResolvedPath, FileInfo, FileItem,
│                      OsPlatform, AppPlatform, DistChannel, …)
├── application/
│   ├── errors/AppError.ts
│   ├── ports/
│   │   ├── Platform.ts
│   │   ├── PathState.ts
│   │   ├── PathResolver.ts
│   │   ├── FileSystem.ts
│   │   ├── Dialog.ts
│   │   └── Database.ts
│   ├── repositories/SettingsRepository.ts
│   ├── services/MigrationService.ts
│   └── usecases/
│       ├── boot/BootApp.ts
│       └── settings/{LoadSettings,SaveSettings,ChangeRootDirectory,ResetSettings}.ts
├── infra/
│   ├── tauri/   (TauriPlatform|PathResolver|FileSystem|Dialog|Database.layer.ts)
│   ├── web/     (WebPlatform|PathResolver|FileSystem|Dialog|Database.layer.ts)
│   └── shared/  (SettingsRepository.layer.ts, MigrationService.layer.ts)
├── runtime/     (client-web.ts, client-tauri.ts, test.ts)
└── __tests__/support/ (TestPlatform|PathResolver|FileSystem|SettingsRepository.layer.ts)
```

---

## 5. Error model

Tagged errors via `Data.TaggedError` (consistent with existing `storage/errors.ts`):

```ts
// application/errors/AppError.ts
FsError        { operation, path?, cause }
PlatformError  { operation, cause }
DatabaseError  { operation, path?, cause }
SettingsError  { operation, cause }
MigrationError { operation, fromVersion, cause }
UserCancelled  { operation }
```

Semantic rules:

- absent-but-OK → `Option.none()`; absent-but-required → `FsError`.
- user cancels a dialog → `Dialog` returns `Option.none()` (selection) or `UserCancelled` (where a usecase needs the distinction).
- No `return false/null` for failure; no bare `throw` escaping infra; no `console.error`-as-error-handling. Infra maps platform-SDK throws at the boundary via `Effect.try`/`Effect.tryPromise`.

`BookError` is **not** in this slice (no book usecases) — lands with the Library/Book phase.

---

## 6. Port contracts (shape summary)

- **Platform** — `info: Effect<PlatformInfo>`; `PlatformInfo` carries the platform capability booleans currently spread across `BaseAppService` (isMobile/isDesktop/isAndroid/isIOS/isMacOS/isLinux/isWindows/isPortable/isEink, hasWindow/hasWindowBar/hasContextMenu/hasTrafficLight/hasSafeAreaInset/hasHaptics/hasUpdater/hasIAP, canCustomizeRootDir/canReadExternalDir/supportsCanvasContext2DFilter, appPlatform/osPlatform/distChannel/storefrontRegionCode/isOnlineCatalogsAccessible).
- **PathState** — Ref-backed `get/set/update` over `PathConfig`. `PathStateLive` is platform-agnostic and is defined next to the port in `application/ports/PathState.ts`; every runtime provides it.
- **PathResolver** — `resolve(path, base): Effect<ResolvedPath, FsError>`, `prefix(base): Effect<string, FsError>`, `absolute(path, base): Effect<string, FsError>`.
- **FileSystem** — openFile/readFile/writeFile/copyFile/removeFile/createDir/removeDir/readDir/exists/stat/getUrl/getBlobUrl, each `Effect<…, FsError>` (`exists` is error-free `Effect<boolean>`).
- **Dialog** — ask / selectDirectory / selectFiles / saveFile; `saveFile` returns `Effect<Option<string>, PlatformError>` (`Some(path)` success, `None` cancelled).
- **Database** — `open(input): Effect<DatabaseService, DatabaseError>` wrapping existing DB services.

Concrete shapes follow the architecture doc §8; types sourced from `@/domain/*` after the migration.

---

## 7. Infra fidelity requirements

Logic is **ported, not reinvented**. Preserve from `nativeAppService.ts`:

- `content://` file copy-to-cache (Android)
- iOS file-URI safe decode
- Android/iOS RemoteFile range-request avoidance
- Desktop RemoteFile → NativeFile fallback
- absolute-path `readDir` via Rust `invoke('read_dir')`, JS-recursive fallback

Web (`webAppService.ts`): **same IndexedDB backing store** as today (no OPFS migration). BaseDir → store mapping preserved so a future consumer migration sees identical data.

The port _interface_ and _error model_ are new; the _I/O behavior_ is the proven existing behavior.

---

## 8. Type-migration mechanics (cross-cutting, sequenced first)

1. Move definitions: `types/book.ts → domain/book/`, `types/settings.ts → domain/settings/`, `types/system.ts → domain/shared/` (platform-capability enums/unions like `AppPlatform`/`OsPlatform`/`DistChannel` go to `domain/shared`; the `Platform` **port** lives in `application/ports`).
2. Rewrite every importer `@/types/{book,settings,system}` → `@/domain/...` across `src/` (mechanical, codemod-style).
3. Delete old `types/{book,settings,system}.ts` (no shims).
4. Gate: `pnpm lint` (tsgo typecheck) green — zero unresolved imports — before any new Effect code is layered on top.

This move is its own commit and proves the app still typechecks/tests green (pure refactor) before ports are built on it.

---

## 9. Testing & verification

Test-first (repo rule). New `runtime/test.ts` + `__tests__/support/Test*.layer.ts`. Coverage = the architecture-doc §19.3 gate:

- **PathResolver (Tauri):** custom-root / portable / default — three resolution modes
- **FileSystem:** read / write / copy / remove / readDir round-trips against `TestFileSystem`
- **Dialog:** cancel → `Option.none()` / `UserCancelled`
- **SettingsRepository:** load (absent → defaults/`Option.none()`), save round-trip, parse error → `SettingsError`
- **MigrationService:** `migrationVersion` advances; ported steps run in order
- **BootApp:** load settings → seed `PathState` → run migrations (end-to-end on test runtime)

### Done-conditions (repo verification rules)

- `pnpm test` green
- `pnpm lint` (Biome + tsgo) green
- Web and Tauri runtimes each compile independently
- Rust/Lua untouched → `fmt:check`/`clippy:check`/`test:lua` N/A

### Checkpoints

- **A:** type migration committed, full suite green (pure refactor).
- **B:** ports + infra + runtimes + Boot/Settings/Migration committed, §19.3 tests green.

---

## 10. Risks

- **Type-move blast radius** — large mechanical change. Mitigated by sequencing it first, isolating it in its own commit (Checkpoint A), and gating on a green typecheck before any new logic.
- **Infra divergence** — reinvented I/O could diverge from live behavior/data. Mitigated by Decision 5 (port verbatim, same backing stores).
- **Two boot paths coexisting** — accepted for this slice; old path remains authoritative, new `BootApp` runs only in tests until a later phase wires it in.
- **Collision with backend sync migration** — out of scope here; this slice touches no sync code.

```

```
