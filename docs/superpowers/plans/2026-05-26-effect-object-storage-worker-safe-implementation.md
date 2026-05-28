# Effect Object Storage Worker-Safe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split `utils/object.ts` + `utils/s3.ts` + `utils/r2.ts` + `utils/storage.ts` storage stack with a single Effect-based `ObjectStorage` service backed by one `aws4fetch`-based S3-compatible provider; migrate every server-side caller; remove `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` from dependencies.

**Architecture:** Storage becomes a `Context.Tag` Effect service (`ObjectStorage`) with typed errors (`StorageSignError`, `StorageRequestError`, `StorageNotFoundError`, `StorageConfigError`). One `S3CompatibleStorageLive` layer uses `aws4fetch.AwsClient` for SigV4 signing over `fetch + WebCrypto`. Routes call a thin `runStorageProgram(effect)` helper to evaluate Effect programs at the route boundary. The future Effect-based sync pipeline composes `ObjectStorage` directly without the helper.

**Tech Stack:** TanStack Start (server routes), Effect TS `^3.21.2`, `aws4fetch` `^1.0.20`, Vitest, Biome.

**Reference spec:** `docs/superpowers/specs/2026-05-26-effect-object-storage-worker-safe-design.md`.

---

## File Structure

### New files

| Path                                                          | Responsibility                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/readest-app/src/storage/errors.ts`                      | typed storage error classes with `_tag` literals                                    |
| `apps/readest-app/src/storage/service.ts`                     | `ObjectStorage` Context.Tag, method signatures                                      |
| `apps/readest-app/src/storage/config.ts`                      | `StorageConfig` Context.Tag, `makeStorageConfig`, `StorageConfigLive`               |
| `apps/readest-app/src/storage/s3Compatible.ts`                | `S3CompatibleStorageLive` layer (`aws4fetch` implementation)                        |
| `apps/readest-app/src/storage/live.ts`                        | composed `StorageLive` layer (provider + config)                                    |
| `apps/readest-app/src/storage/run.ts`                         | `runStorageProgram` route-boundary helper                                           |
| `apps/readest-app/src/storage/index.ts`                       | public barrel — exports `ObjectStorage`, `StorageLive`, `runStorageProgram`, errors |
| `apps/readest-app/src/__tests__/storage/config.test.ts`       | config-derivation unit tests                                                        |
| `apps/readest-app/src/__tests__/storage/s3Compatible.test.ts` | provider behaviour unit tests (with mocked `aws4fetch`)                             |

### Modified files

| Path                                                          | Change                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/readest-app/src/app/api/storage/upload.ts`              | use `runStorageProgram` for both presigns; drop `@/utils/object` import                          |
| `apps/readest-app/src/app/api/storage/download.ts`            | use `runStorageProgram` for `getDownloadSignedUrl`                                               |
| `apps/readest-app/src/app/api/storage/delete.ts`              | use `runStorageProgram` with `catchTag('StorageNotFoundError')` for idempotency                  |
| `apps/readest-app/src/app/api/storage/purge.ts`               | per-key `runStorageProgram` inside `Promise.allSettled`; NotFound → success                      |
| `apps/readest-app/src/app/api/share/$token/download/route.ts` | use `runStorageProgram` for `getDownloadSignedUrl`                                               |
| `apps/readest-app/src/app/api/share/$token/cover/route.ts`    | same                                                                                             |
| `apps/readest-app/src/app/api/share/$token/import/route.ts`   | drop pre-check `objectExists`; single `copyObject` call; `instanceof StorageNotFoundError` → 410 |
| `apps/readest-app/src/app/api/share/create/route.ts`          | use `headObject` via Effect; `StorageNotFoundError` → 409 `upload_incomplete`                    |
| `apps/readest-app/src/utils/book.ts`                          | drop `getStorageType` branch in `getRemoteBookFilename`; unify to `{hash}/{hash}.{ext}`          |
| `apps/readest-app/src/__tests__/api/storage.test.ts`          | swap mock target from `@/utils/object` → `@/storage/run`                                         |
| `apps/readest-app/package.json`                               | remove `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`                                  |

### Deleted files

| Path                                    | Reason removed                        |
| --------------------------------------- | ------------------------------------- |
| `apps/readest-app/src/utils/object.ts`  | replaced by `@/storage/index.ts`      |
| `apps/readest-app/src/utils/s3.ts`      | AWS-SDK implementation gone           |
| `apps/readest-app/src/utils/r2.ts`      | merged into `S3CompatibleStorageLive` |
| `apps/readest-app/src/utils/storage.ts` | `getStorageType` no longer needed     |

---

## Task 1: Storage module — errors, service tag, config + tests

**Files:**

