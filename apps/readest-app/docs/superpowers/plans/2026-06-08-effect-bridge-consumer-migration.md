# Effect Bridge + Consumer Migration (E1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for the sequential bridge tasks (1–4). The fan-out (Task 5) is executed as a parallel Workflow — one agent per file. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the React/runtime bridge (`getClientRuntime`, `getPlatformInfo`, `EffectRuntimeProvider`, `useRunEffect`, `usePlatformInfo`), run `BootApp` at startup observe-only, and migrate the 30 already-portable `getAppService()` consumers onto it.

**Architecture:** A module-level platform-selected runtime singleton (`runtime/clientRuntime.ts`) backs both a React provider (for components) and direct calls (for stores/services/utils). Platform booleans come from a synchronous cached `getPlatformInfo()` (port `Platform.info` is `Effect.sync`). Bridge is built + reviewed sequentially; the 30 consumer migrations fan out in parallel. Fully additive — legacy `AppService` boot stays authoritative.

**Tech Stack:** effect@3.21.2 (`ManagedRuntime.runSync/runPromise`), React 19 + TanStack Router, Vitest (jsdom), tsgo + Biome. `@/* → src/*`.

**Prereqs:** Plans A–D complete. `tauriClientRuntime`/`webClientRuntime` in `src/runtime/client-{tauri,web}.ts`; ports + usecases (`LoadSettings`, `SaveSettings`, `BootApp`) exist. Spec: `docs/superpowers/specs/2026-06-08-effect-bridge-consumer-migration-design.md`.

---

## File structure

```
src/runtime/clientRuntime.ts          # getClientRuntime() singleton + getPlatformInfo() (sync) + test seam
src/context/EffectRuntimeProvider.tsx # provider + useRunEffect + usePlatformInfo + observe-only BootApp
src/app/__root.tsx                     # MODIFY: mount <EffectRuntimeProvider>
src/__tests__/runtime/clientRuntime.test.ts
src/__tests__/context/effectRuntimeProvider.test.tsx
# + 30 consumer files migrated (Task 5, fan-out)
```

---

## Task 1: Client runtime singleton + sync platform info

**Files:** Create `src/runtime/clientRuntime.ts`; Test `src/__tests__/runtime/clientRuntime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/runtime/clientRuntime.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadFresh = async (platform: 'tauri' | 'web') => {
  vi.resetModules();
  vi.doMock('@/services/environment', () => ({
    isTauriAppPlatform: () => platform === 'tauri',
    isWebAppPlatform: () => platform === 'web',
  }));
  // Mock the two runtimes so the test does not construct real Tauri/web layers.
  const fakeInfo = { appPlatform: platform, isMobile: false } as unknown;
  const fakeRuntime = { runSync: vi.fn(() => fakeInfo), runPromise: vi.fn() };
  vi.doMock('@/runtime/client-tauri', () => ({
    tauriClientRuntime: { ...fakeRuntime, _tag: 'tauri' },
  }));
  vi.doMock('@/runtime/client-web', () => ({ webClientRuntime: { ...fakeRuntime, _tag: 'web' } }));
  return import('@/runtime/clientRuntime');
};

describe('getClientRuntime / getPlatformInfo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('selects the tauri runtime when isTauriAppPlatform()', async () => {
    const m = await loadFresh('tauri');
    expect((m.getClientRuntime() as { _tag: string })._tag).toBe('tauri');
  });

  it('selects the web runtime otherwise', async () => {
    const m = await loadFresh('web');
    expect((m.getClientRuntime() as { _tag: string })._tag).toBe('web');
  });

  it('getPlatformInfo runs Platform.info via runSync and caches it', async () => {
    const m = await loadFresh('web');
    const a = m.getPlatformInfo();
    const b = m.getPlatformInfo();
    expect(a).toBe(b); // cached (same reference)
    expect((a as { appPlatform: string }).appPlatform).toBe('web');
  });

  it('setClientRuntime injects a runtime for tests', async () => {
    const m = await loadFresh('web');
    const injected = {
      runSync: () => ({ appPlatform: 'tauri' }),
      runPromise: vi.fn(),
      _tag: 'injected',
    };
    m.setClientRuntime(injected as never);
    expect((m.getClientRuntime() as { _tag: string })._tag).toBe('injected');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm exec vitest run src/__tests__/runtime/clientRuntime.test.ts`).

