# Effect Object Storage Worker-Safe Design

**Status:** Drafted (pending user review)
**Date:** 2026-05-26 (revised 2026-05-27)
**Branch:** `fix/s3-storage`
**Scope:** Replace the current `utils/object.ts` + `utils/s3.ts` + `utils/r2.ts` + `utils/storage.ts` stack with a single Effect-based `ObjectStorage` service backed by one `aws4fetch`-based S3-compatible provider. Unify R2/S3 file_key naming. Remove `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` from dependencies.

---

## 1. Goals and Non-Goals

### Goals

- Eliminate SSR-time runtime failures caused by `@aws-sdk/client-s3` bundling under TanStack Start + Vite Cloudflare plugin.
- Replace the split `s3.ts` / `r2.ts` implementations with one S3-compatible provider.
- Expose storage as an Effect service (`ObjectStorage`) with typed errors, ready to be consumed directly by the future Effect-based sync pipeline.
- Unify `file_key` naming so the choice of backend (R2 vs S3) is a config detail, not a domain detail.
- Fully migrate all server-side callers; delete the old utilities.
- Remove `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` from `package.json`. Keep `aws4fetch`.

### Non-Goals

- Rewriting `cloudService` / `transferManager` / `appService` into Effect.
- Client-side direct signing.
- Multipart upload support.
- Streaming upload/download via the service (clients hit presigned URLs directly).
- Adding `listObjects` / `putObject(bytes)` — not needed by any route.
- Browser-side storage adapters.

---

## 2. Problem Statement

The current stack imports `@aws-sdk/client-s3` inside the TanStack Start server graph. Under Vite + Cloudflare `ssr`, the dependency is resolved through a workerd-oriented SSR bundle path and fails at runtime with:

```txt
TypeError: __vite_ssr_import_11__.u is not a function
```

Moving `S3Client` construction into middleware does not fix this — the failure happens during SSR resolution, not at instance construction.

Beyond the immediate bug, the existing stack has structural problems:

- Two implementations (`s3.ts` using `@aws-sdk`, `r2.ts` using `aws4fetch`) returning different shapes (SDK object vs `Response`), forcing callers to sniff types.
- `objectExists()` differs between providers: S3 throws on 404, R2 returns a `Response` with `.ok === false`.
- `getRemoteBookFilename()` branches on provider, baking storage choice into domain naming.

The fix needs to be worker-safe **and** clean up these structural issues, because sync is scheduled to be rewritten in Effect TS next — and we don't want sync to inherit either a leaky abstraction or a second migration.

---

## 3. Architecture

```
TanStack Start routes
        │
        ▼
   runStorageProgram(<Effect>)         ← route-only boundary helper
        │
        ▼
   Effect.runPromise(program.pipe(
     Effect.provide(StorageLive)
   ))
        │
        ▼
ObjectStorage service (Context.Tag)    ← 5 capability methods, typed errors
        │
        ▼
S3CompatibleStorageLive                ← aws4fetch implementation
        │
        ▼
StorageConfig service                  ← env-derived
```

### Key decisions

1. **Single provider, multiple configs.** R2 and S3 share one `aws4fetch`-backed implementation. They differ in `endpoint`, `region`, `bucket`, and credentials.
2. **Effect at storage boundary, not project-wide.** Routes remain TanStack Start handlers. Storage is the first Effect service that future Effect modules (sync) will compose with.
3. **Worker-safe signer (aws4fetch) over `@aws-sdk/*`.** `fetch + WebCrypto` only, no Node built-ins, no SDK bundle.
4. **No compatibility facade.** Old utility files are deleted.
5. **Sync-aware design.** `runStorageProgram` is a route-only convenience. Sync (future) composes `ObjectStorage` directly inside its own `Effect.gen` and provides `StorageLive` at its own entry point.
6. **HTTP mapping lives in routes**, not the service. Sync's mapping (retry / drop / fatal) will differ from routes' (4xx / 5xx).

