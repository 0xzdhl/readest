# Cross-User Binary Dedup Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store identical book binaries once server-side at a content-addressed key, referenced per-user, so two users uploading the same book consume one physical object while keeping strict per-user isolation and logical quota.

**Architecture:** Stage→finalize upload: the client PUTs bytes to a per-user staging object, then calls a finalize route where the SERVER reads the staged bytes (under a size threshold), computes a full-file SHA-256, and dedups into a shared `content/<sha>` object via server-side `copyObject`. Each user keeps a `files` reference row (preserving the `file_key = <userId>/…` invariant and logical quota) carrying a new `content_hash`. Downloads sign `content/<sha>` after the existing owner-only row gate; deletes refcount live references before GC'ing the shared object.

**Tech Stack:** TypeScript (strict, no `any`), Effect TS (`src/storage` ObjectStorage port + s3Compatible layer), Drizzle + Postgres + RLS, TanStack Start server routes (`src/app/api/storage`), Vitest, Cloudflare Workers runtime (workerd — no streaming-hash of large bodies).

## Global Constraints

- Never use `any` — `unknown`/proper types/generics. (`.claude/rules/typescript.md`)
- Strict mode, ES2022. Unused vars `_`-prefixed.
- Test-First: failing test before each fix; run it red, implement, run green. (`.claude/rules/test-first.md`)
- Done-conditions: `pnpm test`, `pnpm lint`. (No `src-tauri/` changes here, so Rust checks N/A.)
- ONLY the book binary may be shared across users; `files` rows, library, progress, notes, highlights stay strictly per-user (Phase 1 invariant — do not regress it).
- Dedup identity is a full-file **SHA-256 hex** string (`content_hash`), NEVER the partial-MD5 `bookHash`.
- Shared object key = `content/<sha256hex>`. Staging key = `staging/<userId>/<uuid>`.
- Storage-only dedup: the uploader ALWAYS transfers bytes; the server is the sole hash authority (no client-supplied hash is ever trusted → no content-theft/existence oracle).
- Dedup size threshold `DEDUP_MAX_BYTES = 25 * 1024 * 1024`. Files larger than this are stored per-user (no dedup) to avoid buffering huge bodies in the Worker.
- Commit after each task (conventional commit); end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Use `CI=true` to satisfy the lint-staged pre-commit hook.

## Spec

`docs/superpowers/specs/2026-06-17-cross-user-binary-dedup-design.md`. Note: this plan promotes the spec's "stream-hash fallback" to the PRIMARY mechanism (server reads staged bytes and hashes) and drops the backend `x-amz-checksum-sha256` dependency entirely — simpler, backend-agnostic, identical security model and user-facing behavior. Above the size threshold there is no dedup (documented limitation).

---

## File Structure

**Create:**

- `src/libs/server/contentHash.ts` — `sha256Hex(bytes: ArrayBuffer): Promise<string>` (WebCrypto).
- `src/app/api/storage/finalize.ts` — the finalize route (verify staging → hash → dedup copy → upsert reference row).
- `src/db/migrations/0005_files_content_hash.sql` — `content_hash` column + index + `SECURITY DEFINER` refcount function.
- Tests alongside each.

**Modify:**

- `src/db/schema/files.ts` — add `contentHash` column + index.
- `src/storage/service.ts` + `src/storage/s3Compatible.ts` — add `getObjectBytes`.
- `src/app/api/storage/upload.ts` — book branch mints a STAGING presigned PUT (temp + replica branches unchanged).
- `src/app/api/storage/download.ts` — sign `content/<content_hash>` when present.
- `src/app/api/storage/delete.ts` + `purge.ts` — refcount-gated GC of the shared object.
- `src/libs/storage.ts` — client `uploadFile` does stage→finalize (`uploadReplicaFile` + `downloadFile` unchanged).

---

## Task 1: Schema — `content_hash` column, index, refcount function

**Files:**

- Modify: `src/db/schema/files.ts`
- Create: `src/db/migrations/0005_files_content_hash.sql`
- Modify: `src/db/migrations/meta/_journal.json` (append idx 5 entry)
- Test: `src/__tests__/db/files-content-hash.test.ts` (schema shape) — or fold into an existing schema test if one exists.

**Interfaces:**