- Create: `apps/readest-app/src/storage/errors.ts`
- Create: `apps/readest-app/src/storage/service.ts`
- Create: `apps/readest-app/src/storage/config.ts`
- Test: `apps/readest-app/src/__tests__/storage/config.test.ts`

- [ ] **Step 1: Write the failing config test**

Create `apps/readest-app/src/__tests__/storage/config.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

const loadConfig = async (envOverrides: Record<string, string>) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(envOverrides)) {
    process.env[key] = value;
  }
  const errors = await import('@/storage/errors');
  const config = await import('@/storage/config');
  return { ...errors, ...config };
};

describe('makeStorageConfig', () => {
  it('builds S3 config from env', async () => {
    const { makeStorageConfig } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 's3',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_REGION: 'us-east-1',
      S3_BUCKET_NAME: 'bucket-s3',
      S3_ACCESS_KEY_ID: 'key-s3',
      S3_SECRET_ACCESS_KEY: 'secret-s3',
      TEMP_STORAGE_PUBLIC_BUCKET_NAME: 'temp-bucket',
    });
    const cfg = makeStorageConfig();
    expect(cfg.endpoint).toBe('https://s3.example.com');
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.bucketName).toBe('bucket-s3');
    expect(cfg.tempBucketName).toBe('temp-bucket');
    expect(cfg.accessKeyId).toBe('key-s3');
    expect(cfg.secretAccessKey).toBe('secret-s3');
  });

  it('builds R2 config from env (endpoint uses account id)', async () => {
    const { makeStorageConfig } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 'r2',
      R2_ACCOUNT_ID: 'acct123',
      R2_REGION: 'auto',
      R2_BUCKET_NAME: 'bucket-r2',
      R2_ACCESS_KEY_ID: 'key-r2',
      R2_SECRET_ACCESS_KEY: 'secret-r2',
      TEMP_STORAGE_PUBLIC_BUCKET_NAME: 'temp-r2',
    });
    const cfg = makeStorageConfig();
    expect(cfg.endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(cfg.region).toBe('auto');
    expect(cfg.bucketName).toBe('bucket-r2');
  });

  it('throws StorageConfigError when S3 endpoint missing', async () => {
    const { makeStorageConfig, StorageConfigError } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 's3',
      S3_ENDPOINT: '',
      S3_REGION: 'us-east-1',
      S3_BUCKET_NAME: 'bucket-s3',
      S3_ACCESS_KEY_ID: 'key-s3',
      S3_SECRET_ACCESS_KEY: 'secret-s3',
    });
    expect(() => makeStorageConfig()).toThrow(StorageConfigError);
  });

  it('throws StorageConfigError when R2 account id missing', async () => {
    const { makeStorageConfig, StorageConfigError } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 'r2',
      R2_ACCOUNT_ID: '',
      R2_BUCKET_NAME: 'bucket-r2',
      R2_ACCESS_KEY_ID: 'key-r2',
      R2_SECRET_ACCESS_KEY: 'secret-r2',
    });
    expect(() => makeStorageConfig()).toThrow(StorageConfigError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/storage/config.test.ts`
Expected: **FAIL** with `Cannot find module '@/storage/errors'` / `@/storage/config`.

- [ ] **Step 3: Create `apps/readest-app/src/storage/errors.ts`**

```ts
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

- [ ] **Step 4: Create `apps/readest-app/src/storage/service.ts`**

```ts
import { Context, type Effect } from 'effect';
import type { StorageNotFoundError, StorageRequestError, StorageSignError } from './errors';

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

- [ ] **Step 5: Create `apps/readest-app/src/storage/config.ts`**

```ts
import { Context, Layer } from 'effect';
import { env } from '@/env';
import { StorageConfigError } from './errors';

export interface StorageConfigShape {
  readonly endpoint: string;
  readonly region: string;
  readonly bucketName: string;
  readonly tempBucketName: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
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

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/storage/config.test.ts`
Expected: **PASS** with 4 passing tests.

- [ ] **Step 7: Commit**

```bash
git add apps/readest-app/src/storage/errors.ts \
        apps/readest-app/src/storage/service.ts \
        apps/readest-app/src/storage/config.ts \
        apps/readest-app/src/__tests__/storage/config.test.ts
CI=true git commit -m "feat(storage): add effect storage service tag, errors, and config"
```

---

## Task 2: S3-compatible provider + composed layer + route runner

**Files:**

- Create: `apps/readest-app/src/storage/s3Compatible.ts`
- Create: `apps/readest-app/src/storage/live.ts`
- Create: `apps/readest-app/src/storage/run.ts`
- Create: `apps/readest-app/src/storage/index.ts`
- Test: `apps/readest-app/src/__tests__/storage/s3Compatible.test.ts`