- [ ] **Step 3: Implement**

```ts
// src/runtime/clientRuntime.ts
import type { ManagedRuntime } from 'effect';
import { isTauriAppPlatform } from '@/services/environment';
import { Platform, type PlatformInfo } from '@/application/ports/Platform';
import { tauriClientRuntime } from './client-tauri';
import { webClientRuntime } from './client-web';

// Both client runtimes provide the same set of port tags, so they share a runtime type.
type ClientRuntime = typeof tauriClientRuntime;

let runtime: ClientRuntime | null = null;
let platformInfo: PlatformInfo | null = null;

// SSR fallback: the platform layers read Tauri/UA APIs that only exist client-side.
// On the server we can't (and shouldn't) construct the runtime; return neutral web defaults
// so sync consumers degrade exactly like the legacy null-appService path.
const SSR_PLATFORM_INFO: PlatformInfo = {
  appPlatform: 'web',
  osPlatform: 'unknown',
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

export const getClientRuntime = (): ClientRuntime => {
  if (typeof window === 'undefined') {
    throw new Error('getClientRuntime() is not available during SSR');
  }
  if (!runtime) {
    runtime = isTauriAppPlatform() ? tauriClientRuntime : (webClientRuntime as ClientRuntime);
  }
  return runtime;
};

export const getPlatformInfo = (): PlatformInfo => {
  if (typeof window === 'undefined') return SSR_PLATFORM_INFO;
  if (!platformInfo) platformInfo = getClientRuntime().runSync(Platform.info);
  return platformInfo;
};

/** Test seam: inject a runtime + reset caches. */
export const setClientRuntime = (rt: ClientRuntime): void => {
  runtime = rt;
  platformInfo = null;
};
```

> If tsgo objects that `tauriClientRuntime` and `webClientRuntime` have non-identical types, introduce a shared `ManagedRuntime.ManagedRuntime<Services, never>` alias where `Services` is the union of the port tags both provide, and cast both to it. Verify `runSync(Platform.info)` typechecks (Platform.info has no error/requirement channel).

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `git add src/runtime/clientRuntime.ts src/__tests__/runtime/clientRuntime.test.ts && git commit -m "feat(runtime): add client runtime singleton + sync getPlatformInfo"`

---

## Task 2: EffectRuntimeProvider + hooks

**Files:** Create `src/context/EffectRuntimeProvider.tsx`; Test `src/__tests__/context/effectRuntimeProvider.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/__tests__/context/effectRuntimeProvider.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const bootSpy = vi.fn().mockResolvedValue({ platform: { appPlatform: 'web' }, settings: {} });

vi.mock('@/runtime/clientRuntime', () => ({
  getClientRuntime: () => ({ runPromise: (e: unknown) => bootSpy(e) }),
  getPlatformInfo: () => ({ appPlatform: 'web', isMobile: true }),
}));
vi.mock('@/application/usecases/boot/BootApp', () => ({ BootApp: { _tag: 'BootApp' } }));

import { EffectRuntimeProvider, usePlatformInfo } from '@/context/EffectRuntimeProvider';

function Probe() {
  const info = usePlatformInfo();
  return <div>mobile:{String(info.isMobile)}</div>;
}

describe('EffectRuntimeProvider', () => {
  it('exposes sync platform info and runs BootApp once on mount', async () => {
    render(
      <EffectRuntimeProvider>
        <Probe />
      </EffectRuntimeProvider>,
    );
    expect(screen.getByText('mobile:true')).toBeInTheDocument();
    await waitFor(() => expect(bootSpy).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

```tsx
// src/context/EffectRuntimeProvider.tsx
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { Effect } from 'effect';
import { getClientRuntime, getPlatformInfo } from '@/runtime/clientRuntime';
import type { PlatformInfo } from '@/application/ports/Platform';
import { BootApp } from '@/application/usecases/boot/BootApp';

