# Effect Foundation — Sub-slice E1: React Bridge + Migrate Already-Portable Consumers

**Date:** 2026-06-08
**Status:** Approved (brainstorm) → pending implementation plan
**Scope:** The first executable step of "full strangler + consumer migration": build the React/runtime bridge and migrate the 30 consumers that depend only on already-built ports. Decomposed from the larger goal (the remaining 18 consumers + boot-authority flip + god-object deletion follow in later slices, as they need Book/Library/Sync/Cover usecases).

---

## 0. Context

Plans A–D delivered the Effect foundation (domain/, ports, infra/tauri+web, client runtimes, BootApp/Settings/Migration) — all **additive**; the legacy `AppService` (via `environmentConfig.getAppService()` / `useEnv().appService`) is still the live boot path and the only thing ~50 files consume. The client runtimes (`tauriClientRuntime`/`webClientRuntime`) exist but are **unused in React**.

Consumer analysis (50 files): **30 migratable now** (22 use only ported capabilities; 8 platform-only), **18 blocked** on Book/Library/Sync/Cover usecases (later slices), **2 no-ops**. This slice migrates the 30.

App entry: **TanStack Router**, root `src/app/__root.tsx` → `<EnvProvider>` → `<Providers>`. Platform selected via `isTauriAppPlatform()` (`clientEnv.VITE_APP_PLATFORM`). Boot is client-only (SSR-guarded). Platform booleans (`appService.isMobile` etc.) are read **synchronously** in render.

---

## 1. Decisions (locked during brainstorm)

| #   | Decision           | Choice                                                                                                                                                                                      |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cut                | Decompose the big goal; this slice = bridge + migrate the 30 already-portable consumers only                                                                                                |
| 2   | Boot authority     | `BootApp` runs at startup **observe-only**; does NOT replace legacy boot or gate the shell. Migration-authority flip deferred to a later slice.                                             |
| 3   | Runtime access     | A module-level singleton `getClientRuntime()` (platform-selected, SSR-guarded) for non-React consumers; a React provider/hook wrapping the same singleton for components                    |
| 4   | Sync platform info | Bridge exposes `getPlatformInfo()` / `usePlatformInfo()` returning a cached `PlatformInfo` synchronously (port `Platform.info` is `Effect.sync`), because consumers read booleans in render |
| 5   | Coexistence        | Migrated + non-migrated consumers share the same files/`settings.json` via the same underlying logic (`SettingsRepository` reuses `settingsService`) — no divergence                        |
| 6   | Execution          | Bridge + one exemplar migration sequential & reviewed; remaining ~28 files fan out via a parallel Workflow; final verification sweep                                                        |

---

## 2. Scope boundary

### In scope

- `src/runtime/clientRuntime.ts` — `getClientRuntime()` singleton + `getPlatformInfo()` (sync, cached)
- `src/context/EffectRuntimeProvider.tsx` — provider + `useRunEffect()` + `usePlatformInfo()`; runs `BootApp` once (observe-only)
- Mount the provider in `src/app/__root.tsx`
- Migrate the **30 already-portable consumers** off `appService.<member>` to the ports/usecases/`getPlatformInfo()`
- Tests: bridge unit tests; the migrated consumers keep their existing tests green

### Out of scope (later slices)

- The 18 blocked consumers (need Book/Library/Sync/Cover usecases)
- Flipping migration/settings/boot authority to `BootApp` (legacy boot stays authoritative)
- Deleting `AppService`/`BaseAppService`/`Native`/`Web`/`Node` god-objects
- Node runtime

---

## 3. The 30 target consumers

**Platform-only (8)** — migrate `appService.<bool>` → `getPlatformInfo().<bool>` / `usePlatformInfo()`:
`app/error.tsx`, `app/user/index.tsx`, `components/Button.tsx`, `components/settings/FontPanel.tsx`, `hooks/useSafeAreaInsets.ts`, `store/trafficLightStore.ts`, `utils/misc.ts`, `utils/nav.ts`

**Migratable-now (22)** — use only ported caps (Platform/Settings/FileSystem/Dialog/Database):
`app/library/components/MigrateDataWindow.tsx`, `app/library/hooks/useDragDropImport.ts`, `app/reader/components/notebook/AIAssistant.tsx`, `app/reader/components/sidebar/ChatHistoryView.tsx`, `app/reader/hooks/useAutoSaveBookCover.ts`, `components/Providers.tsx`, `components/UpdaterWindow.tsx`, `components/metadata/BookDetailEdit.tsx`, `hooks/useResetSettings.ts`, `libs/storage.ts`, `services/annotation/providers/foliate.ts`, `services/hardcover/HardcoverSyncMapStore.ts`, `services/opds/subscriptionState.ts`, `services/sync/migrateLegacy.ts`, `services/sync/replicaBinaryUpload.ts`, `services/sync/replicaCursorStore.ts`, `store/customDictionaryStore.ts`, `store/customFontStore.ts`, `store/customTextureStore.ts`, `store/settingsStore.ts`, `store/themeStore.ts`, `utils/files.ts`

