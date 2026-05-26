# Effect Object Storage Worker-Safe Design

**Status:** Drafted (pending user review)  
**Date:** 2026-05-26  
**Branch:** `fix/s3-storage`  
**Scope:** Replace the current `utils/object.ts` + `utils/s3.ts` + `utils/r2.ts` object-storage stack with a single Effect-based `ObjectStorage` service implemented via a worker-safe S3-compatible signer. Remove the old storage utils and migrate all server-side callers directly to the new service.

---

## 1. Goals & Non-Goals

### Goals

- Eliminate the current SSR/runtime instability caused by `@aws-sdk/client-s3` under the TanStack Start + Cloudflare Vite plugin `ssr` environment.
- Replace the current split `s3.ts` / `r2.ts` implementations with a single `S3-compatible` provider.
- Move storage access behind explicit Effect services and Layers.
- Treat `AWS S3` and `Cloudflare R2` as configuration variants, not separate business-level providers.
- Remove compatibility facades and fully migrate server-side callers to the new storage service.
- Keep support for the existing object operations:
  - presigned upload URL
  - presigned download URL
  - object existence check
  - delete object
  - server-side copy object
- Preserve existing HTTP API shapes for `/api/storage/*` and any dependent routes unless a route-specific behavior change is explicitly required.

### Non-Goals

- Rewriting the full sync pipeline, `cloudService`, or `transferManager` into Effect-first application architecture.
- Changing client-side upload/download protocols.
- Adding multipart upload support.
- Presigned `POST` form uploads.
- Keeping `src/utils/object.ts`, `src/utils/s3.ts`, or `src/utils/r2.ts` as compatibility entrypoints.

---

## 2. Problem Statement

The current storage stack imports `@aws-sdk/client-s3` inside the TanStack Start server graph. Under the current Vite + Cloudflare `ssr` environment, the dependency is resolved through a browser/workerd-oriented SSR bundle rather than a clean Node-only path. The resulting prebundled module fails at runtime with:

```txt
TypeError: __vite_ssr_import_11__.u is not a function
```

Moving `S3Client` construction into TanStack Start middleware does not solve the problem because the failure occurs during SSR dependency resolution and bundling, not because of where the instance is created.

Cloudflare Worker SSR is the real runtime boundary. The storage implementation therefore must run correctly in a fetch/WebCrypto-compatible environment rather than depending on `S3Client` runtime selection.

---

## 3. Design Summary

The new design introduces a single `ObjectStorage` Effect service backed by one worker-safe `S3-compatible` implementation.

`AWS S3` and `Cloudflare R2` remain supported, but only as configuration differences:

- endpoint
- region
- bucket name
- access key
- secret key
- public URL base
- path style behavior

The implementation will use a worker-safe AWS SigV4 signer built for fetch/WebCrypto runtimes. This avoids `S3Client` entirely inside the SSR execution path while preserving the same S3-compatible semantics needed by both AWS and R2.

There is no compatibility facade. All route handlers and other server-side storage consumers are migrated directly to the Effect service.

---

## 4. Architecture

```txt
┌─────────────────────────────────────────────────────────────┐
│                  TanStack Start Server Routes              │
│                                                             │
│  /api/storage/*   /api/share/*   other storage callers      │
│          │                    │                             │
│          └──────────────┬─────┘                             │
│                         ▼                                   │
│              Effect.runPromise(program)                     │
│                         │                                   │
│       ┌─────────────────┴─────────────────┐                 │
│       │      ObjectStorage Effect service │                 │
│       └─────────────────┬─────────────────┘                 │
│                         ▼                                   │
│             S3CompatibleStorageLive                         │
│                         │                                   │
│       ┌─────────────────┴─────────────────┐                 │
│       │     StorageConfig Effect service  │                 │
│       └─────────────────┬─────────────────┘                 │
│                         ▼                                   │
│          env-derived runtime configuration                  │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
        ┌──────────────────────────────────────────────┐
        │     S3-compatible object storage backend     │
        │  AWS S3 or Cloudflare R2 via endpoint/config │
        └──────────────────────────────────────────────┘
```

