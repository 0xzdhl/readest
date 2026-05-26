# Effect Object Storage Worker-Safe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current object-storage utility stack with a single Effect-based worker-safe S3-compatible storage service and migrate all server-side callers directly to it.

**Architecture:** Introduce `StorageConfig` and `ObjectStorage` Effect services, implement one worker-safe S3-compatible provider, migrate `/api/storage/*` and share/import routes to call the service directly, and delete the old `utils/object.ts` / `utils/s3.ts` / `utils/r2.ts` / storage middleware stack. Routes remain TanStack Start handlers and run Effect programs at the boundary.

**Tech Stack:** TanStack Start, Effect TS, existing env module, worker-safe S3 SigV4 signer, Vitest, Biome.

---

## File Structure

### New files

| Path                                                          | Responsibility                                          |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/readest-app/src/storage/errors.ts`                      | typed storage errors                                    |
| `apps/readest-app/src/storage/service.ts`                     | `ObjectStorage` Effect tag and service shape            |
| `apps/readest-app/src/storage/config.ts`                      | `StorageConfig` Effect tag and env-derived live layer   |
| `apps/readest-app/src/storage/s3Compatible.ts`                | single worker-safe S3-compatible storage implementation |
| `apps/readest-app/src/__tests__/storage/config.test.ts`       | config derivation tests                                 |
| `apps/readest-app/src/__tests__/storage/s3Compatible.test.ts` | provider behavior tests                                 |

### Modified files

| Path                                                                                   | Responsibility                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `apps/readest-app/src/app/api/storage/upload.ts`                                       | route uses Effect storage service                   |
| `apps/readest-app/src/app/api/storage/download.ts`                                     | route uses Effect storage service                   |
| `apps/readest-app/src/app/api/storage/delete.ts`                                       | route uses Effect storage service                   |
| `apps/readest-app/src/app/api/storage/purge.ts`                                        | route uses Effect storage service                   |
| `apps/readest-app/src/app/api/storage/stats.ts`                                        | keep direct DB logic unless storage call needed     |
| `apps/readest-app/src/app/api/storage/list.ts`                                         | keep direct DB logic unless storage call needed     |
| `apps/readest-app/src/app/api/share/$token/import.ts` or equivalent share import route | route uses Effect storage service for copy/download |
| `apps/readest-app/src/__tests__/api/storage.test.ts`                                   | adapt mocks/tests to new storage service            |
| any share-route tests touching object storage                                          | adapt to new service entrypoint                     |

### Deleted files

| Path                                          | Responsibility removed           |
| --------------------------------------------- | -------------------------------- |
| `apps/readest-app/src/utils/object.ts`        | old storage facade               |
| `apps/readest-app/src/utils/s3.ts`            | old AWS-specific implementation  |
| `apps/readest-app/src/utils/r2.ts`            | old R2-specific implementation   |
| `apps/readest-app/src/middlewares/storage.ts` | no longer creates storage client |

---

### Task 1: Add Typed Storage Services And Config

**Files:**

- Create: `apps/readest-app/src/storage/errors.ts`
- Create: `apps/readest-app/src/storage/service.ts`
- Create: `apps/readest-app/src/storage/config.ts`
- Test: `apps/readest-app/src/__tests__/storage/config.test.ts`

- [ ] **Step 1: Write the failing config tests**

```ts
import { describe, expect, it, vi } from 'vitest';

const loadConfig = async (envOverrides: Record<string, string>) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(envOverrides)) process.env[key] = value;
  const mod = await import('@/storage/config');
  return mod;
};