- [ ] **Step 1: Write the failing provider test**

Create `apps/readest-app/src/__tests__/storage/s3Compatible.test.ts`:

```ts
import { Effect, Exit, Cause, Layer, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('aws4fetch', () => ({
  AwsClient: vi.fn(function AwsClientMock() {
    return { sign: signMock, fetch: fetchMock };
  }),
}));

// Imported after the mock above is hoisted by Vitest.
import { StorageConfig, type StorageConfigShape } from '@/storage/config';
import { StorageNotFoundError, StorageRequestError } from '@/storage/errors';
import { S3CompatibleStorageLive } from '@/storage/s3Compatible';
import { ObjectStorage } from '@/storage/service';

const testConfig: StorageConfigShape = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucketName: 'books',
  tempBucketName: 'temp',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
};

const TestStorageLayer = S3CompatibleStorageLive.pipe(
  Layer.provide(Layer.succeed(StorageConfig, testConfig)),
);

const extractFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error('Expected failure, got success');
  }
  return Option.getOrThrow(Cause.failureOption(exit.cause));
};

beforeEach(() => {
  signMock.mockReset();
  fetchMock.mockReset();
});

describe('S3CompatibleStorage', () => {
  it('getUploadSignedUrl signs PUT with content-length header', async () => {
    signMock.mockResolvedValueOnce(
      new Request('http://localhost:9000/books/My%20Book.epub?X-Amz-Signature=xxx'),
    );

    const url = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        return yield* storage.getUploadSignedUrl('My Book.epub', 1234, 1800);
      }).pipe(Effect.provide(TestStorageLayer)),
    );

    expect(url).toContain('X-Amz-Signature');
    const [request, options] = signMock.mock.calls[0]!;
    expect((request as Request).method).toBe('PUT');
    expect((request as Request).headers.get('Content-Length')).toBe('1234');
    expect(new URL((request as Request).url).pathname).toBe('/books/My%20Book.epub');
    expect(new URL((request as Request).url).searchParams.get('X-Amz-Expires')).toBe('1800');
    expect(options).toEqual({ aws: { signQuery: true, allHeaders: true } });
  });

  it('getDownloadSignedUrl signs GET with X-Amz-Expires', async () => {
    signMock.mockResolvedValueOnce(new Request('http://localhost:9000/books/book.epub?signed=yes'));
    const url = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        return yield* storage.getDownloadSignedUrl('book.epub', 600);
      }).pipe(Effect.provide(TestStorageLayer)),
    );
    expect(url).toContain('signed=yes');
    const [request] = signMock.mock.calls[0]!;
    expect(new URL((request as Request).url).searchParams.get('X-Amz-Expires')).toBe('600');
  });

  it('headObject succeeds on 200', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.headObject('book.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9000/books/book.epub', {
      method: 'HEAD',
    });
  });

  it('headObject fails with StorageNotFoundError on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.headObject('missing.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );
    expect(extractFailure(exit)).toBeInstanceOf(StorageNotFoundError);
  });

  it('headObject fails with StorageRequestError(status) on 500', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.headObject('boom.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );
    const failure = extractFailure(exit);
    expect(failure).toBeInstanceOf(StorageRequestError);
    expect((failure as StorageRequestError).status).toBe(500);
  });

  it('deleteObject succeeds on 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.deleteObject('book.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9000/books/book.epub', {
      method: 'DELETE',
    });
  });

  it('deleteObject fails with StorageNotFoundError on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.deleteObject('missing.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );
    expect(extractFailure(exit)).toBeInstanceOf(StorageNotFoundError);
  });

  it('copyObject signs PUT with segment-encoded x-amz-copy-source', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.copyObject('user-123/My Book & Notes.epub', 'user-456/copy.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:9000/books/user-456/copy.epub');
    expect((init as RequestInit).method).toBe('PUT');
    expect((init as RequestInit).headers).toEqual({
      'x-amz-copy-source': '/books/user-123/My%20Book%20%26%20Notes.epub',
    });
  });

  it('copyObject fails with StorageNotFoundError on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.copyObject('a.epub', 'b.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );
    expect(extractFailure(exit)).toBeInstanceOf(StorageNotFoundError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/storage/s3Compatible.test.ts`
Expected: **FAIL** with `Cannot find module '@/storage/s3Compatible'`.

- [ ] **Step 3: Create `apps/readest-app/src/storage/s3Compatible.ts`**