---

## 4. Service Contracts

### 4.1 `ObjectStorage`

```ts
// @/storage/service.ts
export class ObjectStorage extends Context.Tag('ObjectStorage')<
  ObjectStorage,
  {
    readonly getUploadSignedUrl: (
      fileKey: string,
      contentLength: number,
      expiresIn: number,
      bucketName?: string,
    ) => Effect.Effect<string, StorageSignError>;

    readonly getDownloadSignedUrl: (
      fileKey: string,
      expiresIn: number,
      bucketName?: string,
    ) => Effect.Effect<string, StorageSignError>;

    readonly deleteObject: (
      fileKey: string,
      bucketName?: string,
    ) => Effect.Effect<void, StorageRequestError | StorageNotFoundError>;

    readonly headObject: (
      fileKey: string,
      bucketName?: string,
    ) => Effect.Effect<void, StorageRequestError | StorageNotFoundError>;

    readonly copyObject: (
      sourceFileKey: string,
      destFileKey: string,
      bucketName?: string,
      sourceBucketName?: string,
    ) => Effect.Effect<void, StorageRequestError | StorageNotFoundError>;
  }
>() {}
```

### 4.2 Errors

```ts
// @/storage/errors.ts
export class StorageConfigError extends Error {
  readonly _tag = 'StorageConfigError' as const;
}
export class StorageSignError extends Error {
  readonly _tag = 'StorageSignError' as const;
}
export class StorageRequestError extends Error {
  readonly _tag = 'StorageRequestError' as const;
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export class StorageNotFoundError extends Error {
  readonly _tag = 'StorageNotFoundError' as const;
}
```

### 4.3 Error semantics

- **`StorageConfigError`** is thrown synchronously by `makeStorageConfig()` (layer build time), not through the Effect error channel. Config is a deploy concern, not a per-call concern.
- **`StorageSignError`** for SigV4 signing failures (rare; usually credential or crypto issues).
- **`StorageRequestError(status?)`** for non-OK HTTP responses other than 404. `status` is exposed so routes can map 410 / 5xx and sync can decide retry vs drop.
- **`StorageNotFoundError`** for 404 on `head` / `delete` / `copy`. Callers express idempotency or existence semantics via `catchTag`.

### 4.4 Caller patterns

```ts
// "exists?" — returns boolean
const exists =
  yield *
  storage.headObject(key).pipe(
    Effect.as(true),
    Effect.catchTag('StorageNotFoundError', () => Effect.succeed(false)),
  );

// "idempotent delete"
yield * storage.deleteObject(key).pipe(Effect.catchTag('StorageNotFoundError', () => Effect.void));
```

### 4.5 What the service does NOT do

- No `listObjects` (file listing comes from the `files` DB table).
- No `putObject(bytes)` (clients use presigned URLs).
- No multipart APIs.
- No `objectExists` shorthand (callers use `headObject` + `catchTag`).
- No HTTP status mapping (callers decide).

---

## 5. Config and Layer Composition

### 5.1 `StorageConfig` shape

```ts
// @/storage/config.ts
export interface StorageConfigShape {
  readonly endpoint: string;
  readonly region: string;
  readonly bucketName: string; // default bucket; method bucketName? param overrides
  readonly tempBucketName: string; // TEMP_STORAGE_PUBLIC_BUCKET_NAME
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export class StorageConfig extends Context.Tag('StorageConfig')<
  StorageConfig,
  StorageConfigShape
>() {}
```

Fields **removed** from the original draft design:

- `provider: 's3' | 'r2'` — downstream code doesn't need to know; aws4fetch handles both.
- `forcePathStyle` — aws4fetch builds path-style URLs against any endpoint by default. No callers ever needed virtual-host style.
- `publicBaseUrl` — `READEST_PUBLIC_STORAGE_BASE_URL` is a product CDN constant, stays in `@/services/constants`.

Field **added**:

