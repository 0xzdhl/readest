# E5a — Final consumer migration off appService (additive)

**Branch:** `effect/domain-type-migration`
**Status:** design approved 2026-06-10 (revised after full scope discovery)
**Predecessors:** E1/E1b, E2a/E2b, E3, E4 — all done.
**Successor:** E5b (boot-flip + god-object deletion) — the single destructive slice, gets its own spec after E5a lands green.

## Goal

Remove **all business-logic dependence on `useEnv().appService`** by migrating every consumer onto the existing Effect bridge — `usePlatformInfo()`/`getPlatformInfo()` for platform flags, and the ports/usecases for IO/data. Strictly additive: `EnvContext.appService`, `environment.getAppService()`, and the four god-object classes stay alive but feed only the boot path + the render-readiness gates (which E5b removes). After E5a the tree is green with `appService` referenced only by the readiness gates, `EnvContext`, and the still-typed legacy param surfaces (`cloudService.ts`/`storage.ts`/`fsPortAdapter`).

## Scope discovery (why this is bigger than first thought)

The initial spec assumed ~13 consumers. A correct grep (`appService(?\.|\.)`) found **~86 non-test files** reading `appService` members. The original exploration keyed on the `AppService` _type_ and `getAppService()`, so it missed the dominant case: ~74 files that just destructure `appService` from `useEnv()` and read **platform flags** (no type import). The real surface splits into two components:

- **Component A — platform-flag sweep (~74 files, ~220 reads):** `isMobile`/`isAndroidApp`/`isMobileApp`/`isIOSApp`/`hasWindow`/`hasRoundedWindow`/`hasSafeAreaInset`/`hasWindowBar`/`hasTrafficLight`/`hasUpdater`/`hasContextMenu`/`hasHaptics`/`isLinuxApp`/`isDesktopApp`/`isMacOSApp`/`isOnlineCatalogsAccessible`/`appPlatform`/`distChannel`/etc. **`PlatformInfo` is a faithful superset of every flag read** (verified against `src/application/ports/Platform.ts`). Pure mechanical swap.
- **Component B — IO/data consumers (~12 files):** real method calls → ports/usecases. `library/index`, `opds/index`, `StorageManager`, `Annotator`, `SearchBar`, `BookshelfItem`, `ShareBookDialog`, `useFileSelector`, `useLibrary`, `useOPDSSubscriptions`, plus residual sites in already-touched files. Plus the non-React flag readers (`TTSController`/`EdgeTTSClient`/`openWith`/`trafficLightStore`) and trivial param-drops (`HardcoverSyncMapStore`, `useReplicaPull`).

In scope:

- **A.** Replace `const { appService } = useEnv()` → `const platformInfo = usePlatformInfo()` (React) / `getPlatformInfo()` (non-React) and every `appService?.<flag>` → `platformInfo.<flag>`, across all ~74 flag-only files. Drop now-unused `useEnv`/`appService` and stale `[appService]` dep-array entries (swap to `[]` or the real deps).
- **B.** Migrate IO/data calls to ports/usecases: `loadSettings`→`SettingsRepository.load`, `loadLibraryBooks`→`LibraryRepository.load`, `saveLibraryBooks`→`LibraryRepository.save`, `isBookAvailable`/`getBookFileSize`→`BookRepository`, `deleteBook`→`CloudService.deleteBook`, `downloadReplicaFile`→`CloudService`, `importBook`→`importBooks` usecase, `selectFiles`/`selectDirectory`/`saveFile`→`Dialog`, `readFile`/`readDirectory`/`writeFile`/`exists`/`createDir`/`copyFile`/`deleteDir`/`getImageURL`→`FileSystem`, `resolveFilePath`/`resolvePath`→`PathResolver`.
- **C.** Non-React flag readers + trivial cleanups: `TTSController`/`EdgeTTSClient` (ctor drops `appService`; `isAndroidApp`/`isLinuxApp`→`getPlatformInfo()`) + `useTTSControl` construction/flags; `trafficLightStore.initializeTrafficLightStore` (drop param; `hasTrafficLight`→`getPlatformInfo()`) + `useTrafficLight` caller; `openWith` (drop param; `isIOSApp`→`getPlatformInfo()`) + caller; `HardcoverSyncMapStore` (delete the unused ctor) + `useHardcoverSync`/`HardcoverForm` callers; `useReplicaPull` (drop unused `AppService` param threading).

Out of scope → **E5b** (destructive slice):

- `EnvContext` boot-flip (make `EffectRuntimeProvider`/`BootApp` authoritative, publish settings, move replica-sync boot, gate the shell, strip `EnvContext`).
- Deleting `environment.getAppService` + the 4 class files; deleting the `AppService` interface from `domain/system.ts` (the `FileSystem` interface STAYS — `makeLegacyFsAdapter` return type).
- Retyping `cloudService.ts`/`storage.ts` download params to `{ writeFile }`.
- Full `EnvConfigType`/`envConfig` removal.
- The render-readiness gates `if (!appService) return …` (`Providers.tsx:127`, `library/index.tsx:915`) and the residual `appService` they read for that purpose.

## Why this shape (decision log)

