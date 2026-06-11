# E5b-1 — Boot-flip: make BootApp authoritative (behavioral, no deletions)

**Branch:** `effect/domain-type-migration`
**Status:** design approved 2026-06-11
**Predecessors:** E1–E4, E5a — all done (all `appService` _member_ reads migrated; only readiness gates + boot wiring remain on `appService`).
**Successor:** E5b-2 — the destructive deletion slice (delete classes/EnvContext/AppService interface + envConfig sweep + retypes + 2 residuals), its own spec after E5b-1 lands green + app-verified.

## Goal

Make the Effect boot path (`BootApp` run by `EffectRuntimeProvider`) the **authoritative** app boot, and replace every use of `appService` as an "is the app booted?" signal with a single **`booted`** signal. Strictly behavioral — **no deletions**. After E5b-1: nothing reads `appService`, nothing calls `environment.getAppService`, the tree is green and **app-runnable**. This is the checkpoint that must be unit-tested AND verified with a real app run before E5b-2's irreversible deletes.

E5b was split (user decision) into **E5b-1 (this, the risky behavioral flip)** + **E5b-2 (mechanical deletion)** so the startup-behavior change lands behind a green, runnable checkpoint before the god-objects are deleted.

In scope:

- **`EffectRuntimeProvider`** becomes the boot owner: run `BootApp` for real (not observe-only), expose `useBooted()` + `useBootSettings()`, and run the replica-sync boot (moved from `EnvContext`).
- **`Providers`**: replace the `appService.loadSettings()` boot block with consumption of the boot settings (gated on `booted`); flip the shell/app-lock gate from `!!appService` to `booted`.
- **`EnvContext`**: stop calling `getAppService`; stop providing `appService`; becomes a thin `{ envConfig }` provider.
- **The 24 readiness gates** → `useBooted()`.

Out of scope → **E5b-2**:

- Delete `EnvContext` + `useEnv`, the 4 god-object classes (`appService`/`native`/`web`/`nodeAppService`), `environment.getAppService` + the lazy loaders, the `AppService` interface in `domain/system.ts` (the legacy `FileSystem` interface STAYS — `fsPortAdapter` bridge).
- Retype `storage.ts`/`cloudService.ts` download params (+ the `opds/index`/`autoDownload` writer shims + the `CloudService.layer` cast) `AppService` → a minimal `{ writeFile }` `FileWriter`.
- Full `EnvConfigType`/`envConfig` removal (~85 vestigial sites across ~17 files).
- The 2 whole-object `appService`-instance residuals (`DictionaryResultsView` `fs`, `FontDropDown`).
- §19.2 search-gate-empty verification.

## Why this shape (decision log)

- **One `booted` signal, not per-consumer.** All 24 gates are identical "has boot finished?" checks; `appService` was non-null only after `getAppService().init()` resolved. A single `useBooted(): boolean` (false until `BootApp` resolves, true after) is the faithful 1:1 replacement — SSR-safe like `getPlatformInfo`. (Considered: gate on the settings store being populated — rejected; changes semantics and timing for 24 sites.)
- **`EffectRuntimeProvider` owns boot, `Providers` owns store-wiring.** `BootApp` stays a PURE usecase returning `{platform, settings}`. The runtime/boot side-effects (run BootApp, set `booted`, replica-sync init — all module-level fns, no Zustand deps) live in `EffectRuntimeProvider`. The store-coupled wiring (`initializeAppLock`/`initSettingsSync`/`applyUILanguage`/`applyBackgroundTexture`/theme) stays in `Providers`, which already holds those store hooks — it just triggers on `booted` + reads `useBootSettings()` instead of `appService.loadSettings()`. Keeps each provider's responsibility intact.
- **Replica-sync boot uses `BootApp`'s settings, not a fresh load.** `EnvContext` currently does its OWN `loadSettings()` to read `settings.replicaDeviceId`. The flip reads `replicaDeviceId` from `BootApp`'s returned settings (one load, correct ordering). `enableReplicaAutoPersist(env)` keeps its vestigial arg — import the `environment` default singleton directly (avoids a `useEnv` dependency in `EffectRuntimeProvider`).
- **EnvContext goes thin, not deleted (yet).** E5b-1 removes `appService` + the `getAppService` call from `EnvContext` (so `getAppService` is called by nothing), but leaves `EnvContext`/`useEnv`/`envConfig` in place — ~17 files still import `useEnv`/thread `envConfig`; deleting that surface is E5b-2's mechanical sweep. Keeps E5b-1 focused on behavior.

