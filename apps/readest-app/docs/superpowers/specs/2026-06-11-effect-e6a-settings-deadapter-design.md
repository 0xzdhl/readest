# Effect E6a — Settings De-adapter (remove `makeLegacyFsAdapter` from SettingsRepository)

**Date:** 2026-06-11
**Status:** Approved (brainstorm) → pending implementation plan
**Scope:** First sub-slice of E6 (remove the legacy-FileSystem compatibility layer). Rewrite `settingsService`'s fs-taking functions to be Effect-native (on the `FileSystem` + `PathResolver` ports), so `SettingsRepositoryLive` no longer needs `makeLegacyFsAdapter`. Establishes the template for E6b–E6e. The adapter file itself stays until E6e.

---

## 0. Context

The migration is complete (E1–E5b-3): the `AppService` god-object is gone; the live layers in `infra/shared/*` reuse the pure `@/services/*` functions through `makeLegacyFsAdapter` (`src/infra/shared/fsPortAdapter.ts`) — an adapter that makes the new Effect ports impersonate the old Promise-based `FileSystem` interface (`@/domain/system`'s `FileSystem`, aliased `LegacyFileSystem`).

E6 removes that compatibility layer by rewriting the reused functions to be Effect-native (decided in brainstorm). Removing it is the only way to eventually delete the legacy `FileSystem` interface from `domain/system.ts` and reach end-to-end Effect (typed errors, no `runPromise` islands).

E6 decomposes by service: **E6a Settings** (this) → E6b Font/Image/Dict → E6c Cloud → E6d Cover → E6e Book/Library. The adapter + `LegacyFileSystem` alias + the legacy `FileSystem` interface are deleted only in the **last** sub-slice (E6e), when their final user is gone.

---

## 1. Decisions (locked in brainstorm)

| #   | Decision            | Choice                                                                                                                                                                                                                                                     |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Rewrite form        | **Effect-native pure functions** — `fn(args): Effect.Effect<A, XxxError, FileSystem \| PathResolver \| …>` using `yield*` ports; placed in `application/`. The live-layer just provides the ports. The old `@/services/*` fs-taking functions are deleted. |
| 2   | Decomposition       | E6 = 5 sub-slices by service; **E6a Settings first** (smallest, isolated).                                                                                                                                                                                 |
| 3   | Adapter deletion    | Only in **E6e** (its last user). E6a leaves `fsPortAdapter.ts` untouched.                                                                                                                                                                                  |
| 4   | Shared JSON helpers | E6a adds an Effect-native JSON helper for settings; the old `persistence.ts` (`safeLoadJSON/safeSaveJSON`) is **left untouched** (other adapter-based services still use it) and deleted later.                                                            |
| 5   | Pure helpers        | `getDefaultViewSettings` + `migrateHighlightColorPrefs` stay pure functions (no fs); keep wherever their callers are.                                                                                                                                      |

---

## 2. Scope boundary

### In scope

- New Effect-native settings functions in `application/`:
  - `loadSystemSettings(platformInfo): Effect.Effect<SystemSettings, SettingsError, FileSystem | PathResolver>`
  - `saveSystemSettings(settings): Effect.Effect<void, SettingsError, FileSystem>`
- New Effect-native JSON helper (FileSystem-port based) used by the above: `safeLoadJsonE` / `safeSaveJsonE`.
- Rewrite `src/infra/shared/SettingsRepository.layer.ts` to drop `makeLegacyFsAdapter` and provide the ports to the new functions.
- Delete the fs-taking functions in `src/services/settingsService.ts` (`loadSettings`, `saveSettings`) once nothing else calls them; keep `getDefaultViewSettings`/`migrateHighlightColorPrefs` if still referenced.
- Tests: keep `settingsRepository.test.ts` + `bootApp.test.ts` green; add direct unit tests for the new functions.

### Out of scope

- `fsPortAdapter.ts` / `LegacyFileSystem` / the legacy `FileSystem` interface in `domain/system.ts` — deleted in E6e.
- `persistence.ts` — left untouched (used by other services via the adapter).
- All other services (E6b–E6e).

> Pre-flight (in the plan): `grep` every caller of `settingsService.loadSettings`/`saveSettings` and of `persistence.ts`. If a fs-taking settings function has callers _other_ than `SettingsRepositoryLive`, migrate or handle each (don't break them). If `persistence.ts` is settings-only, fold it into the new helper; if shared, leave it.

---

## 3. Architecture / wiring

The new functions declare their port needs in the `R` channel; the layer provides them from the resolved shapes:

```ts
// SettingsRepository.layer.ts (rewritten)
export const SettingsRepositoryLive = Layer.effect(
  SettingsRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem; // resolved shape
    const resolver = yield* PathResolver; // resolved shape
    const info = yield* (yield* Platform).info;

    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem | PathResolver>) =>
      e.pipe(
        Effect.provideService(FileSystem, fsPort),
        Effect.provideService(PathResolver, resolver),
      );

    return {
      load: provide(loadSystemSettings(info)),
      save: (s) => provide(saveSystemSettings(s)),
      getDefaultViewSettings: Effect.sync(() => getDefaultViewSettings(info)),
    } satisfies SettingsRepositoryShape;
  }),
);
```

- `loadSystemSettings(info)` reproduces the current `settingsService.loadSettings(ctx)` merge/normalize sequence **faithfully**: default-merge (incl. mobile overrides), `migrateHighlightColorPrefs`, `globalViewSettings`/`aiSettings` merge, `localBooksDir = yield* PathResolver.prefix('Books')`, `version` handling, `wikipedia→dictionary` quick-action coercion, `kosync.deviceId`/`replicaDeviceId` uuid generation + save-when-missing. Reads/writes via `yield* FileSystem` + `safeLoadJsonE`/`safeSaveJsonE`.
- `saveSystemSettings` = `safeSaveJsonE(SETTINGS_FILENAME, 'Settings', settings)`.
- The `Platform` dependency stays (for `isMobile/isEink/isAppDataSandbox`); `getDefaultViewSettings(info)` is pure.

## 4. Error handling

- Both functions surface failures as `SettingsError` in the typed channel (no more `tryPromise` re-wrapping at the layer). The FileSystem port's `FsError` is mapped to `SettingsError` (`Effect.mapError` / `catchTag`) at the function boundary, preserving the legacy "missing/corrupt file → defaults" semantics (absent file → defaults via the JSON helper's fallback, not an error).
- `safeLoadJsonE` mirrors `safeLoadJSON`: try main → try `.bak` (restore) → return `defaultValue`; never throws for absence.

## 5. Testing

- **Regression (TDD safety net):** `src/__tests__/application/settingsRepository.test.ts` + `bootApp.test.ts` must stay green throughout — they exercise `SettingsRepository.load/save` over the test runtime. Do the rewrite behind these.
- **New unit tests** (`settingsService` Effect functions, over `TestFileSystem` + `TestPathResolver` + a fixed `PlatformInfo`):
  - `saveSystemSettings`→`loadSystemSettings` round-trips a custom field.
  - `loadSystemSettings` with no file → defaulted settings (`version > 0`, `globalViewSettings`/`localBooksDir` defined).
  - corrupt main + valid `.bak` → restored.
- `pnpm exec tsgo --noEmit` clean (the layer + functions resolve to `R = never` at `ManagedRuntime.make`); `pnpm exec biome check` clean; `pnpm test` no new failures beyond documented flaky.

## 6. Done-conditions

- `SettingsRepository.layer.ts` no longer imports `makeLegacyFsAdapter`.
- `settingsService.loadSettings`/`saveSettings` (fs-taking) deleted; pure helpers kept iff still referenced.
- `grep -rc "makeLegacyFsAdapter" src` decreased by one usage; adapter file still present (E6b–E6e use it).
- Settings still load/save identically (regression tests + new unit tests green); tsgo + biome at baseline.

## 7. Risks

- **Behavioral divergence** from the rewrite — mitigated by the green-throughout regression tests + porting the sequence line-by-line against the source.
- **Hidden callers** of `settingsService`/`persistence` outside the Effect layer — plan greps and handles; don't delete a function with other live callers.
- **`R`-channel plumbing** — the layer must `provideService` both ports; tsgo enforces `never` at `ManagedRuntime.make`.
- **`localBooksDir` source** — must come from `PathResolver.prefix('Books')` (same value the legacy `fs.getPrefix('Books')` produced via the adapter); verify it matches.
