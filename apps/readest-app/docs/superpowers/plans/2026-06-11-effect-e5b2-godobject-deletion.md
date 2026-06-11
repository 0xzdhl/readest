# E5b-2 — God-object deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ EXECUTION GATE:** This is the IRREVERSIBLE slice. Do NOT start until the user has confirmed the E5b-1 interactive app-run (shell renders, settings apply, PIN app-lock gate works, library loads, replica sync inits). Verify that confirmation exists before Task 1.

**Goal:** Delete the legacy god-objects (`appService`/`native`/`web`/`nodeAppService` classes, `environment.getAppService`, the `AppService` interface) and empty the §19.2 search gate — completing the client-side Effect migration.

**Architecture:** Sequenced **retype → unwire → delete** so every commit is green. The ~6 `AppService`-typed download surfaces are retyped to `FileWriter = Pick<FileSystem,'writeFile'>` (reusing the surviving legacy `FileSystem` interface); then `environment.getAppService` + lazy loaders go (nothing constructs the classes); then the 4 class files + their 5 tests + the `AppService` interface are deleted. `EnvConfigType` is left an empty `Record<string, never>` (513-site `envConfig` removal deferred to optional E5b-3).

**Tech Stack:** TypeScript (strict, no `any`), Effect, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-effect-e5b2-godobject-deletion-design.md`

**Verify after every code task:** `npx tsgo --noEmit 2>&1 | grep -v upload-cjk-fonts-r2 | grep 'error TS'` → empty.

---

## Task 1: `FileWriter` type + retype the 6 download surfaces

**Files:** `src/domain/system.ts`, `src/services/cloudService.ts`, `src/libs/storage.ts`, `src/app/opds/index.tsx`, `src/services/opds/autoDownload.ts`, `src/infra/shared/CloudService.layer.ts`

- [ ] **Step 1: Add `FileWriter` to `domain/system.ts`.** Immediately AFTER the `FileSystem` interface (closes at line ~69), add:

```ts
/**
 * Minimal write-only fs contract for libs/storage.downloadFile (which reaches
 * only writeFile). Reuses the legacy FileSystem.writeFile signature so there's
 * one source of truth. The AppService interface is gone (E5b-2); this is the
 * narrow shape its download consumers actually needed.
 */
export type FileWriter = Pick<FileSystem, 'writeFile'>;
```

- [ ] **Step 2: `cloudService.ts`** — change the import (line 1) from `import type { AppService, FileSystem, BaseDir, DeleteAction }` to `import type { FileWriter, FileSystem, BaseDir, DeleteAction }`. Change the 4 params `appService: AppService` (lines ~111, ~197, ~209, ~250) to `appService: FileWriter` (keep the param name to minimize the diff; its only use is `downloadFile({ appService, … })`).

- [ ] **Step 3: `storage.ts`** — change the import (line 2) `import type { AppService }` → `import type { FileWriter }` (add `from '@/domain/system'`). Change `DownloadFileParams.appService: AppService` (line ~179) → `appService: FileWriter`. (Only `.writeFile` is called at line ~228.)

- [ ] **Step 4: `app/opds/index.tsx`** (the `fsWriter` shim, ~line 122-130) — change `}) as unknown as AppService` → `}) as unknown as FileWriter`. Update the import (line 24) `import type { AppService, BaseDir }` → `import type { FileWriter, BaseDir }`.

- [ ] **Step 5: `services/opds/autoDownload.ts`** (the `writer` shim, ~line 33-37) — change `} as unknown as AppService;` → `} as unknown as FileWriter;`. Update the import (line 3) `import type { AppService, BaseDir }` → `import type { FileWriter, BaseDir }`.

- [ ] **Step 6: `infra/shared/CloudService.layer.ts`** (line ~27) — replace `const appService = fs as unknown as AppService;` with:

```ts
// `fs` is the legacy adapter; it has writeFile, so it satisfies FileWriter directly.
const writer: FileWriter = fs;
```

Then replace every later `appService` usage in this file's download calls (`downloadBook(appService, …)`, `downloadBookCovers(appService, …)`, `downloadCloudFile(appService, …)`, `downloadReplicaFileFromCloud(appService, …)`) with `writer`. Update the import (line 3) `import type { AppService, BaseDir }` → `import type { FileWriter, BaseDir }`.

- [ ] **Step 7: Verify + commit.**

Run: `grep -rnE ': AppService|as unknown as AppService|<AppService|, AppService|{ AppService' src --include=*.ts --include=*.tsx | grep -v __tests__ | grep -v 'interface AppService'`
Expected: empty (no code references the `AppService` type; the interface definition in `domain/system.ts` is the only remaining occurrence).
Run tsgo → empty.

```bash
git add src/domain/system.ts src/services/cloudService.ts src/libs/storage.ts src/app/opds/index.tsx src/services/opds/autoDownload.ts src/infra/shared/CloudService.layer.ts
git commit -m "refactor(effect): retype AppService download params to FileWriter (E5b-2)"
```

---

## Task 2: Unwire `environment.getAppService` + empty `EnvConfigType`

**Files:** `src/services/environment.ts`

- [ ] **Step 1: Rewrite the bottom of `environment.ts`.** Remove the `AppService` import (line 2), the `getNativeAppService`/`getWebAppService` lazy loaders + their module `let` singletons (lines ~47-65), and the `getAppService` field + impl. Replace `EnvConfigType` + `environmentConfig`:

```ts
// (delete: `import type { AppService } from '@/domain/system';`)
// (delete: the two `let nativeAppService`/`let webAppService` + getNativeAppService/getWebAppService blocks)