type RunEffect = <A, E>(program: Effect.Effect<A, E, never>) => Promise<A>;

interface RuntimeContextValue {
  readonly platformInfo: PlatformInfo;
  readonly runEffect: RunEffect;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function EffectRuntimeProvider({ children }: { children: ReactNode }) {
  const platformInfo = getPlatformInfo(); // sync (SSR-safe defaults)
  const runEffect = useCallback<RunEffect>((program) => getClientRuntime().runPromise(program), []);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current || typeof window === 'undefined') return;
    booted.current = true;
    // Observe-only: prove the runtime boots end-to-end; do NOT gate the shell.
    getClientRuntime()
      .runPromise(BootApp)
      .then((r) => console.debug('[EffectBoot] booted', r.platform.appPlatform))
      .catch((err) => console.warn('[EffectBoot] failed (non-fatal)', err));
  }, []);

  return (
    <RuntimeContext.Provider value={{ platformInfo, runEffect }}>
      {children}
    </RuntimeContext.Provider>
  );
}

function useRuntimeContext(): RuntimeContextValue {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error('must be used within <EffectRuntimeProvider>');
  return ctx;
}

export const useRunEffect = (): RunEffect => useRuntimeContext().runEffect;
export const usePlatformInfo = (): PlatformInfo => useRuntimeContext().platformInfo;
```

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `git add src/context/EffectRuntimeProvider.tsx src/__tests__/context/effectRuntimeProvider.test.tsx && git commit -m "feat(context): add EffectRuntimeProvider + useRunEffect/usePlatformInfo"`

---

## Task 3: Mount the provider

**Files:** Modify `src/app/__root.tsx`

- [ ] **Step 1: Add the provider** between `<EnvProvider>` and `<Providers>`:

```tsx
// src/app/__root.tsx — inside <body>, wrapping <Providers>
import { EffectRuntimeProvider } from '@/context/EffectRuntimeProvider';
// ...
<EnvProvider>
  <EffectRuntimeProvider>
    <Providers>
      <Outlet />
      <Scripts />
    </Providers>
  </EffectRuntimeProvider>