```ts
import { AwsClient } from 'aws4fetch';
import { Effect, Layer } from 'effect';
import { StorageConfig } from './config';
import { StorageNotFoundError, StorageRequestError, StorageSignError } from './errors';
import { ObjectStorage } from './service';

const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

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

    const objectUrl = (bucket: string, key: string): string =>
      `${trimSlash(config.endpoint)}/${bucket}/${encodeKey(key)}`;

    return ObjectStorage.of({
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

      getDownloadSignedUrl: (fileKey, expiresIn, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const url = new URL(objectUrl(bucketName ?? config.bucketName, fileKey));
            url.searchParams.set('X-Amz-Expires', expiresIn.toString());
            const signed = await client.sign(new Request(url), {
              aws: { signQuery: true },
            });
            return signed.url;
          },
          catch: (e) => new StorageSignError(String(e)),
        }),

      deleteObject: (fileKey, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const r = await client.fetch(objectUrl(bucketName ?? config.bucketName, fileKey), {
              method: 'DELETE',
            });
            if (r.status === 404) {
              throw new StorageNotFoundError(`Not found: ${fileKey}`);
            }
            if (!r.ok) {
              throw new StorageRequestError(`Delete failed: ${r.status}`, r.status);
            }
          },
          catch: (e) => {
            if (e instanceof StorageNotFoundError) return e;
            if (e instanceof StorageRequestError) return e;
            return new StorageRequestError(String(e));
          },
        }),

      headObject: (fileKey, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const r = await client.fetch(objectUrl(bucketName ?? config.bucketName, fileKey), {
              method: 'HEAD',
            });
            if (r.status === 404) {
              throw new StorageNotFoundError(`Not found: ${fileKey}`);
            }
            if (!r.ok) {
              throw new StorageRequestError(`Head failed: ${r.status}`, r.status);
            }
          },
          catch: (e) => {
            if (e instanceof StorageNotFoundError) return e;
            if (e instanceof StorageRequestError) return e;
            return new StorageRequestError(String(e));
          },
        }),

      copyObject: (sourceFileKey, destFileKey, bucketName, sourceBucketName) =>
        Effect.tryPromise({
          try: async () => {
            const destBucket = bucketName ?? config.bucketName;
            const srcBucket = sourceBucketName ?? destBucket;
            const r = await client.fetch(objectUrl(destBucket, destFileKey), {
              method: 'PUT',
              headers: {
                'x-amz-copy-source': `/${srcBucket}/${encodeKey(sourceFileKey)}`,
              },
            });
            if (r.status === 404) {
              throw new StorageNotFoundError(`Source not found: ${srcBucket}/${sourceFileKey}`);
            }
            if (!r.ok) {
              throw new StorageRequestError(`Copy failed: ${r.status}`, r.status);
            }
          },
          catch: (e) => {
            if (e instanceof StorageNotFoundError) return e;
            if (e instanceof StorageRequestError) return e;
            return new StorageRequestError(String(e));
          },
        }),
    });
  }),
);
```

- [ ] **Step 4: Create `apps/readest-app/src/storage/live.ts`**

```ts
import { Layer } from 'effect';
import { StorageConfigLive } from './config';
import { S3CompatibleStorageLive } from './s3Compatible';

export const StorageLive = S3CompatibleStorageLive.pipe(Layer.provide(StorageConfigLive));
```

- [ ] **Step 5: Create `apps/readest-app/src/storage/run.ts`**

```ts
import { Effect } from 'effect';
import type { StorageNotFoundError, StorageRequestError, StorageSignError } from './errors';
import { StorageLive } from './live';
import type { ObjectStorage } from './service';

type StorageProgramError = StorageSignError | StorageRequestError | StorageNotFoundError;

export const runStorageProgram = <A>(
  program: Effect.Effect<A, StorageProgramError, ObjectStorage>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(StorageLive)));
```

- [ ] **Step 6: Create `apps/readest-app/src/storage/index.ts`**

```ts
export {
  StorageConfigError,
  StorageNotFoundError,
  StorageRequestError,
  StorageSignError,
} from './errors';
export { StorageLive } from './live';
export { runStorageProgram } from './run';
export { ObjectStorage } from './service';
```

- [ ] **Step 7: Run the provider test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/storage/s3Compatible.test.ts`
Expected: **PASS** with 9 passing tests.

- [ ] **Step 8: Commit**

```bash
git add apps/readest-app/src/storage/s3Compatible.ts \
        apps/readest-app/src/storage/live.ts \
        apps/readest-app/src/storage/run.ts \
        apps/readest-app/src/storage/index.ts \
        apps/readest-app/src/__tests__/storage/s3Compatible.test.ts