- `tempBucketName` — `upload.ts` temp path needs `env.TEMP_STORAGE_PUBLIC_BUCKET_NAME`; centralized here so all bucket names are visible.

### 5.2 `makeStorageConfig`

```ts
export const makeStorageConfig = (): StorageConfigShape => {
  const type = env.VITE_OBJECT_STORAGE_TYPE; // 'r2' | 's3'

  if (type === 'r2') {
    if (
      !env.R2_ACCOUNT_ID ||
      !env.R2_BUCKET_NAME ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY
    ) {
      throw new StorageConfigError('Missing required R2 storage configuration');
    }
    return {
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      region: env.R2_REGION,
      bucketName: env.R2_BUCKET_NAME,
      tempBucketName: env.TEMP_STORAGE_PUBLIC_BUCKET_NAME,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    };
  }

  if (
    !env.S3_ENDPOINT ||
    !env.S3_BUCKET_NAME ||
    !env.S3_ACCESS_KEY_ID ||
    !env.S3_SECRET_ACCESS_KEY
  ) {
    throw new StorageConfigError('Missing required S3 storage configuration');
  }
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucketName: env.S3_BUCKET_NAME,
    tempBucketName: env.TEMP_STORAGE_PUBLIC_BUCKET_NAME,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
};

export const StorageConfigLive = Layer.sync(StorageConfig, makeStorageConfig);
```

**`Layer.sync`** (not `Layer.succeed(StorageConfig.of(makeStorageConfig()))`): config is resolved at layer-build time, not at module load. Tests can swap config without forcing valid env at import time.

### 5.3 `StorageLive` — composed public layer

```ts
// @/storage/live.ts
import { Layer } from 'effect';
import { StorageConfigLive } from './config';
import { S3CompatibleStorageLive } from './s3Compatible';

export const StorageLive = S3CompatibleStorageLive.pipe(Layer.provide(StorageConfigLive));
```

### 5.4 `runStorageProgram` — route-only boundary helper

```ts
// @/storage/run.ts
import { Effect } from 'effect';
import { StorageLive } from './live';
import type { ObjectStorage } from './service';
import type { StorageNotFoundError, StorageRequestError, StorageSignError } from './errors';

type StorageProgramError = StorageSignError | StorageRequestError | StorageNotFoundError;

export const runStorageProgram = <A>(
  program: Effect.Effect<A, StorageProgramError, ObjectStorage>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(StorageLive)));
```

Sync (future) does **not** call `runStorageProgram`. It composes `ObjectStorage` directly inside its own pipeline and provides `StorageLive` at its entry point.

### 5.5 `@/storage/index.ts` — public surface

```ts
export { ObjectStorage } from './service';
export {
  StorageConfigError,
  StorageSignError,
  StorageRequestError,
  StorageNotFoundError,
} from './errors';
export { StorageLive } from './live';
export { runStorageProgram } from './run';
```

Consumers import only these. `config.ts`, `s3Compatible.ts`, `live.ts` internals are private.

---

## 6. Provider Implementation (`s3Compatible.ts`)

### 6.1 Structure

```ts
import { Effect, Layer } from 'effect';
import { AwsClient } from 'aws4fetch';
import { StorageConfig } from './config';
import { StorageNotFoundError, StorageRequestError, StorageSignError } from './errors';
import { ObjectStorage } from './service';

const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

const trimSlash = (value: string) => value.replace(/\/+$/, '');

export const S3CompatibleStorageLive = Layer.effect(
  ObjectStorage,
  Effect.gen(function* () {
    const config = yield* StorageConfig;
    const client = new AwsClient({
      service: 's3',
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    const objectUrl = (bucket: string, key: string) =>
      `${trimSlash(config.endpoint)}/${bucket}/${encodeKey(key)}`;

    return ObjectStorage.of({
      // Method bodies in §6.2 below.
      getUploadSignedUrl,
      getDownloadSignedUrl,
      deleteObject,
      headObject,
      copyObject,
    });
  }),
);
```

