# E5a — Final consumer migration off appService (additive)

**Branch:** `effect/domain-type-migration`
**Status:** design approved 2026-06-10
**Predecessors:** E1/E1b (portable + DI-pattern consumers), E2a/E2b (book/library data + import/export), E3 (asset services), E4 (Sync/Cloud + singletons) — all done.
**Successor:** E5b (boot-flip + god-object deletion) — the single destructive slice, gets its own spec after E5a lands green.

## Goal

Migrate the remaining live `appService` consumers onto the **existing** Effect ports/usecases so that **no business logic depends on `appService` anymore**. Strictly additive: `EnvContext.appService`, `environment.getAppService()`, and the four god-object classes (`appService`/`native`/`web`/`nodeAppService`) stay alive but feed only the boot path + the render-readiness gates — which E5b removes. After E5a the tree is fully green with the god-objects unreferenced by any consumer behavior.

This slice was split from the original "E5" because the grep-gate was **not** empty: ~13 live consumers remained (7 calling `getAppService()`, ~6 receiving the `appService` instance via `useEnv().appService`). E5a clears them; E5b does the destructive boot-flip + deletion.

In scope (consumer migration only — NO new ports/usecases/services):

- The 4 `getAppService()` data-load sites (`library/index` ×3, `useLibrary`).
- The platform-flag instance consumers (`TTSController`, `EdgeTTSClient`, `trafficLightStore`, `openWith`, `library/index` flags) → `getPlatformInfo()`/`usePlatformInfo()`.
- `useFileSelector` (platform flags + `selectFiles` → `Dialog` port).
- `HardcoverSyncMapStore` (drop the already-unused `_appService` ctor param) + its 2 call sites (`useHardcoverSync`, `HardcoverForm`).
- `useReplicaPull` (drop the unused `AppService`-typed param threading).

Out of scope → **E5b** (destructive slice):

- `EnvContext` boot-flip: making `EffectRuntimeProvider`/`BootApp` authoritative, publishing settings to the store, moving the replica-sync boot into the Effect path, gating the shell, stripping `EnvContext`.
- Deleting `environment.getAppService` + `getNativeAppService`/`getWebAppService` + the 4 class files.
- Deleting the `AppService` interface from `domain/system.ts` (the `FileSystem` interface STAYS — it is the return type of `makeLegacyFsAdapter`, load-bearing for every shared layer).
- Retyping the `appService: AppService` params in `libs/storage.ts` + `services/cloudService.ts` download fns to a minimal `{ writeFile }` shape.
- Full `EnvConfigType`/`envConfig` removal (~85 vestigial params across ~17 files).
- The render-readiness gates `if (!appService) return …` (`Providers.tsx:127`, `library/index.tsx:915`).

## Why this shape (decision log)

- **No new infrastructure.** Every target maps to a port/usecase that already exists: platform flags → `getPlatformInfo()`/`usePlatformInfo()` (E1 bridge); `loadSettings` → `SettingsRepository.load`; `loadLibraryBooks` → `LibraryRepository.load`; `selectFiles` → `Dialog.selectFiles` (already on the port, signature matches `appService.selectFiles(name, extensions)`). This is the E1/E1b pattern applied to the last holdouts.
- **Additive, not destructive.** E5a leaves the god-objects constructible so the app keeps booting through the legacy path; it only removes _consumers_. This isolates the destructive boot-flip+deletion behind a green checkpoint (E5b), matching the user's "boot-flip vs god-object deletion" decomposition.
- **`HardcoverSyncMapStore` is a no-op drop.** Its ctor is already `constructor(_appService: AppService) {}` with a comment that the db logic doesn't use it — so the migration is purely a signature + call-site cleanup (removes the 2 `getAppService()` calls in its callers).
- **`EdgeTTSClient`/`TTSController` use only platform flags** (`isLinuxApp`/`isAndroidApp`) — no fs/network via appService — so they need only `getPlatformInfo()`, not a port. The TTS subsystem is otherwise untouched.
- **Retypes deferred to E5b.** `cloudService.ts`/`storage.ts` keep their `appService: AppService` param types in E5a (additive); E5b retypes them as part of dismantling the `AppService` interface. Keeping them here avoids touching the pure-fn signatures twice.

## Components

Pattern: React components → `usePlatformInfo()` / `useRunEffect(Effect.flatMap(<Port>, …))`; non-React modules/classes → `getPlatformInfo()` / `getClientRuntime().runPromise(…)`. All from `@/runtime/clientRuntime` / `@/context/EffectRuntimeProvider`.

### 1. `getAppService()` data loads