- Produces: `files.contentHash` (drizzle column, `text`, nullable). SQL function `files_content_ref_count(p_content_hash text) returns bigint` — live (non-deleted) reference count across ALL users, SECURITY DEFINER (returns only the integer; never row data).

- [ ] **Step 1: Write the failing test** asserting `files.contentHash` exists on the drizzle table:

```ts
import { describe, it, expect } from 'vitest';
import { files } from '@/db/schema';
describe('files schema', () => {
  it('has a nullable content_hash column', () => {
    expect(files.contentHash).toBeDefined();
    expect(files.contentHash.name).toBe('content_hash');
    expect(files.contentHash.notNull).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm test src/__tests__/db/files-content-hash.test.ts`) — column undefined.
- [ ] **Step 3: Implement schema.** In `src/db/schema/files.ts` add inside the columns object (after `replicaId`): `contentHash: text('content_hash'),` and add to the index list: `index('idx_files_content_hash_live').on(t.contentHash, t.deletedAt),`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Author the migration** `src/db/migrations/0005_files_content_hash.sql` (hand-authored — do NOT run drizzle-kit, it needs a DB):

```sql
ALTER TABLE "files" ADD COLUMN "content_hash" text;
CREATE INDEX IF NOT EXISTS "idx_files_content_hash_live" ON "files" ("content_hash","deleted_at");

-- Cross-user live reference count for GC. SECURITY DEFINER so it ignores RLS
-- (it must see other users' rows) but returns ONLY a count — never row data.
CREATE OR REPLACE FUNCTION files_content_ref_count(p_content_hash text)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM files
  WHERE content_hash = p_content_hash AND deleted_at IS NULL;
$$;
```