### Key decisions

1. **Single implementation, multiple configurations**
   `AWS` and `R2` do not get separate providers. They share one implementation.

2. **Effect for dependency boundaries, not for whole-app ideology**
   Storage becomes an explicit service. Routes remain normal TanStack Start routes that run Effect programs at the boundary.

3. **Worker-safe signer over `S3Client`**
   The provider will use a fetch/WebCrypto-compatible SigV4 signer rather than `@aws-sdk/client-s3`.

4. **No compatibility layer**
   The old utility modules are removed. Callers are updated directly.

---

## 5. Service Model

### 5.1 `StorageConfig`

`StorageConfig` is an Effect service carrying runtime configuration only.

Shape:

```ts
type StorageProvider = 's3' | 'r2';

interface StorageConfigShape {
  readonly provider: StorageProvider;
  readonly endpoint: string;
  readonly region: string;
  readonly bucketName: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly publicBaseUrl?: string;
  readonly forcePathStyle: boolean;
}
```

Responsibilities:

- select provider from env
- validate the required credentials and endpoint fields
- provide a normalized runtime config for downstream signing logic

### 5.2 `ObjectStorage`

`ObjectStorage` is the only storage capability exposed to the rest of the server code.

Shape:

```ts
interface ObjectStorageShape {
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
```

### 5.3 `StorageError`

Errors are explicit and typed rather than bare `Error`.

Minimum error set:

- `StorageConfigError`
- `StorageSignError`
- `StorageRequestError`
- `StorageNotFoundError`

Route handlers map them to existing HTTP responses.

---

## 6. Worker-Safe Provider

### 6.1 Provider choice

The implementation uses a worker-safe SigV4 signer suitable for `fetch + WebCrypto` runtimes.

Expected characteristics:

- can sign query-string presigned URLs
- can sign normal fetch requests
- runs in Cloudflare Workers / workerd-compatible runtimes
- works against any S3-compatible endpoint

### 6.2 Operation mapping

#### `getUploadSignedUrl`

- Build object URL from `endpoint + bucket + key`
- Use method `PUT`
- Include `X-Amz-Expires`
- Sign `Content-Length` when upload length is part of the contract
- Return the signed URL string

#### `getDownloadSignedUrl`

- Build object URL from `endpoint + bucket + key`
- Use method `GET`
- Include `X-Amz-Expires`
- Return signed URL string

#### `deleteObject`

- Send a signed `DELETE` request from the server runtime
- Return success/failure as Effect

#### `headObject`

- Send a signed `HEAD` request
- Return `true` if the object exists
- Return `false` on not-found
- Bubble other transport/signing errors

#### `copyObject`

- Send a signed `PUT` request to the destination object
- Add `x-amz-copy-source` header with segment-by-segment encoded source path
- Keep the copy operation fully server-side

### 6.3 Path encoding rules

All object keys must be encoded segment-by-segment, not as one full string.

Reason:

- object keys may contain spaces, ampersands, and other reserved characters
- `x-amz-copy-source` requires this encoding discipline
- existing bugs in copy paths are most likely to happen here

---

## 7. File Layout

### New files

```txt
apps/readest-app/src/storage/
├── service.ts         # ObjectStorage tag + public interface
├── config.ts          # StorageConfig tag + env-derived live layer
├── errors.ts          # typed storage errors
└── s3Compatible.ts    # worker-safe S3-compatible implementation
```

### Modified files

- `apps/readest-app/src/app/api/storage/upload.ts`
- `apps/readest-app/src/app/api/storage/download.ts`
- `apps/readest-app/src/app/api/storage/delete.ts`
- `apps/readest-app/src/app/api/storage/list.ts` if it depends on object existence or signed URL generation
- `apps/readest-app/src/app/api/storage/purge.ts`
- `apps/readest-app/src/app/api/storage/stats.ts` if needed
- `apps/readest-app/src/app/api/share/*` routes that use object copy or signed URLs
- any other route directly using the current object utils