// EnvConfigType is now empty — getAppService is gone (E5b-2). The ~513 vestigial
// `envConfig` threading sites still compile against this; their removal is E5b-3.
export type EnvConfigType = Record<string, never>;

const environmentConfig: EnvConfigType = {};

export default environmentConfig;
```

Keep ALL the URL/platform helpers above (`isTauriAppPlatform`, `getBaseUrl`, `getAPIBaseUrl`, etc.) unchanged.

- [ ] **Step 2: Verify + commit.**

Run: `grep -rn 'getAppService' src --glob '!**/__tests__/**'`
Expected: empty.
Run tsgo → empty. (The `envConfig: EnvConfigType` params across ~78 files now type as `Record<string, never>`; `enableReplicaAutoPersist(env)` / `applyBackgroundTexture(envConfig, …)` / `updateBook(envConfig, …)` still accept the empty object. If any site dereferenced an `envConfig` PROPERTY it would error — but E5b-1 confirmed all uses are vestigial pass-through, so none should.)

```bash
git add src/services/environment.ts
git commit -m "refactor(effect): delete environment.getAppService + lazy loaders; EnvConfigType empty (E5b-2)"
```

---

## Task 3: Re-point `import-metahash.test.ts` off `BaseAppService`

**Files:** `src/__tests__/services/import-metahash.test.ts`

This test subclasses `BaseAppService` (`class TestAppService extends BaseAppService`) purely as a vehicle to drive `importBook` (which `BaseAppService.importBook` delegates to the pure `bookService.importBook(this.fs, …)`). It tests REAL metahash/dedup logic, not the god-object — so re-point it at the pure fn instead of deleting it. This MUST land before Task 4 deletes `appService.ts`.

- [ ] **Step 1: Read the test + the delegation.**

Run: `sed -n '30,130p' src/__tests__/services/import-metahash.test.ts` and `grep -n 'importBook' src/services/appService.ts src/services/bookService.ts`.
Establish: what `BaseAppService.importBook(file, books, opts)` forwards to `bookService.importBook` (args: `fs`, `file`, `books`, callbacks/opts), and what the `TestAppService` mocked (`this.fs`, `resolveFilePath`, `openDatabase`, etc.).

- [ ] **Step 2: Replace the `TestAppService extends BaseAppService` vehicle** with a direct call to `bookService.importBook` (import from `@/services/bookService`), passing the same mock `fs` the test already builds and the same `books`/`opts`. Remove `import { BaseAppService } from '@/services/appService';` and the `class TestAppService` definition; replace `service.importBook(...)` calls with `BookSvc.importBook(mockFs, ...)` matching the real signature. Preserve EVERY existing assertion (the metahash dedup / overwrite / hash-collision cases) — only the invocation vehicle changes.

- [ ] **Step 3: Run + commit.**

Run: `npx vitest run src/__tests__/services/import-metahash.test.ts` → PASS (same test count as before).
Run: `grep -n 'appService\|BaseAppService\|AppService' src/__tests__/services/import-metahash.test.ts` → empty.

```bash
git add src/__tests__/services/import-metahash.test.ts
git commit -m "test(effect): re-point import-metahash off BaseAppService to bookService.importBook (E5b-2)"
```

(If, on inspection, the test's coverage is genuinely 100% duplicated by an existing `bookService`/import test AND re-pointing is disproportionately complex, STOP and report — deletion may be acceptable, but default to re-pointing.)

---

## Task 4: Delete the 4 class files + their 5 god-object test files

**Files (delete):** `src/services/appService.ts`, `src/services/nativeAppService.ts`, `src/services/webAppService.ts`, `src/services/nodeAppService.ts`, `src/__tests__/services/app-service.test.ts`, `src/__tests__/services/node-app-service.test.ts`, `src/__tests__/services/tauri-app-service.tauri.test.ts`, `src/__tests__/services/web-app-service.test.ts`, `src/__tests__/services/web-app-service.browser.test.ts`

- [ ] **Step 1: Confirm nothing else imports the 4 class files.**

Run: `grep -rn "from '@/services/appService'\|from '@/services/nativeAppService'\|from '@/services/webAppService'\|from '@/services/nodeAppService'" src`
Expected: ONLY the 4 class files importing each other (`native`/`web`/`node` import `BaseAppService` from `appService`) + the 5 test files being deleted. If any OTHER file imports them, STOP — it's a missed consumer.

- [ ] **Step 2: Coverage check before deleting the 5 tests.** For each god-object test, confirm an equivalent Effect infra-layer test exists (the behavior was ported in E1–E3):
  - `tauri-app-service.tauri.test.ts` / fs+path → `src/__tests__/infra/tauriFileSystem.test.ts`, `tauriPathResolver.test.ts`, `tauriPlatform.test.ts`
  - `web-app-service*.test.ts` → `webPathResolver.test.ts` + the web layer tests + `clientRuntime.test.ts`
  - `app-service.test.ts` / `node-app-service.test.ts` → the shared-layer/asset tests (`fontService`/`imageService`/`dictionaryService`/`cloudService`/`bookRepository` etc.)

Run: `ls src/__tests__/infra/ src/__tests__/application/`. If a god-object test asserts a behavior NOT covered by any layer test, PORT that assertion into the relevant `*.layer.test.ts` (add it there) BEFORE deleting — do not silently lose coverage. Report any assertion you ported.

- [ ] **Step 3: Delete.**

```bash
git rm src/services/appService.ts src/services/nativeAppService.ts src/services/webAppService.ts src/services/nodeAppService.ts
git rm src/__tests__/services/app-service.test.ts src/__tests__/services/node-app-service.test.ts src/__tests__/services/tauri-app-service.tauri.test.ts src/__tests__/services/web-app-service.test.ts src/__tests__/services/web-app-service.browser.test.ts
```

- [ ] **Step 4: Verify + commit.**

Run tsgo → empty. Run: `grep -rn 'BaseAppService\|NativeAppService\|WebAppService\|NodeAppService' src --include=*.ts --include=*.tsx | grep -v __tests__` → only comments (cleaned in Task 5).

```bash
git commit -m "refactor(effect): delete the 4 god-object classes + their tests (E5b-2)"
```

---

## Task 5: Delete the `AppService` interface + comment cleanup

**Files:** `src/domain/system.ts`, plus parity-comment files (`src/infra/**`, `src/domain/book.ts`, `src/application/**`)

- [ ] **Step 1: Delete the `AppService` interface** from `src/domain/system.ts` (lines ~71–206, `export interface AppService { … }`). Keep `FileSystem` (53–69), the new `FileWriter`, `BaseDir`, `DeleteAction`, `FileItem`, `FileInfo`, `ResolvedPath`, `AppPlatform`, `OsPlatform`, `DistChannel`, `SelectDirectoryMode`, and every other surviving export.

Run: `grep -n 'AppService' src/domain/system.ts` → empty.

- [ ] **Step 2: Clean stale parity-comments** that match the §19.2 gate symbols. Find them:

Run: `grep -rn 'NativeAppService\|BaseAppService\|getAppService' src --include=*.ts --include=*.tsx | grep -v __tests__`
For each (e.g. `infra/tauri/TauriPlatform.layer.ts` "Mirrors NativeAppService field-by-field (nativeAppService.ts:423–461)", `domain/book.ts` "the AppService interface in types/system", `infra/shared/MigrationService.layer.ts` "Faithful port of AppService.migrate20251124"): reword to remove the deleted-symbol reference (e.g. "Mirrors the legacy native platform flags" / "the legacy app-service interface") — keep the intent, drop the dangling symbol/line-number. The CamelCase symbols (`NativeAppService`/`BaseAppService`/`getAppService`/`AppService`) must not remain in `src/` code.

- [ ] **Step 3: Verify + commit.**

Run: `grep -rn 'AppService' src --include=*.ts --include=*.tsx | grep -v __tests__` → empty.
Run tsgo → empty.

```bash
git add src/domain/system.ts src/infra src/domain/book.ts src/application
git commit -m "refactor(effect): delete AppService interface + clean stale parity-comments (E5b-2)"
```

---

## Task 6: Verify §19.2 gate + lint + test + memory

- [ ] **Step 1: §19.2 search gate (the done-condition).**

Run: `rg -n 'getAppService|BaseAppService|NativeAppService' src` (or `grep -rn`).
Expected: **no hits in `src/`** (CamelCase symbols all gone). Any lowercase `nativeAppService.ts:NNN` path-provenance left in a comment: if `rg` (case-sensitive by default on these CamelCase terms) returns it, trim it; if not matched, it's acceptable historical provenance — note which you left.

Run: `grep -rn 'AppService' src --include=*.ts --include=*.tsx | grep -v __tests__` → empty.

- [ ] **Step 2: Lint.** `pnpm lint` → only the pre-existing baseline errors (`upload-cjk-fonts-r2.ts`, `SettingsDialog.tsx` lazy). Confirm the empty `EnvConfigType = Record<string, never>` triggers no new lint.

- [ ] **Step 3: Tests.** `pnpm test` → green except the known env-flaky set. The 5 deleted class-test files are gone (the file/test counts drop — expected; note the new totals). Investigate any NEW failure.

- [ ] **Step 4: Update memory** `project_effect_client_foundation.md`: mark E5b-2 DONE (god-objects deleted, §19.2 gate empty, FileWriter retype, EnvConfigType empty) — the client-side strangler migration is COMPLETE. Note E5b-3 (the 513-site envConfig cleanup) remains optional, plus the originally-noted Node infra + arch-doc Server API.

```bash
git add docs/superpowers
git commit -m "docs(effect): record E5b-2 completion (god-objects deleted, migration complete)"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Task 1 = §2 FileWriter retype. Task 2 = §3 unwire. Task 3 = the `import-metahash` re-point (spec Risks). Task 4 = §4 class+test deletion (with the §Risks coverage check). Task 5 = §4 interface deletion + comment cleanup. Task 6 = §Verification.
- **Ordering is load-bearing:** Task 1 (retype) makes the `AppService` type unreferenced → Task 2 (unwire) makes the classes unconstructed → Task 3 (re-point the one test that subclasses `BaseAppService`) → Task 4 (delete classes+tests) → Task 5 (delete interface). Each commit green. Do NOT reorder.
- **Type consistency:** `FileWriter = Pick<FileSystem,'writeFile'>` (defined Task 1) is the type used in Tasks 1's retypes. `EnvConfigType = Record<string, never>` (Task 2).
- **The one careful, non-mechanical spot:** Task 3 (re-point, don't lose the metahash assertions) + Task 4 Step 2 (port any god-object-only assertion into a layer test before deleting). Everything else is mechanical retype/delete.
- **This is irreversible** — execution is gated on the user's E5b-1 app-run confirmation (see the header gate).
