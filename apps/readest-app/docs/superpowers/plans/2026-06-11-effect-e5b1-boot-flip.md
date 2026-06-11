# E5b-1 — Boot-flip (BootApp authoritative) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `BootApp` (run by `EffectRuntimeProvider`) the authoritative app boot and replace every `appService`-as-readiness check with one `booted` signal — behavioral only, no deletions — landing a green, app-runnable checkpoint before E5b-2's deletes.

**Architecture:** `EffectRuntimeProvider` runs `BootApp` for real, exposes `useBooted()`/`useBootSettings()`, and (atomically, last) takes over the replica-sync boot from `EnvContext`. `Providers` publishes settings + gates the shell on `booted`/`useBootSettings()` instead of `appService.loadSettings()`. The 24 readiness gates swap `useEnv().appService` → `useBooted()`. `EnvContext` goes thin (`{ envConfig }`).

**Tech Stack:** TypeScript (strict, no `any`), Effect, React context/hooks, Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-effect-e5b1-boot-flip-design.md`

**Commit ordering (critical — avoid transient double-boot):**

1. Task 1 — `EffectRuntimeProvider` exposes `booted`/`bootSettings` + runs `BootApp` authoritative (no replica move yet). Migrations already run via both BootApp-observe + legacy today and are version-idempotent, so authoritative BootApp adds no new double-run.
2. Task 2 — `Providers` consumes `booted`/`bootSettings`.
3. Task 3 — the 24-gate sweep → `useBooted()`.
4. Task 4 — ATOMIC: `EffectRuntimeProvider` gains the replica-sync boot AND `EnvContext` loses it + `appService` + `getAppService` (one commit, so the replica boot runs in exactly one place at every commit).
5. Task 5 — verify (lint + test + **app run**) + memory.

**Verify after every code task:** `npx tsgo --noEmit 2>&1 | grep -v upload-cjk-fonts-r2 | grep 'error TS'` → empty.

---

## Task 1: `EffectRuntimeProvider` — `booted` + `bootSettings` + authoritative BootApp

**Files:**

- Modify: `src/context/EffectRuntimeProvider.tsx`
- Test: `src/__tests__/context/effect-runtime-provider.test.tsx` (create if absent)

- [ ] **Step 1: Rewrite the provider** to run `BootApp` authoritatively and expose the signal. Current file ends the boot effect with an observe-only `.then(log)`. Replace the context value + boot effect:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Effect } from 'effect';
import { type ClientServices, getClientRuntime, getPlatformInfo } from '@/runtime/clientRuntime';
import type { PlatformInfo } from '@/application/ports/Platform';
import type { SystemSettings } from '@/domain/settings';
import { BootApp } from '@/application/usecases/boot/BootApp';

type RunEffect = <A, E>(program: Effect.Effect<A, E, ClientServices>) => Promise<A>;

interface RuntimeContextValue {
  readonly platformInfo: PlatformInfo;
  readonly runEffect: RunEffect;
  readonly booted: boolean;
  readonly bootSettings: SystemSettings | null;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function EffectRuntimeProvider({ children }: { children: ReactNode }) {
  const platformInfo = getPlatformInfo(); // sync (SSR-safe defaults)
  const runEffect = useCallback<RunEffect>((program) => getClientRuntime().runPromise(program), []);
  const [booted, setBooted] = useState(false);
  const [bootSettings, setBootSettings] = useState<SystemSettings | null>(null);

  const started = useRef(false);
  useEffect(() => {
    if (started.current || typeof window === 'undefined') return;
    started.current = true;
    // Authoritative boot: load platform+settings, apply customRootDir, run
    // migrations (version-idempotent), then flip `booted`. On failure leave
    // booted=false (faithful to the legacy null-appService pre-boot state).
    getClientRuntime()
      .runPromise(BootApp)
      .then((r) => {
        setBootSettings(r.settings);
        setBooted(true);
      })
      .catch((err) => console.warn('[EffectBoot] failed (non-fatal)', err));
  }, []);

  return (
    <RuntimeContext.Provider value={{ platformInfo, runEffect, booted, bootSettings }}>
      {children}
    </RuntimeContext.Provider>
  );
}

export const useRunEffect = (): RunEffect => {
  const ctx = useContext(RuntimeContext);
  return ctx?.runEffect ?? ((program) => getClientRuntime().runPromise(program));
};
export const usePlatformInfo = (): PlatformInfo => {
  const ctx = useContext(RuntimeContext);
  return ctx?.platformInfo ?? getPlatformInfo();
};
export const useBooted = (): boolean => {
  const ctx = useContext(RuntimeContext);
  return ctx?.booted ?? false;
};
export const useBootSettings = (): SystemSettings | null => {
  const ctx = useContext(RuntimeContext);
  return ctx?.bootSettings ?? null;
};
```