## Components

### 1. `src/context/EffectRuntimeProvider.tsx` — boot owner

- The boot `useEffect` (currently observe-only) runs `BootApp` and on resolve sets `booted` state + stores `{platform, settings}`. Add `booted: boolean` + `bootSettings: SystemSettings | null` to `RuntimeContextValue`; export hooks `useBooted()` and `useBootSettings()` (degrade to `false`/`null` outside the provider, like the existing `useRunEffect`/`usePlatformInfo` fallbacks).
- After `BootApp` resolves, run the replica-sync boot (moved from `EnvContext`): `bootstrapReplicaAdapters()`, `enableReplicaAutoPersist(env)` (import `env` from `@/services/environment`), and `if (settings.replicaDeviceId) { const ctx = initReplicaSync({ deviceId, cursorStore: createSettingsCursorStore() }); ctx.manager.startAutoSync(); startReplicaTransferIntegration(); }`. Wrap in try/catch with the same `console.warn('replica sync init failed', err)` as the current EnvContext.
- Keep the `booted.current` ref guard so boot runs once. On `BootApp` failure, log (non-fatal) and leave `booted=false` — faithful to today where a failed `getAppService` left `appService=null` (shell stays in its pre-boot state).

### 2. `src/components/Providers.tsx` — settings-publish on `booted`

- Replace the `if (appService) { initSystemThemeListener(); appService.loadSettings().then((settings) => { … }) }` effect (lines ~62–100) with: read `const booted = useBooted(); const bootSettings = useBootSettings();` then `useEffect(() => { loadDataTheme(); if (!booted || !bootSettings) return; initSystemThemeListener(); const settings = bootSettings; /* same body: applyUILanguage, applyBackgroundTexture(envConfig, …), applyEinkMode, initializeAppLock(…), initSettingsSync(settings) */ }, [booted, bootSettings, envConfig, applyUILanguage, applyBackgroundTexture, applyEinkMode, initializeAppLock])`.
- Shell gate: `const showAppLockScreen = booted && isLockInitialized && !isUnlocked;` and `const appShellHidden = booted && (!isLockInitialized || !isUnlocked);` (was `!!appService && …`).
- `envConfig` stays (still threaded into `applyBackgroundTexture`); E5b-2 removes it. `appService` drops from the `useEnv()` destructure here.

### 3. `src/context/EnvContext.tsx` — thin provider

- Delete the boot `useEffect`'s `getAppService().then(...)` block (the replica-sync part moved to `EffectRuntimeProvider`). Keep `bootstrapReplicaAdapters()`/`enableReplicaAutoPersist` ONLY in their new home (EffectRuntimeProvider) — remove from here. Keep the `window 'error'` ResizeObserver handler (unrelated) OR move it too; simplest: leave it in EnvContext.
- Remove `appService` state + `setAppService` + the `import type { AppService }`. `EnvContextType` becomes `{ envConfig: EnvConfigType }`. `useEnv()` SSR fallback returns `{ envConfig: {} as EnvConfigType }`.
- Provider order in `__root.tsx` unchanged (`EnvProvider > EffectRuntimeProvider > Providers`) — EffectRuntimeProvider is inside EnvProvider, fine.

### 4. The 24-gate sweep → `useBooted()`

Add `import { useBooted } from '@/context/EffectRuntimeProvider'` + `const booted = useBooted();` and replace the `appService`-readiness check in each:

| File:line                                             | before → after                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/library/index.tsx:920`                           | `if (!appService \|\| !insets \|\| …)` → `if (!booted \|\| !insets \|\| …)`                                                                                                                                                                       |
| `app/library/components/BackupWindow.tsx:80,106`      | `if (!appService) return` → `if (!booted) return`                                                                                                                                                                                                 |
| `app/library/components/SettingsMenu.tsx:202`         | `if (!appService \|\| isRefreshingMetadata)` → `if (!booted \|\| …)`                                                                                                                                                                              |
| `app/opds/index.tsx:456,558`                          | `if (!appService \|\| !libraryLoaded)` → `if (!booted \|\| …)`                                                                                                                                                                                    |
| `app/opds/index.tsx:584`                              | `if (!appService) return url` → `if (!booted) return url`                                                                                                                                                                                         |
| `app/opds/components/CatalogManager.tsx:140`          | `if (!appService) return` → `if (!booted) return`                                                                                                                                                                                                 |
| `app/opds/components/CatalogManager.tsx:320`          | `if (appService) {…}` → `if (booted) {…}`                                                                                                                                                                                                         |
| `app/opds/components/FailedDownloadsDialog.tsx:24,41` | `if (!appService …)` → `if (!booted …)`                                                                                                                                                                                                           |
| `app/reader/components/ReaderContent.tsx:217`         | `if (appService) {…}` → `if (booted) {…}`                                                                                                                                                                                                         |
| `app/reader/hooks/useKOSync.ts:302`                   | `if (!appService \|\| …)` → `if (!booted \|\| …)`                                                                                                                                                                                                 |
| `components/settings/CustomFonts.tsx:78`              | `if (appService) void queue…` → `if (booted) void queue…`                                                                                                                                                                                         |
| `components/settings/ColorPanel.tsx:271`              | `if (appService) void queue…` → `if (booted) void queue…`                                                                                                                                                                                         |
| `components/settings/CustomDictionaries.tsx:437,443`  | `if (appService) void queue…` → `if (booted) void queue…`                                                                                                                                                                                         |
| `hooks/useOpenShareLink.ts:61`                        | `if (!appService) return` → `if (!booted) return`                                                                                                                                                                                                 |
| `hooks/useOPDSSubscriptions.ts:25`                    | `if (!appService \|\| !libraryLoaded)` → `if (!booted \|\| …)`                                                                                                                                                                                    |
| `hooks/useReplicaPull.ts:523`                         | `if (!appService) return` → `if (!booted) return`                                                                                                                                                                                                 |
| `hooks/useTransferQueue.ts:19`                        | `if (appService && envConfig) {…}` → `if (booted) {…}` (drop both; `envConfig` no longer needed for the guard — keep it if `initialize` still needs it, but transferManager.initialize already dropped appService in E4; confirm `envConfig` use) |

For each file: drop `appService` from `useEnv()` (and the whole `useEnv()` if `envConfig`/other names become unused); fix dep arrays (`appService` → `booted`). Where the gate also reads `appService` in a dep array, swap to `booted`.

## Testing

- **Unit:** add/extend an `EffectRuntimeProvider`/boot test: render the provider, assert `BootApp` runs, `useBooted()` flips to `true`, `useBootSettings()` returns the loaded settings; assert the replica-sync boot fires when `replicaDeviceId` is set (mock `initReplicaSync`/`startReplicaTransferIntegration`). Rebridge any test that mocked `useEnv().appService` as a readiness signal → mock `useBooted()` (mock `@/context/EffectRuntimeProvider`). Preserve assertion intent.
- **App run (REQUIRED gate before E5b-2):** `pnpm dev-web` (and tauri if feasible). Confirm: shell renders after boot; settings load (UI language/theme/eink applied); **app-lock gate** still hides the shell until PIN state loads (test with a PIN-enabled profile); library page loads; **replica sync inits** for a sync-enabled profile (check the `replica sync init` path runs, no console errors). This is the irreversible-delete gate.

## Verification (done-conditions)

- `grep -rn 'getAppService' src --glob '!**/__tests__/**'` → only `src/services/environment.ts` (the definition). **`EnvContext` no longer calls it.**
- `grep -rnE 'appService' src --include=*.ts --include=*.tsx | grep -v __tests__` → only the legacy definition/param surfaces (`appService.ts`/`native|web|nodeAppService.ts`/`cloudService.ts`/`storage.ts`/`domain/system.ts`/`environment.ts`/`CloudService.layer.ts`/`opds/index` writer shim/`autoDownload` writer + the 2 whole-object residuals `DictionaryResultsView`/`FontDropDown`). **No readiness gate, no `useEnv().appService`.**
- `pnpm lint` (tsgo + biome): only the 2 pre-existing baseline errors.
- `pnpm test`: green except the known env-flaky set.
- **App run passes** (the manual gate above).
- No Rust/Lua touched.
