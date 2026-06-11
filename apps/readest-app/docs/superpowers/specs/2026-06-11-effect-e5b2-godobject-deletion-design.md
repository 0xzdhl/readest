# E5b-2 — God-object deletion (the strangler's final cut)

**Branch:** `effect/domain-type-migration`
**Status:** design approved 2026-06-11
**Predecessors:** E1–E5a, E5b-1 — all done. After E5b-1: `getAppService` is called by nothing (only its definition in `environment.ts`); no consumer reads `appService`; the `AppService` _type_ survives only on a handful of download-param/cast surfaces.
**Gated on:** the user's E5b-1 interactive app-run confirmation (PIN gate / sync profile / authed library) — this slice does the IRREVERSIBLE deletes, so do not execute until that passes.
**Successor:** E5b-3 (optional) — the 513-site/78-file `EnvConfigType`/`envConfig` cosmetic removal (left as empty-`{}` debt by this slice).

## Goal

Delete the legacy god-objects and empty the §19.2 search gate — the final cut that completes the client-side Effect migration. Surgical: ~10 source files touched + ~5 test files deleted, sequenced **retype → unwire → delete** so every commit stays green. Does NOT remove `envConfig` threading (deferred to E5b-3); `EnvConfigType` is reduced to an empty type the 513 vestigial sites still compile against.

In scope:

- **`FileWriter` retype** — replace the ~6 remaining `AppService`-typed download params/casts with a minimal `FileWriter = Pick<FileSystem, 'writeFile'>`.
- **Unwire** — delete `environment.getAppService` + `getNativeAppService`/`getWebAppService` + the lazy singletons; reduce `EnvConfigType` to `Record<string, never>`.
- **Delete** — the 4 class files (`appService`/`nativeAppService`/`webAppService`/`nodeAppService`), their 5 test files, the `AppService` interface in `domain/system.ts`, and the stale parity-comments referencing the deleted files.
- **Verify** the §19.2 gate is empty.

Out of scope → **E5b-3 (optional)**:

- Full `EnvConfigType`/`envConfig` removal (513 refs / 78 files — every store/helper/caller that threads the now-empty `envConfig`). Purely cosmetic; no behavior. `EnvConfigType` is left as `Record<string, never>`.

## Why this shape (decision log)