(Keep any other existing exports/comments in the file that aren't shown here.)

- [ ] **Step 2: Confirm `BootApp` returns `{ platform, settings }`.**

Run: `sed -n '1,30p' src/application/usecases/boot/BootApp.ts`
Expected: `return { platform: info, settings };` where `settings` is `SystemSettings` (from `settingsRepo.load`).

- [ ] **Step 3: Write the test.**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EffectRuntimeProvider, useBooted, useBootSettings } from '@/context/EffectRuntimeProvider';

const settings = { foo: 'bar' } as unknown as import('@/domain/settings').SystemSettings;
vi.mock('@/runtime/clientRuntime', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getClientRuntime: () => ({ runPromise: () => Promise.resolve({ platform: {}, settings }) }),
    getPlatformInfo: () => ({ isMobile: false }),
  };
});

const Probe = () => {
  const booted = useBooted();
  const bs = useBootSettings();
  return (
    <div data-testid='probe'>
      {booted ? `booted:${bs ? 'has-settings' : 'no-settings'}` : 'pending'}
    </div>
  );
};

describe('EffectRuntimeProvider boot', () => {
  it('flips booted=true and exposes bootSettings after BootApp resolves', async () => {
    render(
      <EffectRuntimeProvider>
        <Probe />
      </EffectRuntimeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('booted:has-settings'),
    );
  });

  it('useBooted falls back to false outside the provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('pending');
  });
});
```

- [ ] **Step 4: Run test + tsgo.**

Run: `npx vitest run src/__tests__/context/effect-runtime-provider.test.tsx` → PASS.
Run: `npx tsgo --noEmit 2>&1 | grep -v upload-cjk-fonts-r2 | grep 'error TS'` → empty.

- [ ] **Step 5: Commit.**

```bash
git add src/context/EffectRuntimeProvider.tsx src/__tests__/context/effect-runtime-provider.test.tsx
git commit -m "feat(effect): EffectRuntimeProvider runs BootApp authoritative, exposes useBooted/useBootSettings (E5b-1)"
```

---

## Task 2: `Providers` — settings-publish + shell gate on `booted`

**Files:**

- Modify: `src/components/Providers.tsx`

- [ ] **Step 1: Swap the readiness source.** Replace `const { envConfig, appService } = useEnv();` with `const { envConfig } = useEnv();` and add (after the other hooks) `const booted = useBooted(); const bootSettings = useBootSettings();`. Add `import { useBooted, useBootSettings } from '@/context/EffectRuntimeProvider';` (alongside the existing import if any).

- [ ] **Step 2: Rewrite the boot effect** (current lines ~62–100) to consume `bootSettings`:

```tsx
useEffect(() => {
  loadDataTheme();
  if (!booted || !bootSettings) return;
  initSystemThemeListener();
  const settings = bootSettings;
  const globalViewSettings = settings.globalViewSettings;
  applyUILanguage(globalViewSettings.uiLanguage);
  applyBackgroundTexture(envConfig, globalViewSettings);
  if (globalViewSettings.isEink) {
    applyEinkMode(true);
  }
  initializeAppLock({
    enabled: !!settings.pinCodeEnabled,
    hash: settings.pinCodeHash,
    salt: settings.pinCodeSalt,
  });
  initSettingsSync(settings);
}, [
  booted,
  bootSettings,
  envConfig,
  applyUILanguage,
  applyBackgroundTexture,
  applyEinkMode,
  initializeAppLock,
]);
```

(Preserve the explanatory comments about `initializeAppLock`/`initSettingsSync` from the original.)

- [ ] **Step 3: Flip the shell gate** (lines ~127–128):

```tsx
const showAppLockScreen = booted && isLockInitialized && !isUnlocked;
const appShellHidden = booted && (!isLockInitialized || !isUnlocked);
```

- [ ] **Step 4: Verify + commit.**

Run: `grep -n 'appService' src/components/Providers.tsx` → empty.
Run tsgo → empty. (Any Providers test that mocked `useEnv().appService`: rebridge to mock `useBooted`/`useBootSettings` from `@/context/EffectRuntimeProvider`. Run it.)

```bash
git add src/components/Providers.tsx
git commit -m "refactor(effect): Providers publishes boot settings + gates shell on booted (E5b-1)"
```

---

## Task 3: The 24-gate sweep → `useBooted()`

**Files (modify each):** `app/library/index.tsx`, `app/library/components/BackupWindow.tsx`, `app/library/components/SettingsMenu.tsx`, `app/opds/index.tsx`, `app/opds/components/CatalogManager.tsx`, `app/opds/components/FailedDownloadsDialog.tsx`, `app/reader/components/ReaderContent.tsx`, `app/reader/hooks/useKOSync.ts`, `components/settings/CustomFonts.tsx`, `components/settings/ColorPanel.tsx`, `components/settings/CustomDictionaries.tsx`, `hooks/useOpenShareLink.ts`, `hooks/useOPDSSubscriptions.ts`, `hooks/useReplicaPull.ts`, `hooks/useTransferQueue.ts`.

**Transformation per file:** add `import { useBooted } from '@/context/EffectRuntimeProvider';` + `const booted = useBooted();`. Replace the `appService`-readiness expression with `booted`:

| File:line                                          | before → after                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/library/index.tsx:920`                        | `if (!appService \|\| !insets \|\| …)` → `if (!booted \|\| !insets \|\| …)`                                                                              |
| `app/library/components/BackupWindow.tsx:80`       | `if (!appService) return;` → `if (!booted) return;`                                                                                                      |
| `app/library/components/BackupWindow.tsx:106`      | `if (!appService) return;` → `if (!booted) return;`                                                                                                      |
| `app/library/components/SettingsMenu.tsx:202`      | `if (!appService \|\| isRefreshingMetadata) return;` → `if (!booted \|\| isRefreshingMetadata) return;`                                                  |
| `app/opds/index.tsx:456`                           | `if (!appService \|\| !libraryLoaded) return;` → `if (!booted \|\| !libraryLoaded) return;`                                                              |
| `app/opds/index.tsx:558`                           | `if (!appService \|\| !libraryLoaded) return;` → `if (!booted \|\| !libraryLoaded) return;`                                                              |
| `app/opds/index.tsx:584`                           | `if (!appService) return url;` → `if (!booted) return url;`                                                                                              |
| `app/opds/components/CatalogManager.tsx:140`       | `if (!appService) return;` → `if (!booted) return;`                                                                                                      |
| `app/opds/components/CatalogManager.tsx:320`       | `if (appService) {…}` → `if (booted) {…}`                                                                                                                |
| `app/opds/components/FailedDownloadsDialog.tsx:24` | `if (!appService) return;` → `if (!booted) return;`                                                                                                      |
| `app/opds/components/FailedDownloadsDialog.tsx:41` | `if (!appService \|\| !state) return null;` → `if (!booted \|\| !state) return null;`                                                                    |
| `app/reader/components/ReaderContent.tsx:217`      | `if (appService) {…}` → `if (booted) {…}`                                                                                                                |
| `app/reader/hooks/useKOSync.ts:302`                | `if (!appService \|\| !kosyncClient \|\| …) return;` → `if (!booted \|\| !kosyncClient \|\| …) return;`                                                  |
| `components/settings/CustomFonts.tsx:78`           | `if (appService) void queueReplicaBinaryUpload(…)` → `if (booted) void queueReplicaBinaryUpload(…)`                                                      |
| `components/settings/ColorPanel.tsx:271`           | `if (appService) void queueReplicaBinaryUpload(…)` → `if (booted) void queueReplicaBinaryUpload(…)`                                                      |
| `components/settings/CustomDictionaries.tsx:437`   | `if (appService) void queueDictionaryBinaryUpload(…)` → `if (booted) void queueDictionaryBinaryUpload(…)`                                                |
| `components/settings/CustomDictionaries.tsx:443`   | `if (appService) void queueDictionaryBinaryUpload(…)` → `if (booted) void queueDictionaryBinaryUpload(…)`                                                |
| `hooks/useOpenShareLink.ts:61`                     | `if (!appService) return;` → `if (!booted) return;`                                                                                                      |
| `hooks/useOPDSSubscriptions.ts:25`                 | `if (!appService \|\| !libraryLoaded) return;` → `if (!booted \|\| !libraryLoaded) return;`                                                              |
| `hooks/useReplicaPull.ts:523`                      | `if (!appService) return;` → `if (!booted) return;`                                                                                                      |
| `hooks/useTransferQueue.ts:19`                     | `if (appService && envConfig) {…}` → `if (booted) {…}` (KEEP `envConfig` in the destructure — `updateBookFn` uses it at line 22; just drop `appService`) |

