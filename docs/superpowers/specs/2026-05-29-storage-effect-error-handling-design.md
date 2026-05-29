# Functional error handling for `runStorageProgram`

Date: 2026-05-29

## Problem

The storage layer was migrated to Effect TS (`src/storage/*`), but every caller of
`runStorageProgram` still wraps it in `try/catch` and discriminates errors with
`instanceof` (e.g. `err instanceof StorageNotFoundError`). This throws away the
typed error channel Effect provides:

- `runStorageProgram` calls `Effect.runPromise`, which **rejects** on any typed
  failure. Callers must `try/catch` and lose the static type of the error.
- `StorageConfigLive` uses `Layer.sync(makeStorageConfig)`, and `makeStorageConfig`
  *throws* `StorageConfigError`. That makes config failures **defects**, not typed
  failures — they are invisible to `Effect.either`. The two public share routes
  (`share/$token/cover`, `share/$token/download`) have no outer `try/catch`, so a
  misconfiguration there is only caught by the storage-specific `try/catch`.

## Goal

Surface storage errors as **values** (`Either`) rather than thrown exceptions, and
discriminate them functionally via the typed `_tag`. Remove storage-specific
`try/catch` at call sites.

## Design

### 1. `runStorageProgram` returns `Either`

`src/storage/run.ts`:

```ts
import { Effect, Either } from 'effect';

export type StorageError =
  | StorageSignError
  | StorageRequestError
  | StorageNotFoundError
  | StorageConfigError;

export const runStorageProgram = <A>(
  program: Effect.Effect<A, StorageError, ObjectStorage>,
): Promise<Either.Either<A, StorageError>> =>
  Effect.runPromise(program.pipe(Effect.provide(StorageLive), Effect.either));
```

`Effect.either` converts `Effect<A, E, R>` to `Effect<Either<A, E>, never, R>`, so
the promise never rejects for a typed failure. Genuine defects (programmer bugs)
still reject — they should surface, not be swallowed.

`StorageError` is exported from `src/storage/index.ts` for callers.

### 2. Config errors become typed failures

`src/storage/config.ts`:

```ts
export const StorageConfigLive = Layer.effect(
  StorageConfig,
  Effect.try({
    try: makeStorageConfig,
    catch: (e) => (e instanceof StorageConfigError ? e : new StorageConfigError(String(e))),
  }),
);
```

Providing this layer widens the program's error channel to include
`StorageConfigError`, so `Effect.either` captures it. `makeStorageConfig` is
unchanged (it still throws; the `Effect.try` adapts it).

### 3. Call-site rewrites

Two shapes:

- **Leaf "success-or-500"** (`share/$token/cover`, `share/$token/download`,
  `share/$token/og.png/render`): use `Either.match({ onLeft, onRight })` to produce
  the `Response` directly.
- **Interleaved with DB writes** (`storage/upload`, `storage/download`
  `processFileKeys`, `storage/delete`, `storage/purge`): use an `Either.isLeft`
  early-return guard, then read `result.right`. Reads cleaner than nesting DB
  awaits inside `onRight`.
- **Tag-discriminating** (`share/$token/import` book-copy → 410,
  `share/create` headObject → 409): replace `instanceof StorageNotFoundError` with
  exhaustive `result.left._tag === 'StorageNotFoundError'`. Drop the now-unused
  `StorageNotFoundError` import. The `import` cover-copy (best-effort) becomes
  `Either.isRight(...)` → insert row; else log non-fatal.

The `Effect.catchTag('StorageNotFoundError', () => Effect.void)` already used inside
the `delete`/`purge` programs stays — it is already functional.

Outer `try/catch` blocks that also guard JSON parsing or DB queries (unrelated to
storage) stay.

### 4. Tests

- Update the existing module-boundary mocks to resolve `Either.right(...)`:
  `storage.test.ts:108,131,155` and `share.test.ts:126` (import `Either` from
  `effect`).
- Add `src/__tests__/storage/run.test.ts` (no DB): a failing Effect yields
  `Either.left` with the correct `_tag`; a succeeding one yields `Either.right`;
  a config-failure program surfaces as `Either.left` tagged `StorageConfigError`.

## Verification

- `pnpm test`
- `pnpm lint` (Biome + tsgo, strict, no `any`)

## Out of scope

- Wrapping Drizzle (`tx`) in Effect.
- Moving full HTTP `Response` construction into the Effect pipeline.
