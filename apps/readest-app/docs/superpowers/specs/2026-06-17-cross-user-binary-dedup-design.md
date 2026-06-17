# Cross-User Binary Dedup — Design (Phase 2)

**Status:** Approved (design); ready for implementation planning.
**Builds on:** Phase 1 per-user isolation (branch `fix/cross-user-data-isolation`). Phase 2 must keep Phase-1 isolation intact: ONLY the book binary may be shared across users; metadata, reading progress, notes, and highlights remain strictly per-user.

## Goal

Identical book binaries (same content) are stored once server-side and referenced by each owner, instead of one physical copy per user. Saves storage; does not change per-user quota accounting or isolation.

## Decisions (locked)

1. **Trust model — server-verified hashing (storage-only dedup).** The dedup-skip/reference decision is gated on a content hash the storage backend _verified against the uploaded bytes_, never an unverified client claim. This eliminates the content-theft / existence-oracle risk: a caller can only get a reference to content they actually uploaded.
2. **Existing data — greenfield.** The project is new with no production objects to preserve. No backfill, no migration, no dual-scheme transition code. All uploads use the new scheme from the start. (`content_hash` is nullable only for forward-safety.)
3. **Quota — logical, unchanged.** Each user keeps their own `files` row(s) with `file_size`; quota = `sum(file_size) WHERE user_id AND deleted_at IS NULL`. Physical bytes are deduped; each owner still counts the book against their quota.

## Identity

- **Dedup key:** a full-file **SHA-256** (`content_hash`). This is distinct from the existing `bookHash` (a _partial_ MD5) — the partial MD5 is collision-prone and must NOT be used to key cross-user dedup. `bookHash` remains the book identity used by sync/metadata.
- **Shared object key:** `content/<sha256>` — user-independent, so it survives any single owner deleting their reference.

## Data model

`files` table (existing: `id, user_id, book_hash, file_key (unique), file_size, created_at, updated_at, deleted_at, replica_kind, replica_id`) gains:

- `content_hash text` (nullable) — the SHA-256 of the physical content this row references; null = legacy/per-user object (won't occur in greenfield, kept for safety).
- Index `idx_files_content_hash_live` on `(content_hash) WHERE deleted_at IS NULL` (or `(content_hash, deleted_at)`) to make refcount + GC queries cheap.

The per-user `file_key` (`<user_id>/...`) is **retained** as the row's logical key so the existing stats / list / purge / delete / download row-ownership logic keeps working unchanged. The physical bytes live at `content/<sha>`, referenced via `content_hash`.

## Upload flow (2-step: stage → finalize)

The current flow mints a presigned PUT to a per-user key and inserts the `files` row up front. Phase 2 replaces it with stage-then-finalize so dedup happens after the verified bytes land.

1. **`POST /api/storage/upload`** (request): body `{ fileName, fileSize, bookHash, sha256 }`.
   - Server mints a presigned PUT to a **staging key** `staging/<user.id>/<uuid>`, configured to require the backend's SHA-256 checksum header (`x-amz-checksum-sha256` = the client's `sha256`). The backend rejects the PUT if the bytes don't match the checksum.
   - Response: `{ stagingKey, uploadUrl }` (plus the checksum header the client must send). No quota row is written yet.
2. **Client PUTs** the bytes to `uploadUrl` (with the checksum header).
3. **`POST /api/storage/finalize`** (request): body `{ stagingKey, sha256, bookHash, fileName, fileSize }`.
   - Server verifies the staged object exists and its backend-recorded checksum equals `sha256` (reject otherwise → 400, delete staging).
   - **Quota gate:** compute real usage `sum(file_size) WHERE user_id AND not deleted`; reject if `usage + fileSize > quota + grace` (matches the existing gate), unless the user already references this `content_hash` (no new logical bytes).
   - **Dedup:** `headObject(content/<sha>)`. If absent → `copyObject(staging → content/<sha>)`. Always `deleteObject(staging)` afterward.
   - **Reference row:** upsert the caller's `files` row with `file_key = <user.id>/<fileName>`, `book_hash`, `content_hash = sha256`, `file_size`. `onConflictDoNothing` on `file_key` keeps it idempotent.
   - Response: `{ ok: true }`.

**Same-user skip:** if the caller already has a live `files` row for this `content_hash`, finalize can short-circuit (no copy, idempotent ref) — preserving today's intra-user skip behavior.

## Download flow