### 6.2 Method implementations

#### `getUploadSignedUrl`

```ts
getUploadSignedUrl: (fileKey, contentLength, expiresIn, bucketName) =>
  Effect.tryPromise({
    try: async () => {
      const url = new URL(objectUrl(bucketName ?? config.bucketName, fileKey));
      url.searchParams.set('X-Amz-Expires', expiresIn.toString());
      const signed = await client.sign(
        new Request(url, {
          method: 'PUT',
          headers: { 'Content-Length': contentLength.toString() },
        }),
        { aws: { signQuery: true, allHeaders: true } },
      );
      return signed.url;
    },
    catch: (e) => new StorageSignError(String(e)),
  }),
```

`allHeaders: true` puts `Content-Length` into the SignedHeaders set; replaces the original `r2.ts` manual `X-Amz-SignedHeaders=content-length` query string trick.

#### `getDownloadSignedUrl`

```ts
getDownloadSignedUrl: (fileKey, expiresIn, bucketName) =>
  Effect.tryPromise({
    try: async () => {
      const url = new URL(objectUrl(bucketName ?? config.bucketName, fileKey));
      url.searchParams.set('X-Amz-Expires', expiresIn.toString());
      const signed = await client.sign(
        new Request(url),
        { aws: { signQuery: true } },
      );
      return signed.url;
    },
    catch: (e) => new StorageSignError(String(e)),
  }),
```

#### `deleteObject`

```ts
deleteObject: (fileKey, bucketName) =>
  Effect.tryPromise({
    try: async () => {
      const r = await client.fetch(
        objectUrl(bucketName ?? config.bucketName, fileKey),
        { method: 'DELETE' },
      );
      if (r.status === 404) throw new StorageNotFoundError(`Not found: ${fileKey}`);
      if (!r.ok) throw new StorageRequestError(`Delete failed: ${r.status}`, r.status);
    },
    catch: (e) => {
      if (e instanceof StorageNotFoundError) return e;
      if (e instanceof StorageRequestError) return e;
      return new StorageRequestError(String(e));
    },
  }),
```

S3/R2 DELETE on missing key normally returns 204, so the 404 branch rarely fires — kept for symmetry.

#### `headObject`

```ts
headObject: (fileKey, bucketName) =>
  Effect.tryPromise({
    try: async () => {
      const r = await client.fetch(
        objectUrl(bucketName ?? config.bucketName, fileKey),
        { method: 'HEAD' },
      );
      if (r.status === 404) throw new StorageNotFoundError(`Not found: ${fileKey}`);
      if (!r.ok) throw new StorageRequestError(`Head failed: ${r.status}`, r.status);
    },
    catch: (e) => {
      if (e instanceof StorageNotFoundError) return e;
      if (e instanceof StorageRequestError) return e;
      return new StorageRequestError(String(e));
    },
  }),
```

#### `copyObject`

```ts
copyObject: (sourceFileKey, destFileKey, bucketName, sourceBucketName) =>
  Effect.tryPromise({
    try: async () => {
      const destBucket = bucketName ?? config.bucketName;
      const srcBucket = sourceBucketName ?? destBucket;
      const r = await client.fetch(
        objectUrl(destBucket, destFileKey),
        {
          method: 'PUT',
          headers: {
            'x-amz-copy-source': `/${srcBucket}/${encodeKey(sourceFileKey)}`,
          },
        },
      );
      if (r.status === 404) {
        throw new StorageNotFoundError(`Source not found: ${srcBucket}/${sourceFileKey}`);
      }
      if (!r.ok) throw new StorageRequestError(`Copy failed: ${r.status}`, r.status);
    },
    catch: (e) => {
      if (e instanceof StorageNotFoundError) return e;
      if (e instanceof StorageRequestError) return e;
      return new StorageRequestError(String(e));
    },
  }),
```

### 6.3 Encoding rules

