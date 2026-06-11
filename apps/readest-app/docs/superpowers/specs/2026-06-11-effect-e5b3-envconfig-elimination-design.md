# E5b-3 — `envConfig` elimination (final cosmetic cleanup)

**Branch:** `effect/domain-type-migration`
**Status:** design approved 2026-06-11
**Predecessors:** E1–E5b-2 — all done. The client-side Effect strangler is COMPLETE; the god-objects are gone and `EnvConfigType` is already an empty `Record<string, never>`. This slice removes the leftover vestigial `envConfig` threading.

## Goal

Eliminate the now-purposeless `envConfig`/`EnvConfigType` (513 refs / ~78 files) and delete `EnvContext`/`EnvProvider`/`useEnv`. **Purely cosmetic — zero behavior change**: `EnvConfigType` is `Record<string, never>`, every `envConfig` is dead pass-through, and `useEnv()` now returns only `{ envConfig }` (nothing reads anything else from it). After this, the migration has no vestigial surface left.

In scope:

- Drop the `envConfig`/`_envConfig` param from the ~16 definer files' fns/methods + the leading `envConfig` arg at every call site.
- Remove `const { envConfig } = useEnv()` from the ~61 consumers + the now-unused `useEnv` import.
- Delete `src/context/EnvContext.tsx` (`EnvProvider`/`useEnv`/`EnvContextType`) + the `<EnvProvider>` mount in `src/app/__root.tsx`.
- Drop the `envConfig` param from `enableReplicaAutoPersist` + update its `EffectRuntimeProvider` caller (drop the arg + `import env`).
- Delete `EnvConfigType` + the default `environmentConfig = {}` export from `services/environment.ts` (keep all URL/platform helpers).
- Clean test mocks of `envConfig`/`EnvConfigType`/`useEnv`.

Out of scope: any behavior change; the runtime/ports/boot (untouched); the non-`envConfig` parts of every file.

## Why this shape (decision log)

- **Total elimination, not just emptying.** Every `useEnv()` consumer now destructures only `{ envConfig }` (verified: post-E5b, `useEnv` provides nothing else). So once `envConfig` params/args/destructures are gone, `EnvContext`/`EnvProvider`/`useEnv`/`EnvContextType` have zero remaining purpose — delete them. Leaving an empty provider would be its own debt.
- **Sequential per-cluster, not parallel.** Unlike the E5a platform-flag sweep (independent per-site reads), this is a SIGNATURE refactor: dropping a store method's `envConfig` param requires its definition AND every call site to change in the same commit (else tsgo breaks). A single caller file often calls several different stores, so two parallel subagents would edit the same file → conflict. Execute sequentially in clusters (each: one definer-store's methods + all their callers), then the `EnvContext`/`environment`/`__root` deletion last. (Considered: a `ts-morph` codemod that removes a leading `envConfig`-named param from flagged functions + the first arg at call sites — viable if the per-cluster manual sweep proves too tedious; the plan picks.)
- **Param-drop changes arg positions.** Most definers take `envConfig`/`_envConfig` as the FIRST param (e.g. `updateBook(envConfig, book)` → `updateBook(book)`; `saveSettings(envConfig, ...)` → `saveSettings(...)`). Dropping it shifts the remaining args — every call site drops exactly the leading `envConfig` arg. Watch for methods where `envConfig` is NOT first (the plan enumerates each signature).
- **`enableReplicaAutoPersist`/environment.** `enableReplicaAutoPersist(envConfig)` ignores its arg (vestigial); drop the param. Its only caller is `EffectRuntimeProvider` (E5b-1), which passes `env` (the `environment` default export). Drop that arg + the `import env from '@/services/environment'`. Then `environment.ts`'s default export is unused → delete it + `EnvConfigType`.

## Components & sequence

The ~16 definer files (each: drop the param from its exported fns/methods, then fix all callers):
`store/{customDictionaryStore,customFontStore,customOPDSStore,customTextureStore,bookDataStore,libraryStore,settingsStore,readerStore,themeStore,proofreadStore}`, `helpers/settings.ts`, `services/sync/{migrateLegacy,replicaPersist,replicaSettingsSync}.ts`, `hooks/{useBackgroundTexture,useReplicaPull}.ts`.

### Sequence (each step green; do deletions last)

1. **Per-definer-cluster commits:** for each definer file, drop the `envConfig`/`_envConfig` param from every fn/method it exports, and update EVERY caller (drop the leading `envConfig` arg; if the caller's `envConfig` came from `useEnv()` and this was its only use, also drop the destructure + `useEnv` import). Group so each commit is tsgo-green. (Callers span the ~61 `useEnv` consumers + intra-store calls.)
2. **Sweep residual `const { envConfig } = useEnv()`** in any consumer where it's now unused (left from step 1) → remove it + the `useEnv` import.
3. **`enableReplicaAutoPersist`** param drop + `EffectRuntimeProvider` caller (drop arg + `import env`).
4. **Delete `EnvContext.tsx`** + unwrap `<EnvProvider>` in `__root.tsx` (the child `EffectRuntimeProvider` becomes the outer provider).
5. **`environment.ts`:** delete `EnvConfigType` + the default export. Update the ~18 `EnvConfigType` importers (they're the definer files from step 1 — their imports become unused once the params are gone).
6. **Tests:** remove `envConfig`/`EnvConfigType`/`useEnv`-mock scaffolding (the store/proofread/replica tests that built `{} as EnvConfigType` or mocked `useEnv`).

## Verification (done-conditions)

- `grep -rnE 'envConfig|EnvConfigType|EnvProvider|EnvContext|useEnv\b' src --include=*.ts --include=*.tsx | grep -v __tests__` → empty.
- `grep -rn 'useEnv' src/__tests__` → empty (or only genuinely unrelated).
- tsgo 0-new; biome only the pre-existing `SettingsDialog` baseline.
- `pnpm test` green except the known env-flaky set.
- No Rust/Lua touched.

## Risks

- **Arg-position shifts** are the only real hazard: dropping a non-first `envConfig` param, or missing a call site, mistypes the call. The plan enumerates each definer's exact signature + the grep to find every caller; each cluster verifies with tsgo before commit.
- **Large diff, zero behavior change** — review focuses on "did any non-`envConfig` arg get dropped/reordered by mistake?", not logic.