- [ ] **Step 1: Apply the transformation** to each file. For each: add the `useBooted` import + `const booted = useBooted();`; swap the gate expression; **drop `appService`** from the `useEnv()` destructure (keep `envConfig`/other names if still used — e.g. `useTransferQueue` keeps `envConfig`, `library/index` keeps `appService` ONLY if its readiness gate is the sole use — wait, after this swap library/index's gate uses `booted`, so drop `appService` there too; `library/index` keeps `envConfig`/`appService`? confirm: after the gate swap, `grep appService` in library/index → if only the gate used it, the destructure drops `appService`). Fix dep arrays: `appService` → `booted` (e.g. `useTransferQueue` dep `[appService, envConfig, …]` → `[booted, envConfig, …]`; `useReplicaPull` dep at 523's effect).

- [ ] **Step 2: Per-file grep gate.** For each file: `grep -n 'appService' <file>` → empty (or, for files that still legitimately use `appService` for a NON-readiness reason — there should be none left after E5a; if a grep is non-empty, investigate). For files keeping `envConfig`, confirm `useEnv` import stays.

- [ ] **Step 3: tsgo + tests.**

Run tsgo → empty. Rebridge any test mocking `useEnv().appService` as readiness → mock `useBooted` from `@/context/EffectRuntimeProvider`. `grep -rln 'appService' src/__tests__` for the touched components and fix the readiness mocks. Run the affected tests.