All object keys are encoded segment-by-segment. `My Book & Notes.epub` → `My%20Book%20%26%20Notes.epub`. `/` separators stay literal. Applies to both the request URL path and `x-amz-copy-source`.

---

## 7. File-Key Naming Unification

### 7.1 Current state

```ts
// utils/book.ts
if (getStorageType() === 'r2') {
  return `${book.hash}/${makeSafeFilename(book.sourceTitle || book.title)}.${EXTS[book.format]}`;
} else if (getStorageType() === 's3') {
  return `${book.hash}/${book.hash}.${EXTS[book.format]}`;
}
```

### 7.2 Target

```ts
// utils/book.ts
export const getRemoteBookFilename = (book: Book) => {
  return `${book.hash}/${book.hash}.${EXTS[book.format]}`;
};
```

`utils/storage.ts` (the `getStorageType()` helper) is removed. New uploads on any backend use the S3 scheme.

### 7.3 Backward compatibility for existing R2 records

`download.ts` resolves `fileKey` via the `files` DB table. Old R2 rows with `{hash}/{safeFilename}.{ext}` keep working because the `file_key` column already stores the actual key — naming only affects _new_ uploads. The existing `Readest/Book/{hash}/{filename}` fallback in `download.ts` (which reverse-resolves via `bookHash`) also continues to work. No data migration needed.

---

## 8. Route Migration

### 8.1 Template

```ts
import { Effect } from 'effect';
import { ObjectStorage, StorageNotFoundError, runStorageProgram } from '@/storage';

try {
  const url = await runStorageProgram(
    Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      return yield* storage.getDownloadSignedUrl(fileKey, 1800);
    }),
  );
  return Response.json({ downloadUrl: url });
} catch (err) {
  if (err instanceof StorageNotFoundError) {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }
  console.error(err);
  return Response.json({ error: 'Storage operation failed' }, { status: 500 });
}
```

Routes use `try/catch + instanceof`, not `Effect.catchTag`. With one or two storage calls per route, the imperative branch keeps the route HTTP-mapping localized and readable.

### 8.2 Route inventory

| Route                            | Storage calls                                            | Behavior change                                                                        |
| -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `storage/upload.ts`              | `getUploadSignedUrl`, `getDownloadSignedUrl` (temp path) | none                                                                                   |
| `storage/download.ts`            | `getDownloadSignedUrl`                                   | none                                                                                   |
| `storage/delete.ts`              | `deleteObject`                                           | NotFound → 200 (idempotent); use `catchTag('StorageNotFoundError', () => Effect.void)` |
| `storage/purge.ts`               | `deleteObject × N`                                       | use `Effect.forEach` + per-key `Effect.either`; NotFound → success bucket              |
| `storage/list.ts`                | none                                                     | unchanged                                                                              |
| `storage/stats.ts`               | none                                                     | unchanged                                                                              |
| `share/$token/download/route.ts` | `getDownloadSignedUrl`                                   | no behavior change (presign does not verify existence)                                 |
| `share/$token/cover/route.ts`    | `getDownloadSignedUrl`                                   | no behavior change                                                                     |
| `share/$token/import/route.ts`   | `copyObject × 1-2`                                       | see 8.3                                                                                |
| `share/create/route.ts`          | `headObject` (upload-completeness check)                 | NotFound → 409 `upload_incomplete` (original behavior preserved)                       |

### 8.3 share/import cleanup

Original flow: `objectExists()` → `copyObject()` → sniff `copyResp.ok` (because R2 returns `Response`, S3 returns SDK object).

New flow: single `copyObject` call; `StorageNotFoundError` carries the "source gone" signal.

```ts
try {
  await runStorageProgram(
    Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      yield* storage.copyObject(share.bookFileKey, destBookKey);
    }),
  );
} catch (err) {
  await tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, insertedBookId));

  if (err instanceof StorageNotFoundError) {
    return Response.json(
      { error: 'Shared book is no longer available', code: 'source_deleted' },
      { status: 410 },
    );
  }
  console.error('Share import book copy failed:', err);
  return Response.json({ error: 'Could not import book' }, { status: 500 });
}
```