- **`FileWriter = Pick<FileSystem, 'writeFile'>`.** `libs/storage.downloadFile` is the only place the `appService` download-param is dereferenced, and it calls exactly one method: `writeFile(dst, 'None', …)`. The surviving legacy `FileSystem` interface (`domain/system.ts`, kept because it's `makeLegacyFsAdapter`'s return type) already declares `writeFile(path, base, content): Promise<void>` — so `Pick<FileSystem, 'writeFile'>` reuses it with zero new surface. (Considered: a fresh standalone interface — rejected; `Pick` keeps one source of truth.) The two writer shims (`opds/index`, `autoDownload`) and the `CloudService.layer` legacy adapter all structurally satisfy `FileWriter` (they have `writeFile`), so their `as unknown as AppService` casts narrow to `as FileWriter` (the layer's `fs` needs no `unknown` at all).
- **Retype before delete.** Once the ~6 surfaces are `FileWriter`, the `AppService` _type_ has no remaining references, so deleting the interface is a clean no-op for consumers. Likewise, deleting `environment.getAppService` first makes the 4 classes unconstructed → deleting the class files is a clean no-op. Sequence: retype → unwire → delete, each green.
- **Delete the 5 god-object class tests (with coverage rationale).** `app-service`/`node-app-service`/`tauri-app-service.tauri`/`web-app-service`(×2) test the legacy classes' fs/dialog/database/platform behavior. That behavior was _faithfully ported_ (per the E1–E3 specs) into the Effect infra layers — `TauriFileSystem.layer`/`WebFileSystem.layer`/`Tauri|WebDialog.layer`/`Tauri|WebDatabase.layer`/`Tauri|WebPlatform.layer`/`*PathResolver.layer` — which have their own tests (`tauriFileSystem`/`tauriPathResolver`/`tauriPlatform`/`webPathResolver`/`clientRuntime` etc.). Deleting code means deleting its tests; the coverage lives in the port-layer tests. (`import-metahash.test.ts` is inspected separately — it likely tests metahash logic via an appService vehicle; keep the test, strip the god-object usage or point it at the pure fn.)
- **EnvConfigType → empty, not removed.** Removing `getAppService` empties the interface. Reduce it to `export type EnvConfigType = Record<string, never>` (avoids biome's empty-interface lint) and stop there — the 513 `envConfig` sites compile against it harmlessly. The full removal is E5b-3 (a flag-sweep-style mechanical pass), kept separate so this milestone stays small and the irreversible deletes aren't entangled with a 513-site churn.

## Components & sequence

### 1. `FileWriter` + retype (commit 1)

- `domain/system.ts`: add `export type FileWriter = Pick<FileSystem, 'writeFile'>;`.
- `services/cloudService.ts`: the 4 fns `downloadReplicaFileFromCloud`/`downloadCloudFile`/`downloadBookCovers`/`downloadBook` — `appService: AppService` → `appService: FileWriter` (rename the local to `writer` optionally; keep arg name for minimal diff). Update the `AppService` import → `FileWriter`.
- `libs/storage.ts`: `DownloadFileParams.appService: AppService` → `FileWriter`; import `FileWriter`. (Only `.writeFile` is used at line ~228.)
- `app/opds/index.tsx:127` + `services/opds/autoDownload.ts:37`: the `{ writeFile … } as unknown as AppService` shims → `as FileWriter` (or drop the cast — the object literal already matches `FileWriter`). Update imports (`AppService` → `FileWriter`, keep `BaseDir`).
- `infra/shared/CloudService.layer.ts:27`: `const appService = fs as unknown as AppService;` → `const writer: FileWriter = fs;` (the legacy adapter has `writeFile`); pass `writer` where the fns took `appService`. Update import.
- Verify: `grep -rnE ': AppService|as unknown as AppService|<AppService' src --include=*.ts --include=*.tsx | grep -v __tests__` → empty.

### 2. Unwire constructors (commit 2)

- `services/environment.ts`: delete `getAppService` (interface field + impl), `getNativeAppService`, `getWebAppService`, the `let nativeAppService`/`let webAppService` singletons, and the `AppService` import. `EnvConfigType` → `export type EnvConfigType = Record<string, never>;`. Keep all URL/platform helpers + `environmentConfig` default export (now `{}`).
- Verify: `grep -rn 'getAppService' src --glob '!**/__tests__/**'` → empty. tsgo green (the 513 `envConfig: EnvConfigType` sites still typecheck against `Record<string, never>`; `enableReplicaAutoPersist(env)` etc. still pass the `{}` env).

### 3. Delete (commit 3)

- Delete files: `services/appService.ts`, `services/nativeAppService.ts`, `services/webAppService.ts`, `services/nodeAppService.ts`.
- Delete tests: `__tests__/services/app-service.test.ts`, `node-app-service.test.ts`, `tauri-app-service.tauri.test.ts`, `web-app-service.test.ts`, `web-app-service.browser.test.ts`. Inspect `import-metahash.test.ts`: keep it, remove its god-object import (point at the pure `bookService`/metahash fn or a minimal stub).
- `domain/system.ts`: delete the `AppService` interface (lines ~71–206). Keep `FileSystem`, `BaseDir`, `DeleteAction`, `FileItem`, `FileInfo`, `ResolvedPath`, `AppPlatform`, `OsPlatform`, `DistChannel`, `SelectDirectoryMode`, and the new `FileWriter`.
- Comment cleanup: edit/remove the parity-comments that match `NativeAppService`/`BaseAppService`/`getAppService` (e.g. `TauriPlatform.layer.ts` "Mirrors NativeAppService field-by-field", `domain/book.ts` AppService mentions) so the gate returns only docs. Lowercase path refs (`nativeAppService.ts:197`) in infra comments may stay as historical provenance OR be trimmed — the gate regex is the arbiter (see Verification).

### Verification (done-conditions)

- §19.2 gate: `rg "getAppService|BaseAppService|NativeAppService" src` → **no hits in `src/` code** (only `docs/superpowers/**` migration docs). Decide during impl whether lowercase `nativeAppService.ts:NNN` provenance comments count — if the gate is case-sensitive on the CamelCase symbols, those lowercase path mentions are fine; otherwise trim them.
- `grep -rn 'AppService' src --include=*.ts --include=*.tsx | grep -v __tests__` → empty (no `AppService` type/interface/class anywhere).
- `pnpm lint` (tsgo + biome): only the pre-existing baseline errors (and confirm the empty `EnvConfigType` doesn't trip a new lint).
- `pnpm test`: green except the known env-flaky set; the 5 deleted class-test files are gone (test count drops accordingly — expected).
- No Rust/Lua touched.

## Risks

- **The 5 deleted tests are real coverage of platform fs/dialog/db.** Before deleting each, confirm an equivalent infra-layer test exists (`tauriFileSystem`/`tauriPathResolver`/`tauriPlatform`/`webPathResolver`/`clientRuntime`/asset-service tests). If a behavior was ONLY covered by a god-object test (not by a port-layer test), port that assertion to the relevant `*.layer.test.ts` rather than losing it. This is the one place to be careful, not mechanical.
- **`import-metahash.test.ts`** may exercise real import logic through the god-object; re-point it at the pure fn, don't just delete it (it's not a god-object test).
- This is the IRREVERSIBLE slice — execute only after the E5b-1 app-run gate passes.