- [ ] **Step 4: Commit** (may split by area if large):

```bash
git add app/library app/opds app/reader components/settings hooks <touched>
git commit -m "refactor(effect): swap 24 appService readiness gates to useBooted (E5b-1)"
```

---

## Task 4: Move replica-sync boot to `EffectRuntimeProvider`; `EnvContext` goes thin (ATOMIC)

**Files:**

- Modify: `src/context/EffectRuntimeProvider.tsx`, `src/context/EnvContext.tsx`

This is ONE commit so the replica-sync boot runs in exactly one place.

- [ ] **Step 1: Add the replica-sync boot to `EffectRuntimeProvider`'s boot `.then`.** Extend the Task 1 boot effect: after `setBootSettings(r.settings); setBooted(true);`, run the moved boot. Add imports:

```tsx
import env from '@/services/environment';
import { bootstrapReplicaAdapters } from '@/services/sync/replicaBootstrap';
import { enableReplicaAutoPersist } from '@/services/sync/replicaPersist';
import { createSettingsCursorStore } from '@/services/sync/replicaCursorStore';
import { initReplicaSync } from '@/services/sync/replicaSync';
import { startReplicaTransferIntegration } from '@/services/sync/replicaTransferIntegration';
```

In the `.then((r) => { … })`:

```tsx
.then((r) => {
  setBootSettings(r.settings);
  setBooted(true);
  bootstrapReplicaAdapters();
  enableReplicaAutoPersist(env);
  try {
    if (r.settings.replicaDeviceId) {
      const ctx = initReplicaSync({
        deviceId: r.settings.replicaDeviceId,
        cursorStore: createSettingsCursorStore(),
      });
      ctx.manager.startAutoSync();
      startReplicaTransferIntegration();
    }
  } catch (err) {
    console.warn('replica sync init failed', err);
  }
})
```

- [ ] **Step 2: Make `EnvContext` thin.** Remove the `getAppService().then(...)` boot block, the `appService` state + `setAppService`, the replica imports now moved out (`bootstrapReplicaAdapters`/`enableReplicaAutoPersist`/`initReplicaSync`/`createSettingsCursorStore`/`startReplicaTransferIntegration`), and `import type { AppService }`. Result:

```tsx
import React, { createContext, type ReactNode, useMemo, useState } from 'react';
import env, { type EnvConfigType } from '../services/environment';

interface EnvContextType {
  envConfig: EnvConfigType;
}

const EnvContext = createContext<EnvContextType | undefined>(undefined);

export const EnvProvider = ({ children }: { children: ReactNode }) => {
  const [envConfig] = useState<EnvConfigType>(env);

  React.useEffect(() => {
    window.addEventListener('error', (e) => {
      if (e.message === 'ResizeObserver loop limit exceeded') {
        e.stopImmediatePropagation();
        e.preventDefault();
        return true;
      }
      return false;
    });
  }, []);

  const value = useMemo(() => ({ envConfig }), [envConfig]);
  return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>;
};

export const useEnv = (): EnvContextType => {
  const context = useContext(EnvContext);
  if (!context) {
    if (typeof document === 'undefined') {
      return { envConfig: {} as EnvConfigType };
    }
    throw new Error('useEnv must be used within EnvProvider');
  }
  return context;
};
```