Gains: one less HEAD round trip per import; no more `Response`-vs-SDK-object type sniffing.

### 8.4 Deletions

```bash
git rm apps/readest-app/src/utils/object.ts
git rm apps/readest-app/src/utils/s3.ts
git rm apps/readest-app/src/utils/r2.ts
git rm apps/readest-app/src/utils/storage.ts
```

```diff
# apps/readest-app/package.json
- "@aws-sdk/client-s3": "^3.1000.0",
- "@aws-sdk/s3-request-presigner": "^3.1000.0",
```

`pnpm install` regenerates the lockfile. `aws4fetch` is retained.

The original draft listed `src/middlewares/storage.ts` for deletion. **That file does not exist** in the current tree — the entry is removed from this design.

### 8.5 Post-migration verification grep

```bash
rg -n "@/utils/object|@/utils/s3|@/utils/r2|@/utils/storage" apps/readest-app/src
rg -n "@aws-sdk/" apps/readest-app/src
rg -n "getStorageType\(\)" apps/readest-app/src
```

All three commands must produce zero output.

---

## 9. Testing Strategy

### 9.1 Provider unit tests — `__tests__/storage/s3Compatible.test.ts`

Use real Effect runtime + a test `StorageConfig` layer. Mock `aws4fetch`'s `AwsClient`:

```ts
import { Effect, Layer } from 'effect';
import { ObjectStorage } from '@/storage/service';
import { StorageConfig, type StorageConfigShape } from '@/storage/config';
import { S3CompatibleStorageLive } from '@/storage/s3Compatible';
import { StorageNotFoundError } from '@/storage/errors';

const signMock = vi.fn();
const fetchMock = vi.fn();
vi.mock('aws4fetch', () => ({
  AwsClient: vi.fn(function () {
    return { sign: signMock, fetch: fetchMock };
  }),
}));

const testConfig: StorageConfigShape = {
  /* … */
};
const TestStorageLayer = S3CompatibleStorageLive.pipe(
  Layer.provide(Layer.succeed(StorageConfig, testConfig)),
);
```

Coverage:

- upload URL includes `X-Amz-Expires`, PUT method, `Content-Length` header.
- download URL includes `X-Amz-Expires`.
- `headObject` returns `void` on 200; fails with `StorageNotFoundError` on 404.
- `deleteObject` succeeds on 200/204; fails with `StorageNotFoundError` on 404; fails with `StorageRequestError(status)` on other non-OK.
- `copyObject` signs PUT with correctly segment-encoded `x-amz-copy-source`.
- `copyObject` fails with `StorageNotFoundError` on 404.

Do **not** mock the `effect` module. Tests use `Effect.runPromise` / `Effect.runPromiseExit` against real Effect runtime.

### 9.2 Config unit tests — `__tests__/storage/config.test.ts`

```ts
const loadConfig = async (envOverrides: Record<string, string>) => {
  vi.resetModules();
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  return await import('@/storage/config');
};
```

Coverage:

- `VITE_OBJECT_STORAGE_TYPE='s3'` with required S3 env → valid `StorageConfigShape`.
- `VITE_OBJECT_STORAGE_TYPE='r2'` with required R2 env → endpoint = `https://<acct>.r2.cloudflarestorage.com`.
- Missing required env throws `StorageConfigError`.

### 9.3 Route integration tests — adapt `__tests__/api/storage.test.ts`

Existing test uses real Postgres + RLS, mocks `@/utils/object`. New boundary is `@/storage/run`:

```ts
vi.mock('@/storage/run', () => ({
  runStorageProgram: vi.fn().mockResolvedValue('https://signed.test/mocked'),
}));
```

Per-test overrides:

```ts
import { runStorageProgram } from '@/storage/run';
vi.mocked(runStorageProgram).mockResolvedValueOnce('https://upload.test/book.epub');
vi.mocked(runStorageProgram).mockRejectedValueOnce(new StorageSignError('boom'));
vi.mocked(runStorageProgram).mockRejectedValueOnce(new StorageNotFoundError('gone'));
```

The existing tests for upload / download / list / purge / stats / delete are kept; signature changes only at the mock target.

### 9.4 What is not covered

- Real S3/R2 end-to-end: relies on manual deploy verification (see §10.4).
- aws4fetch's signing correctness: trusted upstream.
- `StorageLive` layer composition: Effect framework behavior.
- New share-route-specific integration tests: not added; share routes did not have storage-focused tests before.

---

## 10. Risks and Migration

### 10.1 Risks

| Risk                                                                    | Impact                                    | Mitigation                                                                                                                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| aws4fetch signing incompatibility with some S3-compatible endpoint      | Upload/download 500                       | Manual verify R2 + S3 endpoints before merge; `S3_REGION` env stays user-configurable                                                                                 |
| Route error mapping regression (e.g. original 500 becomes 404)          | Client flow breaks                        | Route integration tests cover success / NotFound / fail for every storage call                                                                                        |
| `copyObject` source encoding bug (spaces, `&`)                          | share/import fails                        | Provider unit tests assert segment-by-segment encoding                                                                                                                |
| `headObject` now fails instead of returning false → caller misses catch | Route 500                                 | Every call site (`share/create`, former `objectExists` callers) explicitly `catchTag`                                                                                 |
| Old R2 user file_keys with `{hash}/{safeFilename}.{ext}`                | None — `download.ts` resolves via DB      | New uploads use unified scheme; old records keep working                                                                                                              |
| Effect API learning curve                                               | Future route maintainers must know Effect | `@/storage/index.ts` exports a minimal surface (7 symbols: `ObjectStorage`, `StorageLive`, `runStorageProgram`, plus 4 error classes); per-route call sites are short |
| `Layer.sync` config-error wrapping changes `cause` shape                | Logs slightly different                   | Route `try/catch` already handles `unknown`; log original error                                                                                                       |

### 10.2 Migration order

1. **Add storage module skeleton.** New files only: `errors.ts`, `service.ts`, `config.ts`, `s3Compatible.ts`, `live.ts`, `run.ts`, `index.ts`, plus the two new test files. Old utils still in place. Tests green.
2. **Migrate `/api/storage/*` routes** to `runStorageProgram`. Adapt `__tests__/api/storage.test.ts` mock target.
3. **Migrate share routes.** Including the share/import head + copy → copy + catchNotFound cleanup.
4. **Delete legacy.** Remove `utils/object.ts`, `utils/s3.ts`, `utils/r2.ts`, `utils/storage.ts`. Update `utils/book.ts` to single `file_key` scheme. Strip `@aws-sdk/*` from `package.json`. Run full `pnpm test` and `pnpm lint`. Run verification greps from §8.5.

### 10.3 Rollback

Each migration step is a separate commit, individually revertible. Step 4 is the only irreversible one (dependency removal), so it runs last after steps 2-3 are verified.

### 10.4 Pre-deploy manual verification

- Deploy on R2-configured environment; run upload → download → share/create → share/import end-to-end.
- Deploy on S3-configured environment; run the same end-to-end.
- Confirm SSR runtime no longer fails with `__vite_ssr_import_xx_.u is not a function`.

---

## 11. Out of Scope

- Multipart upload.
- Browser-side direct signing.
- Effect-ifying `cloudService`, `transferManager`, `appService`.
- A second `aws-sdk`-based provider for Node-only environments.
- Object content streaming through the service layer.

---

## 12. Open Items

None. All decisions are settled:

- single `aws4fetch`-based provider
- typed Effect service + composed `StorageLive` layer
- unified `file_key` naming
- `runStorageProgram` as route-only boundary
- full cutover with no compatibility facade
- `@aws-sdk/*` removed from dependencies