> The plan will RE-VERIFY each file's exact `appService.*` usage at migration time (the analysis is a guide, not gospel). Any file that turns out to touch a blocked capability is bumped to a later slice and logged — no silent partial migration.

---

## 4. Architecture

```
React components ──useRunEffect()/usePlatformInfo()──┐
non-React modules ──getClientRuntime()/getPlatformInfo()──┤
                                                          ▼
                                          runtime/clientRuntime.ts (singleton)
                                            selects tauri|web client runtime
                                                          ▼
                                          infra/{tauri,web} layers (Plans C/D)
```

- **`getClientRuntime()`**: returns `isTauriAppPlatform() ? tauriClientRuntime : webClientRuntime`. SSR guard: throws (or returns a noop) if `typeof window === 'undefined'`. Memoized.
- **`getPlatformInfo()`**: `getClientRuntime().runSync(Platform.info)` cached in a module variable (the layer's `info` is `Effect.sync`, so `runSync` is valid). Returns `PlatformInfo`.
- **`EffectRuntimeProvider`**: on mount (client-only `useEffect`), runs `getClientRuntime().runPromise(BootApp)`, stores `{platform, settings}` in context (observe-only — logged, not gating). Exposes `runtime`, `platformInfo` (sync), `useRunEffect`, `usePlatformInfo`.
- **Boot ordering**: provider mounts inside `<EnvProvider>` (legacy boot still runs independently). No gating change.

## 5. Migration pattern (per consumer)

1. Identify each `appService.<member>` use and map it:
   - boolean/platform → `getPlatformInfo().<x>` (non-React) or `usePlatformInfo().<x>` (component)
   - `loadSettings`/`saveSettings`/`getDefaultViewSettings` → `LoadSettings`/`SaveSettings`/`SettingsRepository.getDefaultViewSettings` via `runEffect`
   - file ops (`readFile`/`writeFile`/`exists`/`copyFile`/`createDir`/`deleteFile`/`readDirectory`/`getImageURL`) → `FileSystem` port effect via `runEffect`
   - `resolveFilePath` → `PathResolver.absolute`
   - dialog (`selectDirectory`/`selectFiles`/`saveFile`/`ask`) → `Dialog` port
   - `openDatabase` → `Database` port
2. Replace the `getAppService()`/`useEnv().appService` acquisition with the bridge accessor.
3. Preserve behavior exactly (Promise-returning call sites: `await runEffect(usecase)` / `await getClientRuntime().runPromise(...)`).
4. Keep the file's existing tests green; add a test only if the file had none and the change is non-trivial.

> Error mapping: the new ports return tagged errors in the Effect channel; at a consumer boundary that previously got a thrown error/Promise rejection, `runPromise` rejects with the tagged error — preserving the existing try/catch behavior. Where a consumer relied on a specific thrown shape, adapt minimally and note it.

## 6. Testing & verification

- **Bridge unit tests:** `getClientRuntime()` selects by platform (mock `isTauriAppPlatform`); `getPlatformInfo()` returns sync booleans; `EffectRuntimeProvider` renders + runs BootApp (mock runtime).
- **Per-file:** the consumer's existing tests stay green; `pnpm exec tsgo --noEmit` clean (only pre-existing errors); `pnpm exec biome check <file>` clean.
- **Final sweep:** `pnpm test` (no new failures beyond documented flaky), `pnpm lint`, and a grep gate: the 30 migrated files no longer import `getAppService`/`environmentConfig` (they use the bridge); the remaining 18 + legacy still do.
- **Done-conditions** (repo rules): `pnpm test`, `pnpm lint` green (modulo pre-existing).

## 7. Parallel execution strategy

1. **Sequential, reviewed:** build `clientRuntime.ts` + `EffectRuntimeProvider.tsx` + mount in `__root.tsx` + bridge tests. Two-stage review.
2. **Exemplar:** migrate ONE representative file from each pattern (e.g. a platform-only util + a settings store) sequentially to lock the pattern; review.
3. **Fan out (Workflow):** the remaining ~28 files migrate in parallel — one agent per file (or small batch), each: re-verify the file's `appService` usage is fully portable, migrate, run tsgo/biome + the file's tests, commit. A file that turns out blocked is skipped and reported (not partially migrated).
4. **Verify sweep:** dedup/aggregate, run full `pnpm test` + `pnpm lint` + grep gates.

## 8. Risks

- **Sync platform info** — relies on `Platform.info` being `Effect.sync` (it is, per Plan C). If a platform field were async (e.g. `storefrontRegionCode` on iOS), it stays `null` here (already deferred to BootApp). Document.
- **Runtime singleton + HMR/tests** — memoize carefully; tests reset modules. Provide a test seam (allow injecting a runtime).
- **Parallel commits on shared files** — the 30 are mostly distinct modules; if two target the same file (none expected), the Workflow serializes them. `__root.tsx` and the bridge are built BEFORE the fan-out, so no parallel agent touches them.
- **Mis-classified consumer** — re-verify per file; bump blocked ones out with a log, never partial-migrate.
- **Behavior drift** — ports return tagged errors; preserve each call site's existing async/throw contract; rely on the file's existing tests.