Append to `src/db/migrations/meta/_journal.json` an entry `{ "idx": 5, "version": "7", "when": <a value strictly greater than idx 4's `when`>, "tag": "0005_files_content_hash", "breakpoints": true }` (match the existing entries' shape; keep `when` monotonic vs idx 4).

- [ ] **Step 6: Verify + commit.** `pnpm test && pnpm lint`. Commit: `feat(db): add files.content_hash + cross-user refcount function`.

---

## Task 2: Storage port — `getObjectBytes`

**Files:**

- Modify: `src/storage/service.ts` (add method to the `ObjectStorage` tag), `src/storage/s3Compatible.ts` (implement)
- Test: `src/__tests__/storage/getObjectBytes.test.ts` (mock `client.fetch` if feasible) — otherwise assert the method exists on the live layer and is wired; cover the real read in the Task 8 integration test.

**Interfaces:**

- Produces: `ObjectStorage.getObjectBytes(fileKey: string, bucketName?: string): Effect.Effect<ArrayBuffer, StorageRequestError | StorageNotFoundError>`.

- [ ] **Step 1: Failing test** — assert the live layer exposes `getObjectBytes` and that a 404 maps to `StorageNotFoundError`. Build the layer over a `StorageConfig` test value and stub `AwsClient` via a `vi.mock('aws4fetch', ...)` whose `fetch` returns a `Response` with a known `arrayBuffer()`; assert `runStorageProgram(getObjectBytes('k'))` yields those bytes, and a 404 Response yields `StorageNotFoundError`. (Mirror how other storage behavior is exercised; if mocking `AwsClient` is impractical, assert method presence + defer byte behavior to Task 8 and note it.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Add to the port** in `src/storage/service.ts`:

```ts
    readonly getObjectBytes: (
      fileKey: string,
      bucketName?: string,
    ) => Effect.Effect<ArrayBuffer, StorageRequestError | StorageNotFoundError>;
```

Implement in `src/storage/s3Compatible.ts` (inside `ObjectStorage.of({ ... })`):

```ts
      getObjectBytes: (fileKey, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const r = await client.fetch(objectUrl(bucketName ?? config.bucketName, fileKey), {
              method: 'GET',
            });
            if (r.status === 404) {
              throw new StorageNotFoundError(`Not found: ${fileKey}`);
            }
            if (!r.ok) {
              throw new StorageRequestError(`Get failed: ${r.status}`, r.status);
            }
            return await r.arrayBuffer();
          },
          catch: (e) => {
            if (e instanceof StorageNotFoundError) return e;
            if (e instanceof StorageRequestError) return e;
            return new StorageRequestError(String(e));
          },
        }),
```

If a test-only or in-memory ObjectStorage layer exists under `src/__tests__` or `src/storage`, add `getObjectBytes` there too so existing tests still typecheck.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(storage): add getObjectBytes to ObjectStorage`.

---

## Task 3: Content-hash helper

**Files:**

- Create: `src/libs/server/contentHash.ts`
- Test: `src/__tests__/libs/server/contentHash.test.ts`

**Interfaces:**

- Produces: `sha256Hex(bytes: ArrayBuffer): Promise<string>` — lowercase hex SHA-256. `DEDUP_MAX_BYTES = 25 * 1024 * 1024`.

- [ ] **Step 1: Failing test** with a known vector:

```ts
import { describe, it, expect } from 'vitest';
import { sha256Hex, DEDUP_MAX_BYTES } from '@/libs/server/contentHash';
describe('sha256Hex', () => {
  it('hashes empty input to the SHA-256 of empty', async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('hashes "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('exposes the threshold', () => {
    expect(DEDUP_MAX_BYTES).toBe(26214400);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `src/libs/server/contentHash.ts`:

```ts
export const DEDUP_MAX_BYTES = 25 * 1024 * 1024;

export const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(storage): content SHA-256 helper + dedup threshold`.

---

## Task 4: Upload route → staging presigned PUT (book branch only)

**Files:**

- Modify: `src/app/api/storage/upload.ts` (the non-temp, non-replica book branch only — lines ~120-219)
- Test: `src/__tests__/app/api/storage/upload.test.ts` (extend)

**Interfaces:**

- Consumes: nothing new.
- Produces: `POST /api/storage/upload` for a book request (body has `fileName`, `fileSize`, optional `bookHash`, no `replicaKind`, `temp` falsy) now responds `{ stagingKey: string, uploadUrl: string }` and writes NO `files` row and applies NO quota gate (both move to finalize). `stagingKey = staging/<user.id>/<crypto.randomUUID()>`.

- [ ] **Step 1: Failing test** — POST a book body (fake `tx`, mocked storage `getUploadSignedUrl`), assert the response has `stagingKey` matching `^staging/<user.id>/` and an `uploadUrl`, and that NO `files` insert happened (spy on `tx.insert`). Mirror the existing upload.test harness.
- [ ] **Step 2: Run → FAIL** (current book branch returns `{ uploadUrl, fileKey }` and inserts a row).
- [ ] **Step 3: Implement.** Keep the `if (temp) { ... }` branch unchanged. Keep the replica branch (`replicaKind`/`replicaId` present) unchanged — guard it explicitly: if `replicaKind` is set, run the existing content-addressed per-user logic (do NOT route replicas through staging). For the remaining BOOK branch, replace the head/skip/quota/insert/sign logic with:

```ts
// BOOK upload: stage the bytes; dedup happens at /finalize after the
// server hashes the staged object. No files row / quota gate here.
if (!fileName || !fileSize) {
  return Response.json({ error: 'Missing file info' }, { status: 400 });
}
const stagingKey = `staging/${user.id}/${crypto.randomUUID()}`;
const uploadResult = await runStorageProgram(
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    return yield* storage.getUploadSignedUrl(stagingKey, fileSize, 1800);
  }),
);
if (Either.isLeft(uploadResult)) {
  console.error('Error creating presigned post:', uploadResult.left);
  return Response.json({ error: 'Could not create presigned post' }, { status: 500 });
}
return Response.json({ stagingKey, uploadUrl: uploadResult.right });
```

(Leave the `files`, `getStoragePlanData`, quota imports if still used by other branches; remove any now-unused imports to satisfy lint.)

- [ ] **Step 4: Run → PASS** (the new test + existing upload tests; the quota-gate test from upload.test that asserted the old book-branch behavior will need updating — move/retarget it to finalize in Task 5, or update it here to reflect that the book branch no longer gates; document the change in the report).
- [ ] **Step 5: Commit** `feat(storage): book upload mints a staging presigned PUT`.

---

## Task 5: Finalize route — hash, dedup, reference row

**Files:**

- Create: `src/app/api/storage/finalize.ts`
- Test: `src/__tests__/app/api/storage/finalize.test.ts`

**Interfaces:**

- Consumes: `sha256Hex`, `DEDUP_MAX_BYTES` (Task 3); `ObjectStorage.getObjectBytes/headObject/copyObject/deleteObject` (Task 2); `files.contentHash` (Task 1); `getStoragePlanData`, `STORAGE_QUOTA_GRACE_BYTES` (`src/libs/server/storage-plan`).
- Produces: `POST /api/storage/finalize`, `rlsMiddleware`. Body `{ stagingKey: string; fileName: string; bookHash?: string; fileSize: number }`. Response `{ ok: true; contentHash: string | null; deduped: boolean }` or an error status.

- [ ] **Step 1: Failing test** (fake `tx` + mocked ObjectStorage). Cover, with a staged object whose bytes are known:
  - **first uploader, under threshold:** `headObject(content/<sha>)` → NotFound, so `copyObject(staging → content/<sha>)` is called, `deleteObject(staging)` called, a `files` row is upserted with `content_hash === sha` and `file_key === <user>/<fileName>`. Response `{ ok:true, contentHash: sha, deduped:false }`.
  - **second uploader (content/<sha> already exists):** `headObject` → ok, so `copyObject` is NOT called, staging deleted, the caller's row upserted with the same `content_hash`. `deduped:true`.
  - **stagingKey not owned by caller** (doesn't start with `staging/<user.id>/`) → 403, no storage calls.
  - **staged object missing** (`headObject(staging)` NotFound) → 404.
  - **anti-oracle / integrity:** the `content_hash` written is the server-computed hash of the staged bytes — assert it equals `sha256Hex(stagedBytes)`, NOT any client-provided value (the body has no hash field, proving the client can't influence it).
  - **over threshold:** with `fileSize > DEDUP_MAX_BYTES`, the server does NOT read/hash; it `copyObject(staging → <user>/<fileName>)`, `deleteObject(staging)`, upserts row with `content_hash === null`. `deduped:false`.
  - **quota exceeded** → 403, staging deleted, no row.
- [ ] **Step 2: Run → FAIL** (route doesn't exist).
- [ ] **Step 3: Implement** `src/app/api/storage/finalize.ts`:

```ts
import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNull, sum } from 'drizzle-orm';
import { files } from '@/db/schema';
import { rlsMiddleware } from '@/middlewares/rls';
import { Effect, Either } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
import { DEDUP_MAX_BYTES, sha256Hex } from '@/libs/server/contentHash';
import { getStoragePlanData, STORAGE_QUOTA_GRACE_BYTES } from '@/libs/server/storage-plan';

const CONTENT_PREFIX = 'content';

export const Route = createFileRoute('/api/storage/finalize')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const { user, tx } = context;
        const body: {
          stagingKey?: string;
          fileName?: string;
          bookHash?: string;
          fileSize?: number;
        } = await request.json();
        const { stagingKey, fileName, bookHash, fileSize } = body;

        if (!stagingKey || !fileName || !fileSize) {
          return Response.json({ error: 'Missing finalize info' }, { status: 400 });
        }
        // The staging object must belong to the caller — never let a client
        // finalize someone else's upload.
        if (!stagingKey.startsWith(`staging/${user.id}/`)) {
          return Response.json({ error: 'Invalid staging key' }, { status: 403 });
        }

        const fileKey = `${user.id}/${fileName}`;
        const deleteStaging = () =>
          runStorageProgram(
            Effect.gen(function* () {
              const storage = yield* ObjectStorage;
              yield* storage
                .deleteObject(stagingKey)
                .pipe(Effect.catchTag('StorageNotFoundError', () => Effect.void));
            }),
          );

        // Confirm the staged object exists (a checksum-mismatched / never-sent
        // PUT leaves nothing to finalize).
        const headStaging = await runStorageProgram(
          Effect.gen(function* () {
            const storage = yield* ObjectStorage;
            return yield* storage.headObject(stagingKey);
          }),
        );
        if (Either.isLeft(headStaging)) {
          return Response.json({ error: 'Staged file not found' }, { status: 404 });
        }

        // Quota gate (logical): real usage = sum of caller's live file sizes.
        const { quota } = getStoragePlanData(user);
        const [usageRow] = await tx
          .select({ total: sum(files.fileSize) })
          .from(files)
          .where(and(eq(files.userId, user.id), isNull(files.deletedAt)));
        const usage = Number(usageRow?.total ?? 0);
        if (usage + fileSize > quota + STORAGE_QUOTA_GRACE_BYTES) {
          await deleteStaging();
          return Response.json({ error: 'Insufficient storage quota', usage }, { status: 403 });
        }

        let contentHash: string | null = null;
        let deduped = false;
        try {
          if (fileSize <= DEDUP_MAX_BYTES) {
            const bytesResult = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.getObjectBytes(stagingKey);
              }),
            );
            if (Either.isLeft(bytesResult)) {
              await deleteStaging();
              return Response.json({ error: 'Could not read staged file' }, { status: 500 });
            }
            const sha = await sha256Hex(bytesResult.right);
            contentHash = sha;
            const contentKey = `${CONTENT_PREFIX}/${sha}`;
            const exists = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.headObject(contentKey);
              }),
            );
            if (Either.isLeft(exists)) {
              // Not present yet → promote staging to the shared content object.
              const copy = await runStorageProgram(
                Effect.gen(function* () {
                  const storage = yield* ObjectStorage;
                  return yield* storage.copyObject(stagingKey, contentKey);
                }),
              );
              if (Either.isLeft(copy)) {
                await deleteStaging();
                return Response.json({ error: 'Could not store file' }, { status: 500 });
              }
            } else {
              deduped = true;
            }
            await deleteStaging();
          } else {
            // Too large to hash in-worker: keep a per-user object, no dedup.
            const copy = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.copyObject(stagingKey, fileKey);
              }),
            );
            if (Either.isLeft(copy)) {
              await deleteStaging();
              return Response.json({ error: 'Could not store file' }, { status: 500 });
            }
            await deleteStaging();
          }

          await tx
            .insert(files)
            .values({
              userId: user.id,
              bookHash: bookHash ?? null,
              fileKey,
              fileSize,
              contentHash,
            })
            .onConflictDoNothing({ target: files.fileKey });

          return Response.json({ ok: true, contentHash, deduped });
        } catch (error) {
          console.error('finalize failed', error);
          await deleteStaging();
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verify + commit.** `pnpm test && pnpm lint`. Commit: `feat(storage): finalize route — server-hashed cross-user dedup`.

---

## Task 6: Download — sign the shared content object

**Files:**

- Modify: `src/app/api/storage/download.ts` (`processFileKeys` + the `FileRow` type)
- Test: `src/__tests__/app/api/storage/download-content.test.ts` (or extend an existing download test)

**Interfaces:**

- Consumes: `files.contentHash`.
- Produces: for a matched, caller-owned row with `content_hash`, the signed URL targets `content/<content_hash>`; rows without it sign `file_key` (legacy). The owner gate (`eq(files.userId, userId)` + `fileRecord.userId !== userId`) is unchanged.

- [ ] **Step 1: Failing test** — seed (fake tx) a `files` row owned by the caller with `content_hash = 'deadbeef'`; assert `getDownloadSignedUrl` is called with `content/deadbeef`, not the `file_key`. Add a second case: a row with `content_hash = null` signs the `file_key` (legacy path).
- [ ] **Step 2: Run → FAIL** (currently always signs `fileRecord.fileKey`).
- [ ] **Step 3: Implement.** Add `contentHash: files.contentHash` to BOTH `.select({...})` blocks in `processFileKeys` and to the `FileRow` interface (`contentHash: string | null`). Change the signing call:

```ts
const objectKey = fileRecord.contentHash ? `content/${fileRecord.contentHash}` : fileRecord.fileKey;
const signed = await runStorageProgram(
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    return yield* storage.getDownloadSignedUrl(objectKey, 1800);
  }),
);
```

Also add `contentHash` to the fallback-by-bookHash select so fallback matches sign the content object too.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(storage): download signs shared content object via content_hash`.

---

## Task 7: Delete + purge — refcount-gated GC

**Files:**

- Modify: `src/app/api/storage/delete.ts`, `src/app/api/storage/purge.ts`
- Test: `src/__tests__/app/api/storage/delete-refcount.test.ts`

**Interfaces:**

- Consumes: `files.contentHash`; the SQL function `files_content_ref_count` (Task 1).
- Produces: deleting a row with `content_hash` removes the shared `content/<sha>` object ONLY when no live references remain after this row is deleted; rows without `content_hash` keep the legacy `deleteObject(file_key)`.

- [ ] **Step 1: Failing test** (fake tx + mocked storage). Cases for `delete.ts`:
  - row has `content_hash` and `files_content_ref_count` returns `0` after delete → `deleteObject('content/<sha>')` called.
  - row has `content_hash` and refcount returns `1` (another user still references) → `deleteObject` NOT called for the content object; the row is still deleted.
  - row has `content_hash = null` (legacy) → `deleteObject(file_key)` called (unchanged).
    Model `files_content_ref_count` via the fake tx's `execute`/`select` returning the seeded count.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement (`delete.ts`).** Select `contentHash` too. Replace the delete body so it (a) deletes the DB row first, (b) for a content-hash row, calls the refcount function and conditionally deletes the shared object, (c) for legacy rows deletes `file_key`:

```ts
import { sql } from 'drizzle-orm';
// ...select adds: contentHash: files.contentHash
// after authorizing fileRecord:
await tx.delete(files).where(eq(files.id, fileRecord.id));

const targetKey = fileRecord.contentHash ? `content/${fileRecord.contentHash}` : fileRecord.fileKey;
let shouldDeleteObject = true;
if (fileRecord.contentHash) {
  const [{ count }] = (await tx.execute(
    sql`select files_content_ref_count(${fileRecord.contentHash}) as count`,
  )) as unknown as Array<{ count: number | string }>;
  shouldDeleteObject = Number(count) === 0;
}
if (shouldDeleteObject) {
  const deleteResult = await runStorageProgram(
    Effect.gen(function* () {
      const storage = yield* ObjectStorage;
      yield* storage
        .deleteObject(targetKey)
        .pipe(Effect.catchTag('StorageNotFoundError', () => Effect.void));
    }),
  );
  if (Either.isLeft(deleteResult)) {
    console.error('Error deleting object from storage:', deleteResult.left);
    return Response.json({ error: 'Could not delete file from storage' }, { status: 500 });
  }
}
return Response.json({ message: 'File deleted successfully' });
```

(Order: DB delete BEFORE refcount so the count reflects this removal — race-safe with idempotent object delete; a rare concurrent double-delete may orphan an object, acceptable, see Notes.)

- [ ] **Step 4: Implement (`purge.ts`)** the same per-key logic inside the `Promise.allSettled` map: select `contentHash`, delete the row, refcount when `contentHash` set, conditionally `deleteObject('content/<sha>')`, else `deleteObject(fileKey)`. Keep the existing success/failed accounting.
- [ ] **Step 5: Run → PASS** (delete + purge tests, existing storage tests).
- [ ] **Step 6: Commit** `feat(storage): refcount-gated GC for shared content objects`.

**Notes (include in report):** concurrent deletes of the last two references to the same content can race and leave an orphaned object (storage leak, not a correctness/security bug). Acceptable for v1; a periodic orphan sweep (objects under `content/` with zero live refs) is future work.

---

## Task 8: Client `uploadFile` → stage→finalize

**Files:**

- Modify: `src/libs/storage.ts` (`uploadFile` only — `uploadReplicaFile`, `downloadFile`, `batchGetDownloadUrls` unchanged)
- Test: `src/__tests__/libs/storage-skip-upload.test.ts` (retarget) and/or a new `src/__tests__/libs/storage-upload-finalize.test.ts`

**Interfaces:**

- Consumes: `POST /storage/upload` → `{ stagingKey, uploadUrl }` (Task 4); `POST /storage/finalize` (Task 5).
- Produces: `uploadFile(file, fileFullPath, onProgress?, bookHash?, temp?)` keeps its signature. For non-temp book uploads it now: (1) POST upload → get `{stagingKey, uploadUrl}`; (2) `webUpload`/`tauriUpload` bytes to `uploadUrl`; (3) POST `/storage/finalize` with `{ stagingKey, fileName: file.name, bookHash, fileSize: file.size }`. The `temp` branch is unchanged (still returns `downloadUrl`).

- [ ] **Step 1: Failing test** — mock `fetchWithAuth` so `/storage/upload` returns `{ stagingKey:'staging/u/x', uploadUrl:'https://put' }` and `/storage/finalize` returns `{ ok:true }`; mock `webUpload`. Assert order: upload POST → webUpload(uploadUrl) → finalize POST with the right body. Assert no PUT happens when the upload POST fails.
- [ ] **Step 2: Run → FAIL** (current `uploadFile` expects `{ skipUpload | uploadUrl }` and never calls finalize).
- [ ] **Step 3: Implement** the non-temp path of `uploadFile`:

```ts
const response = await fetchWithAuth(API_ENDPOINTS.upload, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fileName: file.name, fileSize: file.size, bookHash, temp }),
});
if (temp) {
  // unchanged temp handling (parse downloadUrl, optional upload) ...
}
const { stagingKey, uploadUrl } = (await response.json()) as {
  stagingKey: string;
  uploadUrl: string;
};
if (isWebAppPlatform()) {
  await webUpload(file, uploadUrl, onProgress);
} else {
  await tauriUpload(uploadUrl, fileFullPath, 'PUT', onProgress);
}
await fetchWithAuth(getAPIBaseUrl() + '/storage/finalize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ stagingKey, fileName: file.name, bookHash, fileSize: file.size }),
});
return undefined;
```

Preserve the `temp` branch exactly as today (it returns the public `downloadUrl`). Update `parseUploadResponse` usage: the temp branch still parses `{ uploadUrl, downloadUrl }`; the book branch now parses `{ stagingKey, uploadUrl }` (add a small `parseStagingResponse`). Keep error handling/throws.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(storage): client stage→finalize upload flow`.

---

## Task 9: Two-user dedup integration test

**Files:**

- Test: `src/__tests__/integration/cross-user-dedup.test.ts`

- [ ] **Step 1: Write the test** with an in-memory ObjectStorage (a `Map<string, ArrayBuffer>` backing `getUploadSignedUrl`→record key, `getObjectBytes`, `headObject`, `copyObject`, `deleteObject`, `getDownloadSignedUrl`) and a fake tx (or the real test DB harness if `TEST_DATABASE_URL` is set — mirror `rls-isolation.test.ts`). Drive the route handlers directly. Assert end to end:
  - User A stages + finalizes content X (< threshold) → one object at `content/<shaX>`, A has a `files` row with `content_hash=shaX`.
  - User B stages + finalizes the SAME bytes → NO second physical object (copyObject not called the 2nd time / map still has one `content/<shaX>`), B has its own row, `deduped:true`.
  - Both A and B can download (gate passes, both sign `content/<shaX>`); a user C with no row gets no URL (404/undefined) — gate holds.
  - A deletes → object retained (refcount 1 from B). B deletes → object GC'd (refcount 0).
  - Anti-oracle: a finalize whose staged bytes hash to shaX but submitted by a user who never staged those bytes is impossible by construction (finalize reads the staged object the caller uploaded) — assert a finalize with a `stagingKey` not owned by the caller is 403.
- [ ] **Step 2: Run → PASS** (it exercises Tasks 1-7 composed).
- [ ] **Step 3: Run full suite** `pnpm test && pnpm lint`. Expect only the documented pre-existing/sandbox-flaky failures (upload-quota retargeted in Task 4/5; edgeTTS/opds-req flaky).
- [ ] **Step 4: Commit** `test(storage): cross-user dedup end-to-end`.

---

## Self-Review

- **Spec coverage:** content_hash model (T1), shared `content/<sha>` (T5), per-user reference rows + logical quota (T5 insert + quota gate), server-verified hashing/no oracle (T5 reads staged bytes, no client hash; T9 anti-oracle), stage→finalize (T4+T5+T8), download gate + content signing (T6), refcount GC (T7), greenfield/no-backfill (no migration task), size-threshold fallback (T3+T5). ✓
- **Placeholder scan:** every code step has concrete code; migration SQL is literal; test assertions are specified. The `_journal.json when` value is "strictly greater than idx 4" (a real constraint, not a placeholder — the implementer reads idx 4's value). ✓
- **Type consistency:** `contentHash`/`content_hash`, `sha256Hex`, `DEDUP_MAX_BYTES`, `getObjectBytes`, `files_content_ref_count`, `stagingKey`, `content/<sha>` used identically across tasks. ✓
- **Known deviation from spec:** server stream-hash is the primary mechanism (not S3 checksums); large files (> 25 MiB) are not deduped. Documented in the Spec note above and Task 5/3.
