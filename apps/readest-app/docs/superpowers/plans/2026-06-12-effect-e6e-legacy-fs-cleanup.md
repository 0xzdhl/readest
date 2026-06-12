# E6e — Final legacy-fs cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the dead `makeLegacyFsAdapter` (`fsPortAdapter.ts`) + `persistence.ts`, clear the legacy `FileSystem` interface's three remaining references, and delete that interface from `@/domain/system` — completing the E6 `makeLegacyFsAdapter` removal arc.

**Architecture:** Pure subtraction. Two 0-consumer files deleted; two vestigial `replicaRegistry` interface members removed; one test type retyped; `FileWriter` made standalone (same shape); the legacy `FileSystem` interface deleted. No behavior changes; the port-shared value types and the narrow `FileWriter` contract remain.

**Tech Stack:** TypeScript (strict, ES2022), Effect TS, Vitest. Spec: `docs/superpowers/specs/2026-06-12-effect-e6e-legacy-fs-cleanup-design.md`.

---

## File Structure

- **Delete** `src/infra/shared/fsPortAdapter.ts`, `src/services/persistence.ts`.
- **Modify** `src/services/sync/replicaRegistry.ts` (drop `LifecycleHooks` + `lifecycle?` field + `FileSystem` import).
- **Modify** `src/__tests__/services/import-metahash.test.ts` (retype `MockFs`, drop legacy `FileSystem` import).
- **Modify** `src/domain/system.ts` (standalone `FileWriter`; delete `FileSystem` interface).

Test-run command: `pnpm test run <path>`.

---

## Task 1: Delete the two dead files

**Files:**

- Delete: `src/infra/shared/fsPortAdapter.ts`, `src/services/persistence.ts`

- [ ] **Step 1: Confirm 0 consumers before deleting**

Run:

```bash
rg -n "makeLegacyFsAdapter|fsPortAdapter" src
rg -n "services/persistence" src ; rg -rn "from '\./persistence'" src/services
```

Expected: the first → empty. The second → ONLY `src/services/rsvp/index.ts` (`export * from './persistence'`, which resolves to its OWN sibling `src/services/rsvp/persistence.ts`, NOT the top-level file being deleted). If anything else references the top-level `@/services/persistence` or `makeLegacyFsAdapter`, STOP and report.

- [ ] **Step 2: Delete**

```bash
git rm src/infra/shared/fsPortAdapter.ts src/services/persistence.ts
```

- [ ] **Step 3: Type-check (nothing should break — 0 consumers)**

Run: `pnpm exec tsgo --noEmit`
Expected: ONLY the pre-existing baseline error `scripts/upload-cjk-fonts-r2.ts(133,…)`. If any error references the deleted files, STOP and report (a consumer was missed).

- [ ] **Step 4: Commit**

```bash
git add -A
CI=true git commit -m "refactor(effect): E6e delete dead makeLegacyFsAdapter + persistence.ts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Clear the 3 references + delete the legacy `FileSystem` interface

**Files:**

- Modify: `src/services/sync/replicaRegistry.ts`
- Modify: `src/__tests__/services/import-metahash.test.ts`
- Modify: `src/domain/system.ts`

- [ ] **Step 1: `replicaRegistry.ts` — drop the vestigial `LifecycleHooks` + `FileSystem` import.**

Change the import on line 2 from:

```typescript
import type { BaseDir, FileSystem } from '@/domain/system';
```

to:

```typescript
import type { BaseDir } from '@/domain/system';
```

Delete the entire `LifecycleHooks` interface (the block):

```typescript
export interface LifecycleHooks<T> {
  postDownload?(replica: T, fs: FileSystem): Promise<void>;
  validateOnLoad?(replica: T, fs: FileSystem): Promise<{ unavailable?: boolean }>;
}
```

And delete the `lifecycle?` field from `ReplicaAdapter` (one line):

```typescript
  lifecycle?: LifecycleHooks<T>;
```

(Both `LifecycleHooks` and the `lifecycle` field are vestigial — grep confirms no implementations, no assignments, and no reads anywhere in `src`. `BaseDir` stays — still used by `localBaseDir: BaseDir`.)

- [ ] **Step 2: `import-metahash.test.ts` — retype `MockFs`, drop the legacy import.**

Delete line 3:

```typescript
import type { FileSystem } from '@/domain/system';
```

Change the `MockFs` type alias (around line 47) from:

```typescript
type MockFs = Record<keyof FileSystem, ReturnType<typeof vi.fn>>;
```

to:

```typescript
type MockFs = Record<string, ReturnType<typeof vi.fn>>;
```

(The factory `makeMockFs` returns `… as unknown as MockFs` and the `fsLayerFromMock` adapter casts `mockFs` to a `Record<string, …>` internally, so the string-keyed record is sufficient — no real type safety is lost for this test.)

- [ ] **Step 3: `src/domain/system.ts` — standalone `FileWriter`, delete the `FileSystem` interface.**

Replace the entire `export interface FileSystem { … }` block AND the trailing `export type FileWriter = Pick<FileSystem, 'writeFile'>;` (keep the explanatory comment, lightly reworded) with just the standalone `FileWriter`:

```typescript
/**
 * Minimal write-only fs contract for libs/storage.downloadFile (which reaches
 * only writeFile). The legacy FileSystem god-object interface is gone (E6e);
 * this is the narrow write contract its download consumers actually need.
 */