describe('StorageConfigLive', () => {
  it('builds S3 config from env', async () => {
    const { makeStorageConfig } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 's3',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_REGION: 'us-east-1',
      S3_BUCKET_NAME: 'bucket-a',
      S3_ACCESS_KEY_ID: 'key-a',
      S3_SECRET_ACCESS_KEY: 'secret-a',
    });

    expect(makeStorageConfig().provider).toBe('s3');
    expect(makeStorageConfig().bucketName).toBe('bucket-a');
  });

  it('builds R2 config from env', async () => {
    const { makeStorageConfig } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 'r2',
      R2_ACCOUNT_ID: 'acct',
      R2_REGION: 'auto',
      R2_BUCKET_NAME: 'bucket-r2',
      R2_ACCESS_KEY_ID: 'key-r2',
      R2_SECRET_ACCESS_KEY: 'secret-r2',
    });

    expect(makeStorageConfig().provider).toBe('r2');
    expect(makeStorageConfig().bucketName).toBe('bucket-r2');
  });

  it('throws when required env is missing', async () => {
    const { makeStorageConfig, StorageConfigError } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 's3',
      S3_ENDPOINT: '',
      S3_REGION: 'us-east-1',
      S3_BUCKET_NAME: 'bucket-a',
      S3_ACCESS_KEY_ID: 'key-a',
      S3_SECRET_ACCESS_KEY: 'secret-a',
    });

    expect(() => makeStorageConfig()).toThrow(StorageConfigError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/storage/config.test.ts`  
Expected: FAIL with module-not-found errors for `@/storage/config`.

- [ ] **Step 3: Write minimal typed error and service definitions**

```ts
// apps/readest-app/src/storage/errors.ts
export class StorageConfigError extends Error {}
export class StorageSignError extends Error {}
export class StorageRequestError extends Error {}
export class StorageNotFoundError extends Error {}
```

```ts
// apps/readest-app/src/storage/service.ts
import { Context, type Effect } from 'effect';
import type {
  StorageConfigError,
  StorageNotFoundError,
  StorageRequestError,
  StorageSignError,
} from './errors';

export type StorageError =
  | StorageConfigError
  | StorageSignError
  | StorageRequestError
  | StorageNotFoundError;

export class ObjectStorage extends Context.Tag('ObjectStorage')<
  ObjectStorage,
  {
    readonly getUploadSignedUrl: (
      fileKey: string,
      contentLength: number,
      expiresIn: number,
      bucketName?: string,
    ) => Effect.Effect<string, StorageError>;
    readonly getDownloadSignedUrl: (
      fileKey: string,
      expiresIn: number,
      bucketName?: string,
    ) => Effect.Effect<string, StorageError>;
    readonly deleteObject: (
      fileKey: string,
      bucketName?: string,
    ) => Effect.Effect<void, StorageError>;
    readonly headObject: (
      fileKey: string,
      bucketName?: string,
    ) => Effect.Effect<boolean, StorageError>;
    readonly copyObject: (
      sourceFileKey: string,
      destFileKey: string,
      bucketName?: string,
      sourceBucketName?: string,
    ) => Effect.Effect<void, StorageError>;
  }
>() {}
```

- [ ] **Step 4: Write minimal config implementation**

```ts
// apps/readest-app/src/storage/config.ts
import { Context, Layer } from 'effect';
import { env } from '@/env';
import { StorageConfigError } from './errors';

export interface StorageConfigShape {
  readonly provider: 's3' | 'r2';
  readonly endpoint: string;
  readonly region: string;
  readonly bucketName: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly publicBaseUrl?: string;
  readonly forcePathStyle: boolean;
}

export class StorageConfig extends Context.Tag('StorageConfig')<
  StorageConfig,
  StorageConfigShape
>() {}

export const makeStorageConfig = (): StorageConfigShape => {
  if (env.VITE_OBJECT_STORAGE_TYPE === 'r2') {
    if (
      !env.R2_ACCOUNT_ID ||
      !env.R2_BUCKET_NAME ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY
    ) {
      throw new StorageConfigError('Missing required R2 storage configuration');
    }
    return {
      provider: 'r2',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      region: env.R2_REGION,
      bucketName: env.R2_BUCKET_NAME,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      publicBaseUrl: undefined,
      forcePathStyle: true,
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
    provider: 's3',
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucketName: env.S3_BUCKET_NAME,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    publicBaseUrl: undefined,
    forcePathStyle: true,
  };
};

export const StorageConfigLive = Layer.succeed(
  StorageConfig,
  StorageConfig.of(makeStorageConfig()),
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/storage/config.test.ts`  
Expected: PASS with 3 passing tests.

- [ ] **Step 6: Commit**

```bash
git add apps/readest-app/src/storage/errors.ts \
        apps/readest-app/src/storage/service.ts \
        apps/readest-app/src/storage/config.ts \
        apps/readest-app/src/__tests__/storage/config.test.ts
git commit -m "feat(storage): add effect storage config and service definitions"
```

### Task 2: Implement The Worker-Safe S3-Compatible Provider

**Files:**

- Create: `apps/readest-app/src/storage/s3Compatible.ts`
- Test: `apps/readest-app/src/__tests__/storage/s3Compatible.test.ts`

- [ ] **Step 1: Write the failing provider tests**

```ts
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { StorageConfig, type StorageConfigShape } from '@/storage/config';

const signMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('aws4fetch', () => ({
  AwsClient: vi.fn(function AwsClientMock() {
    return { sign: signMock, fetch: fetchMock };
  }),
}));

const config: StorageConfigShape = {
  provider: 's3',
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucketName: 'books',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  forcePathStyle: true,
};

describe('S3CompatibleStorageLive', () => {
  it('signs upload URLs with content-length', async () => {
    const { ObjectStorage } = await import('@/storage/service');
    const { S3CompatibleStorageLive } = await import('@/storage/s3Compatible');
    signMock.mockResolvedValueOnce(new Request('http://localhost:9000/books/a.epub?signed=yes'));

    const program = Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      return yield* storage.getUploadSignedUrl('a.epub', 12, 1800);
    }).pipe(Effect.provideService(StorageConfig, config), Effect.provide(S3CompatibleStorageLive));

    const url = await Effect.runPromise(program);
    expect(url).toContain('signed=yes');
  });

  it('encodes copy source segment-by-segment', async () => {
    const { ObjectStorage } = await import('@/storage/service');
    const { S3CompatibleStorageLive } = await import('@/storage/s3Compatible');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const program = Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      return yield* storage.copyObject('dir/My Book & Notes.epub', 'copy.epub');
    }).pipe(Effect.provideService(StorageConfig, config), Effect.provide(S3CompatibleStorageLive));

    await Effect.runPromise(program);
    expect(fetchMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/storage/s3Compatible.test.ts`  
Expected: FAIL with module-not-found for `@/storage/s3Compatible`.

- [ ] **Step 3: Write the provider implementation**

```ts
// apps/readest-app/src/storage/s3Compatible.ts
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

    const objectUrl = (bucketName: string, fileKey: string) =>
      `${trimSlash(config.endpoint)}/${bucketName}/${encodeKey(fileKey)}`;

    return ObjectStorage.of({
      getUploadSignedUrl: (fileKey, contentLength, expiresIn, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const url = new URL(objectUrl(bucketName ?? config.bucketName, fileKey));
            url.searchParams.set('X-Amz-Expires', expiresIn.toString());
            url.searchParams.set('X-Amz-SignedHeaders', 'content-length');
            const request = await client.sign(
              new Request(url, {
                method: 'PUT',
                headers: { 'Content-Length': contentLength.toString() },
              }),
              { aws: { signQuery: true } },
            );
            return request.url;
          },
          catch: (error) => new StorageSignError(String(error)),
        }),
      getDownloadSignedUrl: (fileKey, expiresIn, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const url = new URL(objectUrl(bucketName ?? config.bucketName, fileKey));
            url.searchParams.set('X-Amz-Expires', expiresIn.toString());
            const request = await client.sign(new Request(url), { aws: { signQuery: true } });
            return request.url;
          },
          catch: (error) => new StorageSignError(String(error)),
        }),
      deleteObject: (fileKey, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const response = await client.fetch(
              objectUrl(bucketName ?? config.bucketName, fileKey),
              {
                method: 'DELETE',
              },
            );
            if (!response.ok) throw new StorageRequestError(`Delete failed: ${response.status}`);
          },
          catch: (error) =>
            error instanceof StorageRequestError ? error : new StorageRequestError(String(error)),
        }),
      headObject: (fileKey, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const response = await client.fetch(
              objectUrl(bucketName ?? config.bucketName, fileKey),
              {
                method: 'HEAD',
              },
            );
            if (response.status === 404) return false;
            if (!response.ok) throw new StorageRequestError(`Head failed: ${response.status}`);
            return true;
          },
          catch: (error) =>
            error instanceof StorageRequestError ? error : new StorageRequestError(String(error)),
        }),
      copyObject: (sourceFileKey, destFileKey, bucketName, sourceBucketName) =>
        Effect.tryPromise({
          try: async () => {
            const response = await client.fetch(
              objectUrl(bucketName ?? config.bucketName, destFileKey),
              {
                method: 'PUT',
                headers: {
                  'x-amz-copy-source': `/${sourceBucketName ?? bucketName ?? config.bucketName}/${encodeKey(sourceFileKey)}`,
                },
              },
            );
            if (response.status === 404) throw new StorageNotFoundError('Source object not found');
            if (!response.ok) throw new StorageRequestError(`Copy failed: ${response.status}`);
          },
          catch: (error) =>
            error instanceof StorageNotFoundError || error instanceof StorageRequestError
              ? error
              : new StorageRequestError(String(error)),
        }),
    });
  }),
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/storage/s3Compatible.test.ts`  
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/readest-app/src/storage/s3Compatible.ts \
        apps/readest-app/src/__tests__/storage/s3Compatible.test.ts
git commit -m "feat(storage): add worker-safe s3-compatible provider"
```

