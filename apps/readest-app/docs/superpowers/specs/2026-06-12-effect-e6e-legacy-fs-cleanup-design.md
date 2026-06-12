# E6e — Final legacy-fs cleanup (design)

**Date:** 2026-06-12
**Branch:** `effect/domain-type-migration`
**Predecessors:** E6a–E6d-2 (the `makeLegacyFsAdapter` removal arc). E6d-2 deleted
`bookService.ts` + `libraryService.ts`, leaving `makeLegacyFsAdapter` with **0
consumers**.

## Goal

Final cleanup of the legacy filesystem remnants now that the client-side Effect
strangler is complete. Delete the dead `makeLegacyFsAdapter` + `persistence.ts`,
and delete the legacy `FileSystem` **interface** from `@/domain/system` by
clearing its three remaining references (all vestigial or trivial). After E6e the
legacy god-object's filesystem interface is fully gone; only the deliberately-kept
narrow `FileWriter` contract and the port-shared value types remain.

This is the terminal slice of the E6 arc.

## Non-goals / explicitly untouched

- The Effect ports (`application/ports/FileSystem.ts` `FileSystemShape`,
  `PathResolver`, etc.), the infra layers, and all migrated services — unchanged.
- `FileWriter` is **kept** (deliberately — it is the narrow write-only contract
  `libs/storage.downloadFile` needs); it is only made **standalone** (no longer
  `Pick<FileSystem, 'writeFile'>`), with its exact shape preserved.
- The port-shared value types in `@/domain/system` — `AppPlatform`, `OsPlatform`,
  `BaseDir`, `DeleteAction`, `SelectDirectoryMode`, `DistChannel`, `ResolvedPath`,
  `FileItem`, `FileInfo`, `NativeTouchEventType` — **kept** (all still imported by
  the ports/consumers).
- `src/services/rsvp/persistence.ts` (a different module, re-exported by
  `rsvp/index.ts`) — untouched.
- The replica sync subsystem behavior — unchanged (only two never-used optional
  handler method _declarations_ are removed from an interface).

## Architecture / changes

### 1. Delete dead files (0 consumers)

- `src/infra/shared/fsPortAdapter.ts` — `makeLegacyFsAdapter`. Grep-confirmed 0
  consumers (E6d-2 cleared the last one).
- `src/services/persistence.ts` — `safeLoadJSON`/`safeSaveJSON`. 0 consumers (its
  last user `libraryService.ts` was deleted in E6d-2; the E6a Effect mirror
  `shared/json.ts` replaced it). No dedicated test.

### 2. Clear the legacy `FileSystem` interface's three references

The legacy `FileSystem` interface (`@/domain/system`) has exactly three importers
after the two deletions above:

- **`src/services/sync/replicaRegistry.ts`** — uses `FileSystem` only in two
  **vestigial** optional handler signatures:
  `postDownload?(replica: T, fs: FileSystem): Promise<void>` and
  `validateOnLoad?(replica: T, fs: FileSystem): Promise<{ unavailable?: boolean }>`.
  Grep confirms **no implementations and no call sites** anywhere. Remove both
  optional members; change the import from `{ BaseDir, FileSystem }` to
  `{ BaseDir }` (`BaseDir` is still used: `localBaseDir: BaseDir`).
- **`src/__tests__/services/import-metahash.test.ts`** — uses `FileSystem` only
  for `type MockFs = Record<keyof FileSystem, ReturnType<typeof vi.fn>>`. Retype
  to `type MockFs = Record<string, ReturnType<typeof vi.fn>>` (the file already
  does `as unknown as MockFs` on the factory return and the E6d-2 `fsLayerFromMock`
  adapter casts `mockFs` to a `Record<string, …>` internally, so no real safety is
  lost). Drop `import type { FileSystem } from '@/domain/system'`.
- **`FileWriter`** (in `@/domain/system` itself) — `Pick<FileSystem, 'writeFile'>`.
  Make standalone, preserving the exact method shape:
  ```ts
  export type FileWriter = {
    writeFile(path: string, base: BaseDir, content: string | ArrayBuffer | File): Promise<void>;
  };
  ```

### 3. Delete the legacy `FileSystem` interface

With the three references cleared, delete the entire `interface FileSystem { … }`
block from `src/domain/system.ts`. The four `FileWriter` consumers
(`libs/storage.ts` param, `cloud/cloudTransfers.ts` inline writer ×3,
`app/opds/index.tsx` cast, `services/opds/autoDownload.ts` cast) are unaffected —
`FileWriter`'s shape is identical before/after.

## Tests

- **`import-metahash.test.ts`** — the `MockFs` retype is the only change; all 16
  assertions + the `fsLayerFromMock` adapter + every mock stay as-is. Must stay
  green.
- **`replicaRegistry.test`** — removing two never-used optional interface members
  cannot affect behavior; must stay green.
- No persistence test exists (nothing to remove/repoint there).
- `FileWriter`'s consumers have layer/integration tests (cloud, opds, autoDownload)
  that exercise the write path — they validate the standalone `FileWriter`
  structurally (same shape).

## Verification (done-conditions)

1. **Grep gates:**
   - `rg "makeLegacyFsAdapter|fsPortAdapter" src` → empty; `ls src/infra/shared/fsPortAdapter.ts src/services/persistence.ts` → both gone.
   - `rg "services/persistence|from './persistence'" src` → only `src/services/rsvp/index.ts` (its own sibling — untouched).
   - `rg "interface FileSystem" src/domain/system.ts` → empty.
   - `rg "import[^;]*\bFileSystem\b[^;]*from '@/domain/system'" src` → empty (no
     legacy-interface importers remain; the Effect port `FileSystemShape` comes
     from `@/application/ports/FileSystem`, so it never matches this gate).
   - `rg "\bFileWriter\b" src` → still present in `libs/storage.ts`, `cloud/cloudTransfers.ts`, `app/opds/index.tsx`, `services/opds/autoDownload.ts`, and the `@/domain/system` definition.
2. `pnpm lint` — tsgo 0-new (only the `scripts/upload-cjk-fonts-r2.ts` baseline);
   Biome only the `SettingsDialog.tsx` `lazy` baseline.
3. `pnpm test` — `import-metahash` (16) + `replicaRegistry` + cloud/opds/autoDownload
   (FileWriter consumers) green; full suite green minus the known env/timer/sandbox
   flaky set (auth-page, useBookShortcuts, theme-store, ProgressBar, ReadingRuler,
   clientRuntime, edgeTTS, opds-req, hardcover) — none E6e-touched.

## Execution

Subagent-driven-development per the established template (per-task implementer →
spec-review → code-quality-review; whole-slice review before SHIP). Tasks:
(T1) delete `fsPortAdapter.ts` + `persistence.ts`; (T2) clear the 3 references
(replicaRegistry vestigial methods, import-metahash `MockFs` retype, `FileWriter`
standalone) + delete the `FileSystem` interface; (T3) full verification. Small
slice. Kept as-is on `effect/domain-type-migration`, not pushed.

## Sequencing context

E6e is the **final** E6 slice. After it, the entire `makeLegacyFsAdapter` removal
arc (E6a–E6e) is complete and the legacy filesystem god-object interface is gone.
Genuinely separate future work remains (per the project memory): web
`*.layer.test` IndexedDB coverage, Node infra, arch-doc Server API.