CI=true git commit -m "feat(storage): add worker-safe s3-compatible provider and route runner"
```

---

## Task 3: Migrate `/api/storage/*` routes + adapt storage.test.ts

**Files:**

- Modify: `apps/readest-app/src/app/api/storage/upload.ts`
- Modify: `apps/readest-app/src/app/api/storage/download.ts`
- Modify: `apps/readest-app/src/app/api/storage/delete.ts`
- Modify: `apps/readest-app/src/app/api/storage/purge.ts`
- Modify: `apps/readest-app/src/__tests__/api/storage.test.ts`

- [ ] **Step 1: Swap the test mock target in `__tests__/api/storage.test.ts`**

Replace the `vi.mock('@/utils/object', ...)` block (lines 19–29) with:

```ts
const runStorageProgramMock = vi.hoisted(() => vi.fn());

vi.mock('@/storage/run', () => ({
  runStorageProgram: runStorageProgramMock,
}));
```

Add a `beforeEach` reset right after the existing `beforeEach(async () => { getSessionMock.mockReset(); ... })` (extend it, do not add a second `beforeEach`):

```ts
beforeEach(async () => {
  getSessionMock.mockReset();
  runStorageProgramMock.mockReset();
  // Default storage behaviour: presigns succeed with placeholder URL.
  runStorageProgramMock.mockImplementation(async () => 'https://signed.test/default');
  await adminClient`DELETE FROM files WHERE user_id IN (${userA}, ${userB})`;
});
```

For the two tests that assert specific URLs, set per-call values:

- In `it('upload: inserts files row and returns signed URL on first upload', ...)`, before the `await runRoute(...)` line, add:

  ```ts
  runStorageProgramMock.mockResolvedValueOnce('https://upload.test/book.epub');
  ```

  Update the assertion `expect(body.uploadUrl).toMatch(/^https:\/\/upload.test\//)` → keep as-is; the override URL matches.

- In `it('download GET: returns signed URL for own file', ...)`, before `await runRoute(...)`, add:

  ```ts
  runStorageProgramMock.mockResolvedValueOnce('https://signed.test/file');
  ```

  The existing `expect(body.downloadUrl).toContain('signed.test')` still passes.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/api/storage.test.ts`
Expected: **FAIL** because the routes still import `@/utils/object` (not the mocked `@/storage/run`), so storage calls go to the real `@/utils/object` (which may still resolve), or because the routes never call `runStorageProgram` (so `runStorageProgramMock` is never invoked and the URLs come from the real signed URL helpers). Either way, assertions on the override URLs (`upload.test/book.epub`, `signed.test/file`) fail.

If the integration test is skipped because `TEST_DATABASE_URL` is unset, set it to a local Postgres URL pointing at the existing test database, or run from your usual test environment.

- [ ] **Step 3: Migrate `apps/readest-app/src/app/api/storage/upload.ts`**

Replace `import { getDownloadSignedUrl, getUploadSignedUrl } from '@/utils/object';` (line 8) with:

```ts
import { Effect } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
```

Inside the `temp` branch (around line 41), replace:

```ts
const uploadUrl = await getUploadSignedUrl(fileKey, fileSize ?? 0, 1800, bucketName);
const downloadUrl = await getDownloadSignedUrl(fileKey, 3 * 86400, bucketName);
```

with:

```ts
const uploadUrl = await runStorageProgram(
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    return yield* storage.getUploadSignedUrl(fileKey, fileSize ?? 0, 1800, bucketName);
  }),
);
const downloadUrl = await runStorageProgram(
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    return yield* storage.getDownloadSignedUrl(fileKey, 3 * 86400, bucketName);
  }),
);
```

In the non-temp branch (around line 94), replace:

```ts
const uploadUrl = await getUploadSignedUrl(fileKey, objSize, 1800);
```

with:

```ts
const uploadUrl = await runStorageProgram(
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    return yield* storage.getUploadSignedUrl(fileKey, objSize, 1800);
  }),
);
```

- [ ] **Step 4: Migrate `apps/readest-app/src/app/api/storage/download.ts`**

Replace `import { getDownloadSignedUrl } from '@/utils/object';` (line 6) with:

```ts
import { Effect } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
```

Replace the `getDownloadSignedUrl(fileRecord.fileKey, 1800)` call inside `processFileKeys` (around line 109) with:

```ts
const downloadUrl = await runStorageProgram(
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    return yield* storage.getDownloadSignedUrl(fileRecord.fileKey, 1800);
  }),
);
```

- [ ] **Step 5: Migrate `apps/readest-app/src/app/api/storage/delete.ts`**

Replace `import { deleteObject } from '@/utils/object';` (line 5) with:

```ts
import { Effect } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
```

Replace the `await deleteObject(fileKey);` (line 49) and surrounding `try { ... }` block with:

```ts
try {
  await runStorageProgram(
    Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      yield* storage.deleteObject(fileKey).pipe(
        // Idempotent: storage already gone counts as success;
        // the DB delete below still runs.
        Effect.catchTag('StorageNotFoundError', () => Effect.void),
      );
    }),
  );
  await tx.delete(files).where(eq(files.id, fileRecord.id));
  return Response.json({ message: 'File deleted successfully' });
} catch (error) {
  console.error('Error deleting file from storage:', error);
  return Response.json({ error: 'Could not delete file from storage' }, { status: 500 });
}
```

- [ ] **Step 6: Migrate `apps/readest-app/src/app/api/storage/purge.ts`**

Replace `import { deleteObject } from '@/utils/object';` (line 5) with:

```ts
import { Effect } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
```

Replace the `await deleteObject(fileRecord.fileKey);` (line 81) call with:

```ts
await runStorageProgram(
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    yield* storage.deleteObject(fileRecord.fileKey).pipe(
      // Idempotent bulk delete: NotFound counts as success for the
      // per-key Promise.allSettled accounting.
      Effect.catchTag('StorageNotFoundError', () => Effect.void),
    );
  }),
);
```

(Keep the surrounding `try { ... } catch { ... }` block; `runStorageProgram` rejections continue to be caught and recorded in `failed[]`.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/api/storage.test.ts`
Expected: **PASS** — all original assertions hold; the storage routes now consume the mocked `runStorageProgram`.

- [ ] **Step 8: Commit**

```bash
git add apps/readest-app/src/app/api/storage/upload.ts \
        apps/readest-app/src/app/api/storage/download.ts \
        apps/readest-app/src/app/api/storage/delete.ts \
        apps/readest-app/src/app/api/storage/purge.ts \
        apps/readest-app/src/__tests__/api/storage.test.ts
CI=true git commit -m "refactor(storage): migrate /api/storage routes to effect storage service"
```

---

## Task 4: Migrate share routes

**Files:**

- Modify: `apps/readest-app/src/app/api/share/$token/download/route.ts`
- Modify: `apps/readest-app/src/app/api/share/$token/cover/route.ts`
- Modify: `apps/readest-app/src/app/api/share/$token/import/route.ts`
- Modify: `apps/readest-app/src/app/api/share/create/route.ts`

Per spec §9.4, share routes did not previously have storage-focused integration tests, so this task contains no new TDD steps — only the migration. Existing tests (e.g. `share-token.test.ts`) run unchanged.

- [ ] **Step 1: Migrate `share/$token/download/route.ts`**

Replace `import { getDownloadSignedUrl } from '@/utils/object';` (line 2) with:

```ts
import { Effect } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
```

Replace the `url = await getDownloadSignedUrl(share.bookFileKey, SHARE_PRESIGN_TTL_SECONDS);` block (lines 28–33) with:

```ts
let url: string;
try {
  url = await runStorageProgram(
    Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      return yield* storage.getDownloadSignedUrl(share.bookFileKey, SHARE_PRESIGN_TTL_SECONDS);
    }),
  );
} catch (err) {
  console.error('Share download presign failed:', err);
  return Response.json({ error: 'Could not sign download URL' }, { status: 500 });
}
```

- [ ] **Step 2: Migrate `share/$token/cover/route.ts`**

Replace `import { getDownloadSignedUrl } from '@/utils/object';` (line 2) with:

```ts
import { Effect } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
```

Replace the `url = await getDownloadSignedUrl(share.coverFileKey, SHARE_PRESIGN_TTL_SECONDS);` block (lines 27–32) with:

```ts
let url: string;
try {
  url = await runStorageProgram(
    Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      return yield* storage.getDownloadSignedUrl(share.coverFileKey, SHARE_PRESIGN_TTL_SECONDS);
    }),
  );
} catch (err) {
  console.error('Share cover presign failed:', err);
  return Response.json({ error: 'Could not sign cover URL' }, { status: 500 });
}
```

- [ ] **Step 3: Migrate `share/$token/import/route.ts`**

Replace `import { copyObject, objectExists } from '@/utils/object';` (line 8) with:

```ts
import { Effect } from 'effect';
import { ObjectStorage, runStorageProgram, StorageNotFoundError } from '@/storage';
```

Delete the `sourceExists` check block (lines 149–156):

```ts
// REMOVE:
const sourceExists = await objectExists(share.bookFileKey);
if (!sourceExists) {
  return Response.json(
    { error: 'Shared book is no longer available', code: 'source_deleted' },
    { status: 410 },
  );
}
```

Replace the book-copy `try { ... } catch { ... }` block (lines 182–207) — the one that runs after the `files` row is inserted — with:

```ts
try {
  await runStorageProgram(
    Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      yield* storage.copyObject(share.bookFileKey, destBookKey);
    }),
  );
} catch (err) {
  // Soft-delete the orphan row in either error case.
  try {
    await tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, insertedBookId));
  } catch (cleanupErr) {
    console.error('Share import cleanup failed:', cleanupErr);
  }

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

Replace the cover-copy block (lines 212–230) with:

```ts
if (share.coverFileKey) {
  const destCoverKey = remap(share.coverFileKey);
  if (destCoverKey) {
    try {
      await runStorageProgram(
        Effect.gen(function* () {
          const storage = yield* ObjectStorage;
          yield* storage.copyObject(share.coverFileKey!, destCoverKey);
        }),
      );
      await tx.insert(files).values({
        userId: user.id,
        bookHash: share.bookHash,
        fileKey: destCoverKey,
        fileSize: 0,
      });
    } catch (err) {
      // Cover is best-effort. NotFound or any other error is non-fatal.
      console.error('Share import cover copy failed (non-fatal):', err);
    }
  }
}
```

- [ ] **Step 4: Migrate `share/create/route.ts`**

Replace `import { objectExists } from '@/utils/object';` (line 12) with:

```ts
import { Effect } from 'effect';
import { ObjectStorage, runStorageProgram, StorageNotFoundError } from '@/storage';
```

Replace the `const exists = await objectExists(bookFile.fileKey);` block (lines 161–170) with:

```ts
try {
  await runStorageProgram(
    Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      yield* storage.headObject(bookFile.fileKey);
    }),
  );
} catch (err) {
  if (err instanceof StorageNotFoundError) {
    return Response.json(
      {
        error: 'Book upload is incomplete; please retry',
        code: 'upload_incomplete',
      },
      { status: 409 },
    );
  }
  console.error('Share create headObject failed:', err);
  return Response.json({ error: 'Could not verify book upload' }, { status: 500 });
}
```

- [ ] **Step 5: Run the full test suite to verify no regressions**

Run: `pnpm test`
Expected: **PASS** (or only pre-existing unrelated failures — record any baseline failures here so they can be distinguished from regressions).

- [ ] **Step 6: Commit**

```bash
git add apps/readest-app/src/app/api/share/\$token/download/route.ts \
        apps/readest-app/src/app/api/share/\$token/cover/route.ts \
        apps/readest-app/src/app/api/share/\$token/import/route.ts \
        apps/readest-app/src/app/api/share/create/route.ts
CI=true git commit -m "refactor(storage): migrate share routes to effect storage service"
```

---

## Task 5: Unify `file_key` naming + delete legacy utils

**Files:**

- Modify: `apps/readest-app/src/utils/book.ts`
- Delete: `apps/readest-app/src/utils/object.ts`
- Delete: `apps/readest-app/src/utils/s3.ts`
- Delete: `apps/readest-app/src/utils/r2.ts`
- Delete: `apps/readest-app/src/utils/storage.ts`

- [ ] **Step 1: Update `utils/book.ts` to unified `file_key` scheme**

Open `apps/readest-app/src/utils/book.ts`.

Remove the import on line 5:

```ts
// REMOVE:
import { getStorageType } from './storage';
```

Replace `getRemoteBookFilename` (lines 19–28) with:

```ts
export const getRemoteBookFilename = (book: Book) => {
  // S3-compatible naming for all backends. Old R2 file_keys remain readable
  // because /api/storage/download.ts resolves file_key from the files DB row,
  // not from this function. New uploads use the unified scheme.
  return `${book.hash}/${book.hash}.${EXTS[book.format]}`;
};
```

- [ ] **Step 2: Delete the legacy storage modules**

```bash
git rm apps/readest-app/src/utils/object.ts \
       apps/readest-app/src/utils/s3.ts \
       apps/readest-app/src/utils/r2.ts \
       apps/readest-app/src/utils/storage.ts
```

- [ ] **Step 3: Run the verification grep — should be empty**

Run:

```bash
rg -n "@/utils/object|@/utils/s3|@/utils/r2|@/utils/storage" apps/readest-app/src
rg -n "getStorageType\\(\\)" apps/readest-app/src
```

Expected: **no output** from either command.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: **PASS** (no new regressions vs. Task 4 baseline).

- [ ] **Step 5: Commit**

```bash
git add apps/readest-app/src/utils/book.ts
CI=true git commit -m "refactor(storage): unify file_key naming and remove legacy storage utils"
```

(`git rm` from Step 2 has already staged the deletions; they are included in this commit.)

---

## Task 6: Strip `@aws-sdk/*` dependencies + final verification

**Files:**

- Modify: `apps/readest-app/package.json`
- Modify: `pnpm-lock.yaml` (regenerated)

- [ ] **Step 1: Remove the two AWS-SDK entries from `apps/readest-app/package.json`**

Open `apps/readest-app/package.json`. Locate lines 80–81:

```jsonc
    "@aws-sdk/client-s3": "^3.1000.0",
    "@aws-sdk/s3-request-presigner": "^3.1000.0",
```

Delete both lines. Leave `aws4fetch` on line 130 untouched.

- [ ] **Step 2: Regenerate the lockfile**

Run from the repo root:

```bash
CI=true pnpm install
```

Expected: `pnpm-lock.yaml` updates; both `@aws-sdk/*` entries disappear from the lockfile.

- [ ] **Step 3: Verify zero remaining AWS-SDK references in source**

Run:

```bash
rg -n "@aws-sdk/" apps/readest-app/src
```

Expected: **no output**.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: **PASS** (no regressions vs. previous task).

- [ ] **Step 5: Run lint**

Run: `pnpm lint`
Expected: **PASS** with no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/readest-app/package.json pnpm-lock.yaml
CI=true git commit -m "chore(storage): remove @aws-sdk dependencies after worker-safe cutover"
```

- [ ] **Step 7: Final manual verification checklist (release-only, not a code step)**

Pre-deploy:

- Deploy to an R2-configured environment. Exercise upload → download → share/create → share/import end-to-end. Verify SSR boot has no `__vite_ssr_import_xx_.u is not a function`.
- Deploy to an S3-configured environment. Exercise the same flow.

---

## Self-Review

### Spec coverage

| Spec section                                             | Covered in                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| §1 Goals — eliminate SSR failure                         | Task 6 (dep removal) + manual verify                                     |
| §1 Goals — single S3-compatible provider                 | Task 2                                                                   |
| §1 Goals — Effect service + typed errors                 | Tasks 1–2                                                                |
| §1 Goals — unified `file_key` naming                     | Task 5                                                                   |
| §1 Goals — full caller migration                         | Tasks 3–4                                                                |
| §1 Goals — remove `@aws-sdk/*`                           | Task 6                                                                   |
| §3 Architecture — `runStorageProgram` boundary helper    | Task 2 (created) + Tasks 3–4 (used)                                      |
| §4.1 `ObjectStorage` Tag + 5 methods                     | Task 1 Step 4                                                            |
| §4.2 Error classes with `_tag`                           | Task 1 Step 3                                                            |
| §4.4 Caller patterns — `Effect.catchTag` for idempotency | Task 3 Steps 5–6                                                         |
| §5.1–5.2 `StorageConfig` + `makeStorageConfig`           | Task 1 Step 5                                                            |
| §5.3 `StorageLive` composition                           | Task 2 Step 4                                                            |
| §5.4 `runStorageProgram` signature                       | Task 2 Step 5                                                            |
| §5.5 `@/storage/index.ts` barrel                         | Task 2 Step 6                                                            |
| §6 Provider implementation                               | Task 2 Step 3                                                            |
| §7 File-key unification                                  | Task 5 Step 1                                                            |
| §8 Route migration (10 routes)                           | Tasks 3 (storage routes) + 4 (share routes)                              |
| §8.4 Legacy file deletions                               | Task 5 Step 2 + Task 6 Step 1                                            |
| §8.5 Post-migration grep                                 | Task 5 Step 3 + Task 6 Step 3                                            |
| §9.1 Provider tests                                      | Task 2 Step 1                                                            |
| §9.2 Config tests                                        | Task 1 Step 1                                                            |
| §9.3 Route integration tests                             | Task 3 Step 1                                                            |
| §10.2 Migration order (4 steps)                          | Tasks 1–2 (step 1), Task 3 (step 2), Task 4 (step 3), Tasks 5–6 (step 4) |
| §10.3 Per-commit revertibility                           | Each task ends with one `git commit`                                     |

### Placeholder scan

- No `TBD` / `TODO` / `fill in details` strings present.
- Every code step shows the full code to write or the explicit replacement target line range.
- Every shell step shows the exact command and expected outcome.
- Cross-task references are by name (`runStorageProgram`, `StorageNotFoundError`) — all defined in earlier tasks.

### Type and name consistency

- `ObjectStorage`, `StorageConfig`, `StorageConfigShape`, `S3CompatibleStorageLive`, `StorageLive`, `runStorageProgram` — consistent across Tasks 1, 2, 3, 4.
- Error class names: `StorageConfigError`, `StorageSignError`, `StorageRequestError`, `StorageNotFoundError` — identical in spec §4.2, Task 1 Step 3, and all later `instanceof` / `catchTag` references.
- Method signatures in Task 1 Step 4 (`ObjectStorage` Tag) match the implementations in Task 2 Step 3 (`S3CompatibleStorageLive`) — same parameter order and return Effect signature.
- `getRemoteBookFilename` returns `${book.hash}/${book.hash}.${EXTS[book.format]}` consistently (spec §7.2 + Task 5 Step 1).