(Add `useContext` to the React import.)

- [ ] **Step 3: Verify no consumer reads `appService`.**

Run: `grep -rn 'useEnv().appService\|\.appService' src --include=*.ts --include=*.tsx | grep -v __tests__ | grep -vE 'appService\.ts|nativeAppService|webAppService|nodeAppService|cloudService\.ts|domain/system\.ts|environment\.ts|CloudService\.layer|storage\.ts|DictionaryResultsView|FontDropDown|autoDownload|opds/index'`
Expected: empty (no consumer reads `appService` off the context). If any hit, it's a missed gate — fix it.

Run: `grep -rn 'getAppService' src --glob '!**/__tests__/**'` → only `src/services/environment.ts`.

- [ ] **Step 4: tsgo + tests + commit.**

Run tsgo → empty. Rebridge EnvContext tests (the provider shape changed to `{ envConfig }`; any test asserting `appService` from `useEnv` updates). Run affected tests.

```bash
git add src/context/EffectRuntimeProvider.tsx src/context/EnvContext.tsx <touched tests>
git commit -m "refactor(effect): move replica-sync boot to EffectRuntimeProvider; EnvContext goes thin (E5b-1)"
```

---

## Task 5: Verification + app run + memory

- [ ] **Step 1: Full lint.** `pnpm lint` → only the 2 pre-existing baseline errors (`upload-cjk-fonts-r2.ts`, `SettingsDialog.tsx` lazy).

- [ ] **Step 2: Full tests.** `pnpm test` → green except the known env-flaky set (opds-req/hardcover/edgeTTS/turso-node + theme-store/useBookShortcuts collection). Investigate any NEW failure (likely a readiness-mock rebridge missed).

- [ ] **Step 3: Done-condition greps.**
  - `grep -rn 'getAppService' src --glob '!**/__tests__/**'` → only `src/services/environment.ts`.
  - `grep -rnE 'useEnv\(\)\.appService|appService\b' src --include=*.ts --include=*.tsx | grep -v __tests__ | grep -vE 'appService\.ts|native|web|nodeAppService|cloudService\.ts|domain/system\.ts|environment\.ts|CloudService\.layer|storage\.ts|DictionaryResultsView|FontDropDown|autoDownload|opds/index'` → empty (no readiness/consumer reads).

- [ ] **Step 4: APP RUN (the irreversible-delete gate).** Use the project's run tooling (see `.claude` skills / `pnpm dev-web`). Confirm:
  1. Shell renders after boot (no permanent blank).
  2. Settings apply (UI language, theme, eink if set).
  3. **App-lock gate:** with a PIN-enabled profile, the shell stays hidden until the lock screen shows; unlocking reveals it. (The most behavior-sensitive moved piece.)
  4. Library page loads.
  5. **Replica sync inits** for a sync-enabled profile (no `replica sync init failed` console error; the boot path runs once).
     Capture a screenshot or note of each. If any fails, STOP — fix before E5b-2.

- [ ] **Step 5: Update memory** `project_effect_client_foundation.md` with E5b-1 DONE (BootApp authoritative + `booted` signal + replica-boot moved + EnvContext thin; app-run verified) and that E5b-2 (deletion) is next.

```bash
git add docs/superpowers
git commit -m "docs(effect): record E5b-1 completion"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Task 1 = §1 (EffectRuntimeProvider boot owner + hooks). Task 2 = §2 (Providers). Task 3 = §4 (24-gate sweep). Task 4 = §1 replica-move + §3 (EnvContext thin). Task 5 = §6 (testing + app run) + verification.
- **Ordering:** Task 4 (remove EnvContext.appService) MUST come after Tasks 2+3 (no consumer reads appService). The replica-boot move is atomic (Task 4 single commit) to avoid double-boot. Task 1 before all (provides the hooks).
- **Type consistency:** `useBooted(): boolean`, `useBootSettings(): SystemSettings | null` (from `@/context/EffectRuntimeProvider`), `SystemSettings` from `@/domain/settings`. `BootApp` returns `{ platform, settings }`.
- **Watch items:** `useTransferQueue` KEEPS `envConfig` (used in `updateBookFn`); only its gate + `appService` drop. `library/index` keeps `envConfig` (used elsewhere) but drops `appService`. The app-lock gate timing is the #1 manual-verify risk. Migrations are version-idempotent so authoritative BootApp + still-live legacy boot (until E5b-2) don't double-apply.