- `src/app/library/index.tsx:340` (close-reader-window effect): `loadSettings()` → `SettingsRepository.load`; `loadLibraryBooks()` → `LibraryRepository.load`. Remove the `const appService = await envConfig.getAppService()`.
- `src/app/library/index.tsx:469` (`initLogin`): `loadSettings()` → `SettingsRepository.load`.
- `src/app/library/index.tsx:487` (`initLibrary`): `loadSettings()` + `loadLibraryBooks()` → repos.
- `src/hooks/useLibrary.ts:29` (`initLibrary`): `loadSettings()` → `SettingsRepository.load`.

(These are async non-render code paths; use `getClientRuntime().runPromise(...)` or the component's `runEffect`, matching how the file already runs effects.)

### 2. Platform-flag instance consumers → `getPlatformInfo()`/`usePlatformInfo()`

- `src/services/tts/TTSController.ts`: ctor drops `appService: AppService | null`; `appService?.isAndroidApp` (line ~63) → `getPlatformInfo().isAndroidApp`; stop passing `appService` to `new EdgeTTSClient(this)`; drop the `this.appService` field. Update construction at `src/app/reader/hooks/useTTSControl.ts:510`.
- `src/services/tts/EdgeTTSClient.ts`: ctor drops `appService`; `this.appService?.isLinuxApp` (lines ~209/215) → `getPlatformInfo().isLinuxApp`.
- `src/store/trafficLightStore.ts`: `appService.hasTrafficLight` (lines ~31/32) → `getPlatformInfo().hasTrafficLight`; drop the `appService` param from the store method; update callers.
- `src/helpers/openWith.ts`: `appService?.isIOSApp` (line ~46) → `getPlatformInfo().isIOSApp`; drop the `appService` param from `parseIntentOpenWithFiles`/`parseOpenWithFiles`; update caller (`library/index` `processOpenWithFiles`).
- `src/app/library/index.tsx`: `appService?.isAndroidApp` (~307), `appService?.hasUpdater` (~312), `appService?.isMobileApp` (~326), `appService?.hasWindow` (~332) → `usePlatformInfo()` reads.

### 3. `useFileSelector`

- `src/hooks/useFileSelector.ts`: `appService?.isIOSApp`/`isAndroidApp` → `usePlatformInfo()`; `appService?.selectFiles(_(title), exts)` → `runEffect(Effect.flatMap(Dialog, (d) => d.selectFiles(_(title), exts)))` (returns `readonly string[]`). Drop the `appService` param. Update caller `src/app/library/index.tsx:140` (`useFileSelector(appService, _)` → `useFileSelector(_)`).

### 4. `HardcoverSyncMapStore`

- `src/services/hardcover/HardcoverSyncMapStore.ts`: drop `_appService` from the ctor (already unused). Update callers `src/app/reader/hooks/useHardcoverSync.ts:33` and `src/components/settings/integrations/HardcoverForm.tsx:28` to remove the `const appService = await envConfig.getAppService()` + the arg.

### 5. `useReplicaPull`

- `src/hooks/useReplicaPull.ts`: the `AppService`-typed params (no method calls — pass-through only) are removed; update any internal threading + callers. (If a param is genuinely needed for nothing, delete it and its call-site args.)

## Testing

- Re-run each migrated file's existing tests; rebridge any that mocked `appService.*` (platform flags) by mocking `@/runtime/clientRuntime`'s `getPlatformInfo()` (the E1/E3 pattern — these stores already mock the runtime) or `@/context/EffectRuntimeProvider`. The TTS tests (`EdgeTTSClient`/`useTTSControl`) and `HardcoverSyncMapStore` tests are the most likely to need a ctor-signature update; preserve assertion intent.
- `useFileSelector`'s `selectFiles` test (if any) asserts on `Dialog.selectFiles` via the runtime mock.
- No new test files required (no new units) — only consumer-test updates.

## Verification (done-conditions)

- `grep -rn 'getAppService' src --glob '!**/__tests__/**'` → only `src/context/EnvContext.tsx` + `src/services/environment.ts` (the infra; E5b's to remove).
- `grep -rn 'appService\.' src --glob '!**/__tests__/**'` → only: the render-readiness guards (`if (!appService)` in `Providers.tsx`/`library/index.tsx`), `EnvContext`, and the still-typed `cloudService.ts`/`storage.ts`/`fsPortAdapter` param surfaces (E5b retypes). NO behavioral method calls in consumers.
- `pnpm lint` (tsgo + biome): only the 2 pre-existing baseline errors (`scripts/upload-cjk-fonts-r2.ts`, `SettingsDialog.tsx` unused `lazy`).
- `pnpm test`: green except the known env-flaky set (opds-req/hardcover/edgeTTS/turso-node + the `getAPIBaseUrl` import-time collection failures in theme-store/useBookShortcuts).
- No Rust/Lua touched.