Unchanged access-control gate: the caller must own a live `files` row (existing `processFileKeys` in `download.ts` already enforces `eq(files.userId, userId)`). Change: sign the object at the row's `content_hash` → `content/<sha>` (instead of the row's `file_key`). Rows without `content_hash` (legacy; none in greenfield) fall back to signing `file_key`.

## Delete / purge / GC (refcount)

- **Soft delete** the caller's `files` row (set `deleted_at`) — unchanged for the row.
- **Physical GC:** the shared `content/<sha>` object is deleted only when no live reference remains:
  `COUNT(*) FROM files WHERE content_hash = <sha> AND deleted_at IS NULL` = 0.
  Delete/purge routes compute this refcount (within the RLS-bypass admin path used for cross-user counting, or via a dedicated server function) before issuing `deleteObject(content/<sha>)`. If the count is > 0, the object is kept; only the caller's row is tombstoned.
- Legacy per-user objects (none in greenfield) keep their current direct `deleteObject(file_key)` behavior.

> Note: counting references across users requires reading other users' `files` rows, which RLS forbids under the caller's scope. The refcount must run in a bypass/admin context (like the existing share/import path) or via a `SECURITY DEFINER` SQL function that returns only the integer count — never row contents — to avoid leaking what other users own.

## Security properties

- **No content-theft oracle.** Skip/reference is gated on a backend-verified checksum proving the uploader transferred matching bytes; a client cannot obtain a reference to content it did not upload.
- **No existence oracle.** The server never tells the client whether `content/<sha>` already exists; dedup is an internal decision after the client's own upload.
- **Isolation preserved.** Only the binary blob is shared. `files` rows, library, progress, notes, highlights stay per-user (Phase 1). The refcount query returns a count only, never another user's data.

## Backend capability dependency + fallback

The verified-checksum model needs the S3-compatible backend (`src/storage/s3Compatible.ts`) to support SHA-256 checksums on PUT (`x-amz-checksum-sha256`) and to expose the stored checksum (via `headObject`/`GetObjectAttributes`). The `ObjectStorage` port already has `headObject` and `copyObject`; `getUploadSignedUrl` must be extended to attach the checksum requirement, and `headObject` to surface the checksum.

**Plan step 0 verifies this against the live backend.** If checksums are unsupported:

- **Fallback:** server stream-hashes staged files **under a size threshold** (e.g. 25 MiB) to compute the SHA-256, dedups those; files **above** the threshold are stored per-user (no dedup) to avoid streaming gigabytes through the Worker. This keeps the common case (small e-books) deduped and is documented as a known limitation. The 2-step stage→finalize protocol is unchanged; only the hash source differs.

## Components / files touched

- `src/db/schema/files.ts` — add `content_hash` + index. New migration `00NN_files_content_hash.sql`.
- `src/storage/service.ts` + `src/storage/s3Compatible.ts` — extend `getUploadSignedUrl` (checksum requirement), `headObject` (surface checksum); reuse `copyObject`, `deleteObject`.
- `src/app/api/storage/upload.ts` — switch to minting a staging presigned PUT.
- `src/app/api/storage/finalize.ts` — NEW route: verify checksum, quota-gate, dedup (head/copy), upsert reference row.
- `src/app/api/storage/download.ts` — sign `content/<content_hash>` for referenced rows.
- `src/app/api/storage/delete.ts`, `purge.ts` — refcount before deleting the shared object.
- `src/libs/storage.ts` (client) — compute SHA-256, 2-step stage→finalize in `uploadFile`.
- `src/storage/...` server functions / RLS — a count-only refcount helper (bypass/`SECURITY DEFINER`).
- Tests alongside each (Vitest), plus an RLS/refcount integration test.

## Out of scope (explicitly)

- Backfilling/deduping any pre-existing objects (greenfield).
- Cross-user dedup of replica files (dictionaries) — books only for this phase.
- Bandwidth-saving skip-upload across users (we chose storage-only dedup; the uploader always transfers bytes).
- Client-trusted hashing without backend verification.

## Test strategy

- Unit: finalize dedup logic (first uploader copies to `content/<sha>`; second uploader references, no copy; staging always deleted); quota gate (counts logical size; same-content re-reference doesn't double-charge); refcount GC (object kept while refs > 0, deleted at 0).
- Security: a finalize with a `sha256` that doesn't match the staged object's verified checksum is rejected (no reference created) — the anti-oracle assertion.
- Integration: two users upload identical content → one physical object, two reference rows, both can download; one deletes → object retained; both delete → object GC'd. Download gate still rejects a user with no reference row.
- Isolation regression: confirm metadata/progress/notes remain per-user (Phase-1 invariants unaffected).