### Deleted files

- `apps/readest-app/src/utils/object.ts`
- `apps/readest-app/src/utils/s3.ts`
- `apps/readest-app/src/utils/r2.ts`
- `apps/readest-app/src/middlewares/storage.ts` unless it gains a non-storage responsibility

---

## 8. Route Integration

Routes remain the runtime boundary. They do not become Layer containers or middleware-based client factories.

Pattern:

1. parse request
2. build Effect program
3. provide `StorageConfigLive`
4. provide `S3CompatibleStorageLive`
5. `Effect.runPromise(...)`
6. map typed storage errors to `Response`

Example shape:

```ts
const program = Effect.gen(function* () {
  const storage = yield* ObjectStorage;
  return yield* storage.getUploadSignedUrl(fileKey, fileSize, 1800);
}).pipe(Effect.provide(StorageConfigLive), Effect.provide(S3CompatibleStorageLive));

const uploadUrl = await Effect.runPromise(program);
```

### Why not middleware injection?

Middleware-based injection does not solve the original problem because the runtime failure was caused by SSR dependency resolution, not by the timing of client construction.

Effect Layers are used here as explicit service injection, not as a workaround for Vite bundling.

---

## 9. Full Migration Strategy

This change is intentionally a full cutover.

### Migration order

1. add `StorageConfig`, `ObjectStorage`, typed errors, and the worker-safe implementation
2. migrate all `/api/storage/*` routes directly to the service
3. migrate share/import routes and any other direct object-storage server callers
4. remove old storage utils and middleware
5. run route regression tests
6. run manual upload/sync verification

### Explicit rule

No caller may continue importing:

- `@/utils/object`
- `@/utils/s3`
- `@/utils/r2`

Any remaining import of those modules after migration is a bug.

---

## 10. Testing Strategy

### Unit tests

Provider-level tests:

- upload presigned URL includes expected method, key encoding, signed headers
- download presigned URL includes expected key encoding and expiry
- `deleteObject` sends signed `DELETE`
- `headObject` returns `true` for success and `false` for not-found
- `copyObject` signs `PUT` with correctly encoded `x-amz-copy-source`

Config-level tests:

- `storageType=s3` produces normalized AWS config
- `storageType=r2` produces normalized R2 config
- missing endpoint or credentials yields `StorageConfigError`

### Route tests

- `/api/storage/upload`
- `/api/storage/download`
- `/api/storage/delete`
- `/api/storage/purge`
- `/api/share/...` routes that depend on storage operations

### Manual verification

- upload through the sync flow
- download existing object
- delete object
- share/import path if it uses copy
- validate both S3 and R2 env modes

---

## 11. Risks & Mitigations

| Risk                                                | Mitigation                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| Hidden callers still import old storage utils       | Delete the old files and use `rg` to verify no imports remain             |
| Route error behavior changes unintentionally        | Keep typed error → HTTP status mapping explicit and add route tests       |
| Public URL semantics differ between AWS and R2      | Keep `publicBaseUrl` out of signer logic and centralize it in config      |
| Copy behavior breaks on special characters          | Add direct tests for spaces, `&`, and nested paths                        |
| Effect adoption leaks too far into unrelated layers | Restrict Effect scope to storage provider boundaries and route invocation |

---

## 12. Out of Scope / Deferred

- multipart upload support
- browser-side direct signing
- converting `cloudService`, `transferManager`, or `appService` to full Effect architecture
- adding a second provider implementation for Node-only `aws-sdk`

---

## 13. Open Items

None. The design chooses:

- single implementation
- worker-safe signer
- Effect service + Layer boundaries
- full migration with no compatibility facade