export type FileWriter = {
  writeFile(path: string, base: BaseDir, content: string | ArrayBuffer | File): Promise<void>;
};
```

Leave every other export in `src/domain/system.ts` untouched (`AppPlatform`, `OsPlatform`, `BaseDir`, `DeleteAction`, `SelectDirectoryMode`, `DistChannel`, `ResolvedPath`, `FileItem`, `FileInfo`, `NativeTouchEventType`). Note: after deleting the `FileSystem` interface, `FileItem` / `FileInfo` / `ResolvedPath` may no longer be referenced _within_ `system.ts` itself, but they are still imported by the Effect ports (`application/ports/*`), so they must remain exported.

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsgo --noEmit`
Expected: ONLY the `scripts/upload-cjk-fonts-r2.ts` baseline. The four `FileWriter` consumers (`libs/storage.ts`, `cloud/cloudTransfers.ts`, `app/opds/index.tsx`, `services/opds/autoDownload.ts`) must still type-check (the standalone `FileWriter` has the identical method shape). If any error appears, fix it faithfully (the `FileWriter` shape must match `writeFile(path: string, base: BaseDir, content: string | ArrayBuffer | File): Promise<void>` exactly) and report.

- [ ] **Step 5: Run the affected tests**

Run:

```bash
pnpm test run src/__tests__/services/import-metahash.test.ts src/__tests__/services/sync/replicaRegistry.test.ts
```

Expected: PASS — import-metahash all 16 assertions (the `MockFs` retype is type-only; runtime mocks unchanged); replicaRegistry green (removing unused interface members cannot change behavior).

- [ ] **Step 6: Commit**

```bash
git add -A
CI=true git commit -m "refactor(effect): E6e delete legacy FileSystem interface; FileWriter standalone

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Grep gates** (report actual output of each):

```bash
rg -n "makeLegacyFsAdapter|fsPortAdapter" src
```

→ expected EMPTY.

```bash
ls src/infra/shared/fsPortAdapter.ts src/services/persistence.ts 2>&1
```

→ expected "No such file or directory" for both.

```bash
rg -n "interface FileSystem" src/domain/system.ts
```

→ expected EMPTY (interface deleted).

```bash
rg -n "import[^;]*\bFileSystem\b[^;]*from '@/domain/system'" src
```

→ expected EMPTY (no legacy-interface importers; the Effect port `FileSystemShape` is from `@/application/ports/FileSystem`, never matches).

```bash
rg -ln "\bFileWriter\b" src
```

→ expected: `src/domain/system.ts` (def) + `src/libs/storage.ts` + `src/application/services/cloud/cloudTransfers.ts` + `src/app/opds/index.tsx` + `src/services/opds/autoDownload.ts` (FileWriter still alive, standalone).

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: tsgo only the `scripts/upload-cjk-fonts-r2.ts` baseline; Biome only the `SettingsDialog.tsx` `lazy` baseline. No new errors. (In particular, no `noEmptyInterface`/unused-type-param warning — `LifecycleHooks` was deleted, not left empty.)

- [ ] **Step 3: FileWriter-consumer + affected test surface**

Run:

```bash
pnpm test run src/__tests__/services/import-metahash.test.ts src/__tests__/services/sync/replicaRegistry.test.ts src/__tests__/application/cloudService.test.ts src/__tests__/services/cloud-service.test.ts src/__tests__/services/opds-auto-download.test.ts
```

Expected: all PASS (the cloud/autoDownload tests exercise the `FileWriter` write path).

- [ ] **Step 4: Full suite**

Run: `pnpm test run`
Expected: green except the known env/timer/sandbox-flaky set (auth-page, useBookShortcuts, theme-store, ProgressBar, ReadingRuler, clientRuntime, edgeTTS, opds-req, hardcover — varies run-to-run). Confirm NO new failures attributable to E6e (anything touching domain/system, replica, import, or FileWriter consumers). Run any uncertain failer in isolation to confirm it passes alone (flaky) and does not import the deleted/changed surface.

- [ ] **Step 5: (No commit — verification only.)** If all gates pass, the slice — and the entire E6 arc — is complete.

---

## Done-conditions (whole slice)

1. `fsPortAdapter.ts` + `persistence.ts` deleted; `rg "makeLegacyFsAdapter|fsPortAdapter" src` empty.
2. Legacy `FileSystem` interface gone from `src/domain/system.ts`; `rg "import[^;]*\bFileSystem\b[^;]*from '@/domain/system'" src` empty.
3. `FileWriter` standalone and still resolving for its 4 consumers (storage/cloud/opds/autoDownload).
4. `replicaRegistry` `LifecycleHooks` + `lifecycle?` field removed; `replicaRegistry`/`import-metahash` tests green.
5. `pnpm lint` 0-new; full suite green minus the known flaky set.