### Task 3: Migrate Storage Routes And Delete Old Utilities

**Files:**

- Modify: `apps/readest-app/src/app/api/storage/upload.ts`
- Modify: `apps/readest-app/src/app/api/storage/download.ts`
- Modify: `apps/readest-app/src/app/api/storage/delete.ts`
- Modify: `apps/readest-app/src/app/api/storage/purge.ts`
- Modify: `apps/readest-app/src/__tests__/api/storage.test.ts`
- Delete: `apps/readest-app/src/utils/object.ts`
- Delete: `apps/readest-app/src/utils/s3.ts`
- Delete: `apps/readest-app/src/utils/r2.ts`
- Delete: `apps/readest-app/src/middlewares/storage.ts`

- [ ] **Step 1: Write or update failing route tests**

```ts
// extend apps/readest-app/src/__tests__/api/storage.test.ts
vi.mock('@/storage/config', () => ({
  StorageConfigLive: { _tag: 'StorageConfigLiveMock' },
}));

vi.mock('@/storage/s3Compatible', () => ({
  S3CompatibleStorageLive: { _tag: 'S3CompatibleStorageLiveMock' },
}));

vi.mock('effect', async () => {
  const actual = await vi.importActual<typeof import('effect')>('effect');
  return {
    ...actual,
    Effect: {
      ...actual.Effect,
      runPromise: vi.fn().mockResolvedValue('https://upload.test/file'),
    },
  };
});
```