</EnvProvider>;
```

- [ ] **Step 2: Verify** `pnpm exec tsgo --noEmit` (only pre-existing error) and `pnpm exec vitest run src/__tests__/runtime/clientRuntime.test.ts src/__tests__/context/effectRuntimeProvider.test.tsx` (pass). **Step 3: Commit** `git add src/app/__root.tsx && git commit -m "feat(app): mount EffectRuntimeProvider in root"`

---

## Task 4: Exemplar migrations (lock the pattern)

Migrate TWO representative files sequentially and review, before the fan-out, so the parallel agents have a proven template.

**4a — platform-only exemplar: `src/utils/nav.ts`**

- [ ] READ the file. For each `appService.<bool>` access (e.g. `appService.isIOSApp`), replace with `getPlatformInfo().<bool>` (import `getPlatformInfo` from `@/runtime/clientRuntime`). Remove the `getAppService()`/`useEnv` acquisition if it's now unused. If `nav.ts` got the appService via a param or `useEnv`, adapt to call `getPlatformInfo()` directly (it's a util — non-React).
- [ ] Run its existing tests (`grep -rl "utils/nav" src/__tests__` → run them) + `pnpm exec tsgo --noEmit`. Commit `refactor(effect): migrate utils/nav to getPlatformInfo`.

**4b — settings/file exemplar: `src/hooks/useResetSettings.ts`**

- [ ] READ the file. Replace `appService.loadSettings()`→`runEffect(LoadSettings)`, `appService.saveSettings(s)`→`runEffect(SaveSettings(s))` (import `useRunEffect` from the provider + the usecases). For a React hook, use `const runEffect = useRunEffect()`. Preserve the async/await control flow exactly. If it removes settings (reset), prefer the `ResetSettings` usecase.
- [ ] Run its tests + tsgo. Commit `refactor(effect): migrate useResetSettings to settings usecases`.

> These two cover the (a) non-React sync-platform and (b) React settings-usecase patterns. The reviews of 4a/4b validate the recipe in Task 5.

---

## Task 5: Fan-out migration of the remaining ~28 files (parallel Workflow)

The remaining files (the 30 minus the 2 exemplars) migrate in parallel. **Per-file recipe (every agent follows this exactly):**

1. **READ the file.** Enumerate every `appService.<member>` / `getAppService()` / `useEnv().appService` usage.
2. **Re-verify portability.** If ANY usage hits a blocked capability (Book/Library/Sync/Cloud/Cover/Font/Image/Dict methods — see list below), STOP: do NOT migrate; report the file as BLOCKED with the offending members. Do not partial-migrate.
   - Blocked members: `importBook, deleteBook, loadBookContent, loadBookConfig, saveBookConfig, loadBookNav, saveBookNav, exportBook, refreshBookMetadata, fetchBookDetails, isBookAvailable, getBookFileSize, loadLibraryBooks, saveLibraryBooks, uploadBook, downloadBook, uploadFileToCloud, uploadReplicaFile, downloadReplicaFile, deleteReplicaBundle, downloadBookCovers, getCoverImageUrl, getCoverImageBlobUrl, generateCoverImageUrl, updateCoverImage, getCachedImageUrl, importFont, deleteFont, importImage, deleteImage, importDictionaries, deleteDictionary`
3. **Map each portable usage:**
   - platform boolean → `getPlatformInfo().<x>` (non-React) or `usePlatformInfo().<x>` (React component/hook)
   - `loadSettings()` → `LoadSettings`; `saveSettings(s)` → `SaveSettings(s)`; `getDefaultViewSettings()` → `SettingsRepository.getDefaultViewSettings` (run via `runEffect`/`runPromise`)
   - file op (`readFile/writeFile/exists/copyFile/createDir/deleteFile/deleteDir/readDirectory/isDirectory/openFile/getImageURL`) → the matching `FileSystem` port method, run via the runtime. (`FileSystem` port method names: `readFile/writeFile/exists/copyFile/createDir/removeDir/removeFile/readDir/stat/openFile/getUrl/getBlobUrl` — map legacy→port: `deleteFile→removeFile`, `deleteDir→removeDir`, `readDirectory→readDir`, `getImageURL→getUrl`.)
   - `resolveFilePath(p,b)` → `PathResolver.absolute(p,b)`
   - dialog (`selectDirectory/selectFiles/saveFile/ask`) → `Dialog` port (note `saveFile` now returns `Option<string>`; `selectDirectory` returns `Option<string>` — adapt the call site: `Option.getOrElse`/`Option.match`)
   - `openDatabase(...)` → `Database.open({ schema, path, base, opts })`
4. **Acquire the runtime:**
   - React component/hook: `const runEffect = useRunEffect();` + `usePlatformInfo()`.
   - Non-React module (store/service/util): `import { getClientRuntime, getPlatformInfo } from '@/runtime/clientRuntime';` and `await getClientRuntime().runPromise(<usecase-or-port-effect>)`. To use a port directly: `getClientRuntime().runPromise(Effect.flatMap(FileSystem, (fs) => fs.readFile(p, b, 'text')))`.
5. **Preserve behavior:** keep the same async/await shape and error handling. A port effect that fails rejects the promise with the tagged error — keep existing try/catch. Remove now-unused `getAppService`/`useEnv` imports.
6. **Verify (this file only):** `pnpm exec tsgo --noEmit` (no NEW errors), `pnpm exec biome check <file>` (clean), and run the file's existing tests if any (`grep -rl "<module path>" src/__tests__`).
7. **Commit:** `git add -A && git commit -m "refactor(effect): migrate <relative/path> off AppService"`.

**Worked mini-example (non-React store reading settings):**

```ts
// before
const appService = await environmentConfig.getAppService();
const settings = await appService.loadSettings();
// after
import { getClientRuntime } from '@/runtime/clientRuntime';
import { LoadSettings } from '@/application/usecases/settings/LoadSettings';
const settings = await getClientRuntime().runPromise(LoadSettings);
```

### Files to fan out (28 = 30 − 2 exemplars)

Platform-only (7): `app/error.tsx`, `app/user/index.tsx`, `components/Button.tsx`, `components/settings/FontPanel.tsx`, `hooks/useSafeAreaInsets.ts`, `store/trafficLightStore.ts`, `utils/misc.ts`
Migratable-now (21): `app/library/components/MigrateDataWindow.tsx`, `app/library/hooks/useDragDropImport.ts`, `app/reader/components/notebook/AIAssistant.tsx`, `app/reader/components/sidebar/ChatHistoryView.tsx`, `app/reader/hooks/useAutoSaveBookCover.ts`, `components/Providers.tsx`, `components/UpdaterWindow.tsx`, `components/metadata/BookDetailEdit.tsx`, `libs/storage.ts`, `services/annotation/providers/foliate.ts`, `services/hardcover/HardcoverSyncMapStore.ts`, `services/opds/subscriptionState.ts`, `services/sync/migrateLegacy.ts`, `services/sync/replicaBinaryUpload.ts`, `services/sync/replicaCursorStore.ts`, `store/customDictionaryStore.ts`, `store/customFontStore.ts`, `store/customTextureStore.ts`, `store/settingsStore.ts`, `store/themeStore.ts`, `utils/files.ts`

> `useAutoSaveBookCover.ts` and `customFontStore`/`customTextureStore`/`customDictionaryStore` are likely to touch cover/font/image/dict methods → expect some to come back BLOCKED at step 2. That's the safety valve working — they bump to a later slice.

- [ ] **Execution:** run as a parallel Workflow (one agent per file, the recipe above as the agent prompt). Collect per-file results: MIGRATED (commit sha) or BLOCKED (members). The Workflow caps concurrency; files are distinct modules so no write conflicts. `clientRuntime.ts`/`EffectRuntimeProvider.tsx`/`__root.tsx` are NOT touched by fan-out agents (built in Tasks 1–3).

---

## Task 6: Verification sweep (E1 done)

- [ ] **Step 1:** `pnpm exec tsgo --noEmit` → only pre-existing `upload-cjk-fonts-r2` error.
- [ ] **Step 2:** `pnpm exec biome check src` → only pre-existing `SettingsDialog` error.
- [ ] **Step 3:** `pnpm test` → no NEW failures beyond the documented sandbox-flaky set (verify any new-looking failure passes in isolation).
- [ ] **Step 4: Grep gate** — every MIGRATED file no longer imports the legacy acquisition:

```bash
for f in <list of MIGRATED files>; do
  grep -nE "getAppService|environmentConfig|useEnv\(\)\.appService" "$f" && echo "STILL LEGACY: $f" || true
