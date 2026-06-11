# E5b-3 — `envConfig` elimination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the vestigial `envConfig`/`EnvConfigType` threading (~336 call sites / ~78 files) and delete `EnvContext`/`EnvProvider`/`useEnv` — the migration's last cosmetic debt, zero behavior change.

**Architecture:** Signature refactor done in SEQUENTIAL per-store clusters (a method's `envConfig` param + all its call sites change together). `envConfig` is the FIRST param of essentially every definer method, so the transform is "drop the leading `envConfig` param and the leading `envConfig` arg." **tsgo is the safety net** — a wrongly-dropped arg mistypes the call, so `npx tsgo --noEmit` after each cluster catches any error before commit. Destructure/provider/interface deletions come LAST.

**Tech Stack:** TypeScript (strict), Effect, Zustand, React context, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-effect-e5b3-envconfig-elimination-design.md`

**THE MECHANICAL RULE (applies to every definer method below):**

1. In the store/helper, drop the `envConfig: EnvConfigType` / `_envConfig: EnvConfigType` param from BOTH the interface/type declaration AND the implementation (it's the FIRST param unless noted). Remove the `EnvConfigType` import if it becomes unused.
2. Find every caller: `grep -rn '<methodName>(' src --include=*.ts --include=*.tsx`. For each call `<methodName>(envConfig, ...rest)` → `<methodName>(...rest)` (drop the leading `envConfig` arg). For method calls via the store, the form is often `useXStore.getState().<method>(envConfig, …)` or `const { <method> } = useXStore(); <method>(envConfig, …)`.
3. Do NOT remove `const { envConfig } = useEnv()` yet (other stores' calls still use it) — that's the Task-7 sweep.
4. **Verify each cluster:** `npx tsgo --noEmit 2>&1 | grep -v upload-cjk-fonts-r2 | grep 'error TS'` → empty BEFORE committing. (tsgo errors here mean a mis-dropped arg — fix before commit.)

**Verify after every task:** the tsgo gate above.

---

## Task 1: `libraryStore` + `settingsStore` + `bookDataStore`

**Definer methods (drop leading `envConfig`):**

- `store/libraryStore.ts`: `updateBook(envConfig, book)`, `updateBooks(envConfig, …)` (interface ~41/43, impl ~131/149 use `_envConfig`).
- `store/settingsStore.ts`: `saveSettings(envConfig, settings)` (interface ~32, impl ~52 `_envConfig`).
- `store/bookDataStore.ts`: the method(s) at ~27 (`envConfig`) and ~78 (`_envConfig`) — grep `: EnvConfigType` in the file for the exact method names (`saveConfig`/`getConfig`).

- [ ] **Step 1: Drop the params** from the three stores' interface + impl per the rule.
- [ ] **Step 2: Fix callers.** For each method, `grep -rn '<method>(' src --include=*.ts --include=*.tsx | grep -v __tests__` and drop the leading `envConfig` arg at each. NOTE `helpers/settings.ts` wraps `saveSettings` — it has its OWN `envConfig` param (handled in Task 5); for now, inside `helpers/settings.ts` the call `saveSettings(envConfig, …)` → `saveSettings(…)` (drop the arg, but keep `helpers/settings.ts`'s own param until Task 5).
- [ ] **Step 3: Tests.** Update store tests that call these methods with an `envConfig` arg (`book-data-store.test.ts`, `library-store.test.ts` already pass `makeEnvConfig()` — drop that leading arg in the calls; the `makeEnvConfig` helper can stay until Task 8).
- [ ] **Step 4: tsgo gate (empty) + commit.**

```bash
git add -A && git commit -m "refactor(effect): drop envConfig param from library/settings/bookData stores (E5b-3)"
```

---

## Task 2: `customFontStore` + `customTextureStore`

**Definer methods (all take leading `envConfig`):**

- `customFontStore.ts`: `activateFontByContentId`, `loadFont`, `loadFonts`, `loadAllFonts`, `loadCustomFonts`, `saveCustomFonts` (interface ~57-70), `migrateLegacyFonts` (~424, exported fn).
- `customTextureStore.ts`: `activateTextureByContentId`, `applyTexture`, `loadTexture`, `loadTextures`, `loadAllTextures`, `loadCustomTextures`, `saveCustomTextures` (interface ~65-78), `migrateLegacyTextures` (~447, exported fn).

- [ ] **Step 1: Drop the params** (interface + impl) per the rule.
- [ ] **Step 2: Fix callers** — grep each method name, drop the leading `envConfig` arg. (Callers: `CustomFonts`/`CustomTextures` components, `useReplicaPull` adapters, `replicaBootstrap`, font/texture sync adapters.)
- [ ] **Step 3: Tests** — `custom-font-store.test.ts`/`custom-texture-store.test.ts` calls drop the leading arg.
- [ ] **Step 4: tsgo gate + commit.**

```bash
git add -A && git commit -m "refactor(effect): drop envConfig param from custom font/texture stores (E5b-3)"
```

---

## Task 3: `customDictionaryStore` + `customOPDSStore`

**Definer methods:**

- `customDictionaryStore.ts`: `loadCustomDictionaries(envConfig)` (~126) + the method at ~137.
- `customOPDSStore.ts`: `loadCustomOPDSCatalogs(envConfig)` (~85), `saveCustomOPDSCatalogs(envConfig)` (~87).

- [ ] **Step 1-4:** same rule — drop params, fix callers (grep each method), update `custom-dictionary-store.test.ts`/`custom-opds-store.test.ts`, tsgo gate, commit.

```bash
git add -A && git commit -m "refactor(effect): drop envConfig param from custom dictionary/OPDS stores (E5b-3)"
```

---

## Task 4: `readerStore` + `themeStore` + `proofreadStore`

**Definer methods:**

- `readerStore.ts`: `initViewState(envConfig, …)` (~90, impl ~136 `_envConfig`), `recreateViewer(envConfig, key)` (~102, impl ~511).
- `themeStore.ts`: the method at ~38 (`envConfig`) — grep the file for the exact name.
- `proofreadStore.ts`: many — `toggleRule(envConfig, bookKey, ruleId)` (~46) + the fns at ~30/35/41/141/177/196/214/268/289 + `addGlobalRule(envConfig, rule)` (~245) + `removeGlobalRule(envConfig, ruleId)` (~280). Grep `: EnvConfigType` in the file for the full list.

- [ ] **Step 1-4:** drop params, fix callers (grep each), update `proofread-store.test.ts` + reader/theme tests, tsgo gate, commit.

```bash
git add -A && git commit -m "refactor(effect): drop envConfig param from reader/theme/proofread stores (E5b-3)"
```

---

## Task 5: `helpers/settings.ts` + sync (`migrateLegacy`, `replicaSettingsSync`) + `useBackgroundTexture` + `useReplicaPull`

**Definer fns (each takes `envConfig`):**

- `helpers/settings.ts`: the fns at ~10 and ~63 (grep `: EnvConfigType`). These wrap store calls — after Tasks 1-4 the inner store calls no longer take envConfig, so these wrappers' `envConfig` param is now fully unused → drop it + fix callers.
- `services/sync/migrateLegacy.ts`: `saveStore(envConfig)` (~46, a callback type) + the fn at ~71.
- `services/sync/replicaSettingsSync.ts`: the fn at ~312.
- `hooks/useBackgroundTexture.ts`: `applyBackgroundTexture(envConfig, viewSettings)` (~9) — note `Providers.tsx` calls `applyBackgroundTexture(envConfig, globalViewSettings)`; drop the leading arg there.
- `hooks/useReplicaPull.ts`: the `envConfig` threading — `autoSyncContext: { envConfig }` (~95), `hydrateLocalStore?(envConfig)` (~128), and the fns at ~151/266/310/444/469. This file threads `envConfig` internally + into store adapters (font/texture/dict `loadX`/`saveX` callbacks). After Tasks 2-3 those store methods dropped envConfig, so the adapters' `envConfig` usage is now dead → remove the threading + the `{ envConfig }` context.

- [ ] **Step 1-4:** drop params/threading, fix callers (incl. `Providers.tsx` `applyBackgroundTexture`), update tests (`replicaSettingsSync.test.ts`, `useReplicaPull.test.tsx`, `migrateLegacy` tests), tsgo gate, commit.

```bash
git add -A && git commit -m "refactor(effect): drop envConfig from helpers/settings, sync, background-texture, replica-pull (E5b-3)"
```

---

## Task 6: `enableReplicaAutoPersist` + `EffectRuntimeProvider`

**Files:** `src/services/sync/replicaPersist.ts`, `src/context/EffectRuntimeProvider.tsx`

- [ ] **Step 1:** `replicaPersist.ts:17` `enableReplicaAutoPersist(envConfig: EnvConfigType | null)` → `enableReplicaAutoPersist()`. Remove the `EnvConfigType` import. (The body already ignores `envConfig` — confirm; if it reads `envConfig`, STOP and report, since the spec assumed vestigial.)
- [ ] **Step 2:** `EffectRuntimeProvider.tsx` — `enableReplicaAutoPersist(env)` → `enableReplicaAutoPersist()`; remove `import env from '@/services/environment';`.
- [ ] **Step 3: tsgo gate + commit.**

```bash
git add src/services/sync/replicaPersist.ts src/context/EffectRuntimeProvider.tsx
git commit -m "refactor(effect): drop envConfig from enableReplicaAutoPersist (E5b-3)"
```

---

## Task 7: Sweep residual `const { envConfig } = useEnv()`

At this point no fn/method takes `envConfig`, so every `const { envConfig } = useEnv()` destructure is unused.

- [ ] **Step 1: Find them.** `grep -rn 'useEnv()' src --include=*.ts --include=*.tsx | grep -v __tests__` (~61 files). For each: remove the `const { envConfig } = useEnv();` line and the `import { useEnv } from '@/context/EnvContext';` import. (Confirm via tsgo that `envConfig` was the only destructured name — it is, post-E5b.)
- [ ] **Step 2: Verify.** `grep -rn 'useEnv\|envConfig' src --include=*.ts --include=*.tsx | grep -v __tests__ | grep -v 'EnvContext.tsx\|environment.ts'` → empty (only the EnvContext/environment definitions remain, deleted next). tsgo gate.
- [ ] **Step 3: Commit** (may split into a few commits by directory if large).

```bash
git add -A && git commit -m "refactor(effect): remove now-unused useEnv()/envConfig destructures (E5b-3)"
```

---

## Task 8: Delete `EnvContext` + unwrap `__root` + `environment.ts` cleanup + tests

**Files:** `src/context/EnvContext.tsx` (delete), `src/app/__root.tsx`, `src/services/environment.ts`, test files.

- [ ] **Step 1: `__root.tsx`** — remove `import { EnvProvider } from '@/context/EnvContext';` and unwrap `<EnvProvider>…</EnvProvider>` so `<EffectRuntimeProvider>` is the outermost of that trio (lines ~37-44 → drop the `<EnvProvider>`/`</EnvProvider>` wrapper, keep its children).
- [ ] **Step 2: Delete `EnvContext.tsx`.** `git rm src/context/EnvContext.tsx`.
- [ ] **Step 3: `environment.ts`** — delete `export type EnvConfigType = …` and `const environmentConfig = {}; export default environmentConfig;` (keep every URL/platform helper). Confirm no surviving importer of the default export or `EnvConfigType`: `grep -rn "from '@/services/environment'" src | grep -v __tests__` should show only named-helper imports.
- [ ] **Step 4: Tests** — remove the `makeEnvConfig`/`EnvConfigType`/`useEnv` mock scaffolding from the store/proofread/replica/component tests (the helpers that returned `{} as EnvConfigType`, and any `vi.mock('@/context/EnvContext')`). `grep -rn 'EnvConfigType\|useEnv\|EnvProvider\|EnvContext' src/__tests__` → empty.
- [ ] **Step 5: tsgo gate + commit.**

```bash
git add -A && git commit -m "refactor(effect): delete EnvContext/EnvProvider/useEnv + EnvConfigType (E5b-3)"
```

---

## Task 9: Final verification + memory

- [ ] **Step 1: Done-condition grep.**

Run: `grep -rnE 'envConfig|EnvConfigType|EnvProvider|EnvContext|useEnv\b' src --include=*.ts --include=*.tsx | grep -v __tests__`
Expected: **empty**.
Run: `grep -rn 'envConfig\|EnvConfigType\|useEnv\|EnvProvider\|EnvContext' src/__tests__` → empty.

- [ ] **Step 2: Lint.** `pnpm lint` → only the pre-existing `SettingsDialog.tsx` baseline (and `upload-cjk-fonts-r2.ts` tsgo).

- [ ] **Step 3: Tests.** `pnpm test` → green except the known env-flaky set. Investigate any NEW failure (likely a missed call-site arg or a test mock).

- [ ] **Step 4: Update memory** `project_effect_client_foundation.md`: E5b-3 DONE — `envConfig`/`EnvContext` fully removed; the migration + its cleanup are 100% complete (only Node infra + arch-doc Server API remain as separate future work).

```bash
git add docs/superpowers && git commit -m "docs(effect): record E5b-3 completion"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Tasks 1-5 = §2.1 (param drop + callers) across the 16 definers. Task 6 = §2.4 (enableReplicaAutoPersist). Task 7 = §2.2 (destructure sweep). Task 8 = §2.3/2.5 (EnvContext + environment + \_\_root) + §2.6 (tests). Task 9 = §Verification.
- **Ordering is load-bearing:** Tasks 1-5 (drop method params) MUST precede Task 7 (remove destructures) — the destructures stay valid until no method needs `envConfig`. Task 6 before Task 8 (environment default export unused only after enableReplicaAutoPersist drops it). Task 8 last (deletes the provider everything stopped using).
- **Safety net:** every cluster ends with a tsgo gate — a mis-dropped or mis-positioned arg mistypes the call and tsgo catches it before commit. This is what makes the manual sweep safe.
- **Watch items:** a few methods use `_envConfig` (already underscore-unused) — still the FIRST param, drop it the same way. `helpers/settings.ts` wrappers + `useReplicaPull` thread `envConfig` deeper than one hop — drop the whole chain in Task 5. Zero behavior change anywhere; review for accidental non-`envConfig` arg drops only.