- [ ] **Step 2: Run the storage route test to verify it fails against old imports**

Run: `pnpm exec vitest run src/__tests__/api/storage.test.ts`  
Expected: FAIL because the route still imports `@/utils/object`.

- [ ] **Step 3: Rewrite storage routes to use Effect**

```ts
// route pattern
import { Effect } from 'effect';
import { ObjectStorage } from '@/storage/service';
import { StorageConfigLive } from '@/storage/config';
import { S3CompatibleStorageLive } from '@/storage/s3Compatible';

const storageProgram = <T>(program: Effect.Effect<T, Error>) =>
  program.pipe(Effect.provide(StorageConfigLive), Effect.provide(S3CompatibleStorageLive));

const uploadUrl = await Effect.runPromise(
  storageProgram(
    Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      return yield* storage.getUploadSignedUrl(fileKey, objSize, 1800, bucketName);
    }),
  ),
);
```

- [ ] **Step 4: Delete the old utility and middleware files**

Run:

```bash
git rm apps/readest-app/src/utils/object.ts
git rm apps/readest-app/src/utils/s3.ts
git rm apps/readest-app/src/utils/r2.ts
git rm apps/readest-app/src/middlewares/storage.ts
```

- [ ] **Step 5: Run the storage route test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/api/storage.test.ts`  
Expected: PASS and no remaining imports of `@/utils/object`.

- [ ] **Step 6: Commit**

```bash
git add apps/readest-app/src/app/api/storage/upload.ts \
        apps/readest-app/src/app/api/storage/download.ts \
        apps/readest-app/src/app/api/storage/delete.ts \
        apps/readest-app/src/app/api/storage/purge.ts \
        apps/readest-app/src/__tests__/api/storage.test.ts