done
# Expect: no "STILL LEGACY" lines for migrated files.
```

- [ ] **Step 5:** Record which files migrated vs. bumped-to-blocked (update the spec's count or a short note in the plan). Commit any straggler fixes.

## Done-conditions

- Bridge (`clientRuntime.ts`, `EffectRuntimeProvider.tsx`) built, tested, mounted in `__root.tsx`.
- `BootApp` runs observe-only at startup (console.debug on success).
- The portable subset of the 30 consumers migrated off `AppService` (any that re-verified as blocked are logged and deferred — not partial-migrated).
- `pnpm test` + `pnpm lint` green (modulo the two pre-existing unrelated errors); legacy `AppService` + the 18 blocked consumers untouched.

## Risks & mitigations

- **SSR platform info** — `getPlatformInfo()` returns neutral web defaults on the server (consumers degrade like the legacy null path). If a consumer rendered platform-specific UI on the server before, behavior is equivalent (legacy gave `null` appService there too).
- **Runtime type unification** — if the two `ManagedRuntime` types don't unify, add a shared alias (Task 1 note).
- **Mis-classified consumer** — step 2 re-verification + BLOCKED bump prevents partial migration.
- **Behavior drift** — preserve each call site's async/throw contract; rely on existing tests; the two reviewed exemplars validate the recipe before fan-out.
- **Parallel safety** — distinct files; bridge files frozen before fan-out.