- **`usePlatformInfo()` is the faithful flag replacement (E1-established).** `PlatformInfo` mirrors the legacy AppService capability surface field-for-field (see `Platform.ts` header comment). `getPlatformInfo()` is **synchronous + SSR-safe**, so flag reads resolve immediately from `clientEnv.VITE_APP_PLATFORM` — strictly faithful-or-better than `appService?.<flag>` (which was `undefined` until async boot). E1 already migrated several consumers this exact way.
- **One revised spec, decomposed in the plan.** Component A is one trivial pattern × ~74 files; Component B is ~12 careful per-file migrations; Component C is ~8 small files. The plan groups A by directory subtree (executed by parallel subagents) and B/C per-file.
- **No new infrastructure.** Every target maps to an existing port/usecase (`Dialog.selectFiles` already matches `appService.selectFiles(name, extensions)`; `FileSystem`/`PathResolver`/`SettingsRepository`/`LibraryRepository`/`BookRepository`/`CloudService`/`importBooks` all exist from E1–E4).
- **Additive.** Leaves the god-objects constructible (legacy boot still runs) so the tree stays green/bootable until E5b flips it.
- **Name mismatch to handle:** `appService.supportsCanvasContext` (legacy) vs `PlatformInfo.supportsCanvasContext2DFilter` — the plan maps it explicitly. Verify any other legacy flag whose `PlatformInfo` name differs before sweeping.

## Components & decomposition

Pattern: React → `const platformInfo = usePlatformInfo()` + `platformInfo.<flag>`, `useRunEffect(Effect.flatMap(<Port>, …))`; non-React → `getPlatformInfo()` + `getClientRuntime().runPromise(…)`. Imports from `@/context/EffectRuntimeProvider` (`usePlatformInfo`/`useRunEffect`) and `@/runtime/clientRuntime` (`getPlatformInfo`/`getClientRuntime`).

### A — Platform-flag sweep (~74 files), grouped by directory for parallel subagents

- `src/app/reader/**` (largest group: components, sidebar, footerbar, annotator, paragraph, tts, notebook, hooks)
- `src/app/library/**` (components incl. BookshelfItem/LibraryHeader/Bookshelf/etc.)
- `src/app/opds/**`, `src/app/user/**`
- `src/components/**` (Auth, Dialog, WindowButtons, settings/_, command-palette/_, AppLockScreen, AboutWindow, LegalLinks, Providers-flag-parts)
- `src/hooks/**` (useTheme, useKeyDownActions, useSwipeToDismiss, useOpenWithBooks, useAppUrlIngress, useWindowActiveChanged, usePagination, useDiscordPresence-flag, etc.)

Each subagent: swap `useEnv().appService` flag reads → `usePlatformInfo()`; if a file _also_ makes IO calls (the Component-B overlap files), leave the IO calls for the B tasks and migrate only its flags (or skip the file entirely and let B own it — the plan assigns overlap files to B). Run `tsgo` over the subtree; commit per subtree.

### B — IO/data consumers (~12 files), per-file

`library/index` (the heaviest: `loadSettings`/`loadLibraryBooks`/`isBookAvailable`/`deleteBook`/`selectDirectory`/`readDirectory`/`importBook` via helpers + all its flags), `opds/index`, `StorageManager`, `Annotator`, `SearchBar`, `BookshelfItem`, `ShareBookDialog`, `useFileSelector` (Dialog.selectFiles + flags; note `Dialog.selectFiles` returns `readonly string[]` — spread when handing to `processTauriFiles(string[])`), `useLibrary` (loadSettings), `useOPDSSubscriptions`, plus residual sites. Each file gets its method calls mapped to ports per the table above; verify against the file's current behavior.

### C — Non-React flag readers + trivial drops

`TTSController` (+ `EdgeTTSClient`, `useTTSControl`), `trafficLightStore` (+ `useTrafficLight`), `openWith` (+ caller), `HardcoverSyncMapStore` (+ `useHardcoverSync`/`HardcoverForm`), `useReplicaPull`. Details in the plan.

## Testing

- Re-run each migrated file's tests; rebridge any mocking `appService.*` by mocking `@/context/EffectRuntimeProvider` (`usePlatformInfo`) or `@/runtime/clientRuntime` (`getPlatformInfo`) — the E1/E3 pattern; many store/component tests already do this. Preserve assertion intent. TTS (`EdgeTTSClient`/`useTTSControl`) and `HardcoverSyncMapStore` tests need ctor-signature updates.
- No new test files (no new units) — only consumer-test updates.

## Verification (done-conditions)

- `grep -rnE 'appService(\?\.|\.)' src --glob '!**/__tests__/**'` → only: the render-readiness guards (`Providers.tsx`/`library/index.tsx` `if (!appService)`), `EnvContext`, the `EffectRuntimeProvider` comment, and the still-typed `cloudService.ts`/`storage.ts`/`fsPortAdapter` legacy param surfaces. **No platform-flag or IO method reads in any consumer.**
- `grep -rn 'getAppService' src --glob '!**/__tests__/**'` → only `EnvContext.tsx` + `environment.ts`.
- `pnpm lint` (tsgo + biome): only the 2 pre-existing baseline errors.
- `pnpm test`: green except the known env-flaky set (opds-req/hardcover/edgeTTS/turso-node + the `getAPIBaseUrl` collection failures).
- No Rust/Lua touched.