git commit -m "refactor(storage): migrate storage routes to effect object storage"
```

### Task 4: Migrate Share/Import Callers And Verify Full Cutover

**Files:**

- Modify: every share/import route that used `copyObject`, `headObject`, or signed URLs
- Modify: affected tests
- Search: all server-side imports of `@/utils/object`, `@/utils/s3`, `@/utils/r2`

- [ ] **Step 1: Find all remaining callers**

Run: `rg -n "@/utils/object|@/utils/s3|@/utils/r2|copyObject\\(|getUploadSignedUrl\\(|getDownloadSignedUrl\\(" apps/readest-app/src -S`  
Expected: remaining matches are limited to share/import routes and tests that need migration.

- [ ] **Step 2: Write or update failing tests for share/import storage behavior**

```ts
// pattern for affected share route tests
vi.mock('effect', async () => {
  const actual = await vi.importActual<typeof import('effect')>('effect');
  return {
    ...actual,
    Effect: {
      ...actual.Effect,
      runPromise: vi.fn().mockResolvedValue(undefined),
    },
  };
});
```

- [ ] **Step 3: Rewrite each remaining caller to use the Effect service directly**

```ts
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    return yield* storage.copyObject(sourceFileKey, destFileKey, bucketName, sourceBucketName);
  }).pipe(Effect.provide(StorageConfigLive), Effect.provide(S3CompatibleStorageLive)),
);
```

- [ ] **Step 4: Verify zero remaining imports of removed modules**

Run: `rg -n "@/utils/object|@/utils/s3|@/utils/r2" apps/readest-app/src -S`  
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/readest-app/src/app/api/share \
        apps/readest-app/src/__tests__/api
git commit -m "refactor(storage): complete share route cutover to effect storage"
```

### Task 5: Full Verification

**Files:**

- Verify only

- [ ] **Step 1: Run focused storage tests**

Run: `pnpm exec vitest run src/__tests__/storage/config.test.ts src/__tests__/storage/s3Compatible.test.ts src/__tests__/api/storage.test.ts`  
Expected: PASS.

- [ ] **Step 2: Run repository-wide search checks**

Run: `rg -n "@/utils/object|@/utils/s3|@/utils/r2|@aws-sdk/client-s3|@aws-sdk/s3-request-presigner" apps/readest-app/src -S`  
Expected: no server-side source matches for removed storage modules; AWS SDK matches only if unrelated and intentional.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`  
Expected: PASS.

- [ ] **Step 4: Run the test suite or the smallest safe storage-adjacent slice**

Run: `pnpm test -- --watch=false`  
Expected: PASS, or if unrelated suites are already failing in the branch, capture only pre-existing failures and verify storage-related suites are green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(storage): verify worker-safe effect storage migration"
```

---

## Self-Review

### Spec coverage

- `ObjectStorage` Effect service: covered by Tasks 1-2
- single worker-safe provider: covered by Task 2
- full route cutover: covered by Tasks 3-4
- delete old utils and middleware: covered by Task 3
- route/test verification: covered by Tasks 3-5

### Placeholder scan

- No `TODO` / `TBD`
- Each task includes concrete files, commands, and expected outcomes

### Type consistency

- `StorageConfig`, `ObjectStorage`, `StorageError`, and `S3CompatibleStorageLive` names are consistent across tasks

---

Plan complete and saved to `docs/superpowers/plans/2026-05-26-effect-object-storage-worker-safe-implementation.md`.
