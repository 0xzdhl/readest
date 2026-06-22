/**
 * Task 9: Two-user cross-dedup end-to-end integration test.
 *
 * Proves that Tasks 1-8 compose correctly:
 *  1. User A stages + finalizes bytes X (< DEDUP_MAX_BYTES) → exactly ONE object at
 *     `content/<shaX>`; A has a files row with content_hash=shaX, deduped=false.
 *  2. User B stages the SAME bytes X → finalize → NO second physical object; B has its
 *     own row with deduped=true.
 *  3. Both A and B download → both resolve to `content/<shaX>`. User C (no row) → no URL.
 *  4. A deletes → `content/<shaX>` retained (refcount still 1 from B). B deletes →
 *     `content/<shaX>` GC'd (refcount 0).
 *  5. Anti-oracle: finalize with a stagingKey not owned by the caller → 403, no row created.
 *
 * Architecture: in-memory ObjectStorage (Map<string, ArrayBuffer>) + fake tx (in-memory
 * arrays for the `files` table + a live refcount function). Route handlers from
 * `finalize.ts`, `download.ts`, and `delete.ts` are driven directly (bypassing middleware)
 * so no DB or network is required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Effect, Either, Layer } from 'effect';
import { ObjectStorage } from '@/storage';
import { StorageNotFoundError } from '@/storage/errors';
import { sha256Hex } from '@/libs/server/contentHash';
import type { DbTx } from '@/db/rls';

// ---------------------------------------------------------------------------
// 1. Mock runStorageProgram to use the in-memory ObjectStorage layer
// ---------------------------------------------------------------------------

// We intercept `runStorageProgram` to replace `StorageLive` (which tries to
// read real S3 config env vars) with an in-memory layer for each test.
const runStorageProgramMock = vi.hoisted(() => vi.fn());
vi.mock('@/storage/run', () => ({
  runStorageProgram: runStorageProgramMock,
}));

// Also mock clientEnv so getStoragePlanData resolves without real env vars.
vi.mock('@/clientEnv', () => ({
  clientEnv: {
    VITE_STORAGE_FIXED_QUOTA: 10 * 1024 * 1024 * 1024, // 10 GiB — no quota block
  },
}));

// ---------------------------------------------------------------------------
// 2. Import route handlers (after mocks are installed)
// ---------------------------------------------------------------------------
import { Route as FinalizeRoute } from '@/app/api/storage/finalize';
import { Route as DownloadRoute } from '@/app/api/storage/download';
import { Route as DeleteRoute } from '@/app/api/storage/delete';

// ---------------------------------------------------------------------------
// 3. Handler extractor helpers
// ---------------------------------------------------------------------------
type HandlerArgs = {
  request: Request;
  params: Record<string, string>;
  context: Record<string, unknown>;
};
type Handler = (args: HandlerArgs) => Promise<Response>;

const getHandler = (route: unknown, method: string): Handler => {
  const r = route as { options: { server?: { handlers?: Record<string, Handler> } } };
  const h = r.options.server?.handlers?.[method];
  if (!h) throw new Error(`No ${method} handler on route`);
  return h;
};

// ---------------------------------------------------------------------------
// 4. In-memory ObjectStorage factory
// ---------------------------------------------------------------------------

interface InMemoryStorageStats {
  copyObjectCallCount: number;
  deleteObjectCallCount: number;
}

function makeInMemoryStorage(
  store: Map<string, ArrayBuffer>,
  stats: InMemoryStorageStats,
): ReturnType<typeof ObjectStorage.of> {
  return ObjectStorage.of({
    getUploadSignedUrl: (
      fileKey: string,
      _contentLength: number,
      _expiresIn: number,
      _bucket?: string,
    ) => Effect.succeed(`https://fake-upload.test/${fileKey}`),

    getDownloadSignedUrl: (fileKey: string, _expiresIn: number, _bucket?: string) =>
      Effect.succeed(`https://fake-download.test/${fileKey}`),

    headObject: (fileKey: string, _bucket?: string) =>
      store.has(fileKey) ? Effect.void : Effect.fail(new StorageNotFoundError(fileKey)),

    getObjectBytes: (fileKey: string, _bucket?: string) => {
      const data = store.get(fileKey);
      if (!data) {
        return Effect.fail(new StorageNotFoundError(fileKey));
      }
      return Effect.succeed(data);
    },

    copyObject: (
      sourceFileKey: string,
      destFileKey: string,
      _bucket?: string,
      _srcBucket?: string,
    ) => {
      const data = store.get(sourceFileKey);
      if (!data) {
        return Effect.fail(new StorageNotFoundError(sourceFileKey));
      }
      stats.copyObjectCallCount++;
      store.set(destFileKey, data);
      return Effect.void;
    },

    deleteObject: (fileKey: string, _bucket?: string) => {
      stats.deleteObjectCallCount++;
      store.delete(fileKey);
      return Effect.void;
    },
  });
}

// ---------------------------------------------------------------------------
// 5. In-memory files row type + shared counter
// ---------------------------------------------------------------------------

interface FilesRow {
  id: string;
  userId: string;
  bookHash: string | null;
  fileKey: string;
  fileSize: number;
  contentHash: string | null;
  deletedAt: Date | null;
}

let rowIdCounter = 0;

// ---------------------------------------------------------------------------
// 5b. Per-user aware tx factory
// ---------------------------------------------------------------------------
// The handlers use these query patterns (no `.orderBy`, only some use `.limit`):
//
//   finalize quota: select({total:sum(...)}).from(files).where(...)  ← awaited at .where()
//   download:       select({...}).from(files).where(...)              ← awaited at .where()
//   delete select:  select({...}).from(files).where(...).limit(1)     ← awaited at .limit()
//   delete row:     tx.delete(files).where(eq(files.id, id))          ← awaited at .where()
//   execute:        tx.execute(sql`...`)
//
// `.where()` must be both thenable (Promise-like) AND have a `.limit()` child.
// We build a "thenable chain" object that is a PromiseLike resolving to the
// rows array AND exposes `.limit(n)` that also resolves to a slice of rows.

/**
 * Captured state from the last non-aggregate SELECT .where() call.
 * Reset by each test via `beforeEach`. Allows assertions on query structure
 * (e.g. verifying that the download SELECT includes an inArray fileKey filter).
 */
let lastSelectFileKeyFilter: string[] | undefined = undefined;

function makeUserAwareTx(userId: string, filesRows: FilesRow[]): DbTx {
  const refCount = (contentHash: string): number =>
    filesRows.filter((r) => r.contentHash === contentHash && r.deletedAt === null).length;

  const liveRowsForUser = () =>
    filesRows.filter((r) => r.deletedAt === null && r.userId === userId);

  /**
   * Returns an object that:
   * - is a thenable (Promise-like) that resolves to `rows`
   * - has a `.limit(n)` method that also returns a Promise resolving to rows
   */
  function makeSelectResult(rows: FilesRow[]) {
    // Wrap in a real Promise so the handler can `const [row] = await tx.select...`
    const p = Promise.resolve(rows) as Promise<FilesRow[]> & {
      limit: (n: number) => Promise<FilesRow[]>;
    };
    p.limit = (_n: number) => Promise.resolve(rows);
    return p;
  }

  // Special "sum" result for finalize's quota query — returns [{total: X}]
  function makeAggResult(total: number) {
    const rows = [{ total }] as unknown as FilesRow[];
    const p = Promise.resolve(rows) as Promise<FilesRow[]> & {
      limit: (n: number) => Promise<FilesRow[]>;
    };
    p.limit = (_n: number) => Promise.resolve(rows);
    return p;
  }

  const tx: Record<string, unknown> = {
    select: (_cols?: unknown) => {
      // The first select call in finalize is the quota sum (returns [{total}]).
      // Subsequent calls (download, delete) return live rows for the user.
      // We use a heuristic: if _cols has a key named 'total' it's the quota query.
      const isAggQuery =
        _cols !== undefined &&
        typeof _cols === 'object' &&
        _cols !== null &&
        'total' in (_cols as object);
      return {
        from: (_table: unknown) => ({
          where: (cond: unknown) => {
            if (isAggQuery) {
              const usageBytes = liveRowsForUser().reduce((s, r) => s + r.fileSize, 0);
              return makeAggResult(usageBytes);
            }
            // For non-aggregate queries, extract the inArray(files.fileKey, ...) filter
            // from the WHERE condition and apply it to the in-memory rows. This makes
            // the fake-tx respect the production fileKey filter so that a regression
            // removing inArray from download.ts would cause the assertion below to fail.
            const requestedFileKeys = extractInArrayValues(cond as SqlLike);
            // Capture for regression assertions in the calling test.
            lastSelectFileKeyFilter = requestedFileKeys;
            const rows =
              requestedFileKeys !== undefined
                ? liveRowsForUser().filter((r) => requestedFileKeys.includes(r.fileKey))
                : liveRowsForUser();
            return makeSelectResult(rows);
          },
        }),
      };
    },

    insert: (_table: unknown) => ({
      values: (vals: Omit<FilesRow, 'id' | 'deletedAt'>) => {
        const insertIfAbsent = () => {
          const exists = filesRows.some((r) => r.fileKey === vals.fileKey);
          if (!exists) {
            filesRows.push({
              id: `row-${++rowIdCounter}`,
              deletedAt: null,
              ...vals,
            });
          }
          return Promise.resolve(undefined);
        };
        return {
          onConflictDoNothing: (_opts?: unknown) => insertIfAbsent(),
          // Mirror finalize's reconcile-on-conflict (setWhere: isNull(content_hash)):
          // insert if absent, otherwise heal a stale NULL-contentHash row from `set`.
          onConflictDoUpdate: (opts?: { set?: Partial<FilesRow> }) => {
            const existing = filesRows.find((r) => r.fileKey === vals.fileKey);
            if (!existing) return insertIfAbsent();
            if (existing.contentHash == null && opts?.set) {
              Object.assign(existing, opts.set);
            }
            return Promise.resolve(undefined);
          },
        };
      },
    }),

    delete: (_table: unknown) => ({
      where: (cond: unknown) => {
        const idValue = extractEqValue(cond as SqlLike);
        if (idValue) {
          const idx = filesRows.findIndex((r) => r.id === idValue);
          if (idx !== -1) filesRows.splice(idx, 1);
        }
        return Promise.resolve(undefined);
      },
    }),

    execute: (_sql: unknown) => {
      const hash = extractSqlParam(_sql as SqlLike);
      const count = hash ? refCount(hash) : 0;
      return Promise.resolve([{ count }]);
    },
  };

  return tx as unknown as DbTx;
}

// ---------------------------------------------------------------------------
// 6. SQL expression value extractors (for fake tx eq / sql template)
// ---------------------------------------------------------------------------

interface SqlLike {
  queryChunks?: unknown[];
}

/**
 * Extract the right-hand scalar value from a Drizzle `eq(col, val)` expression.
 *
 * Drizzle compiles `eq(files.id, 'row-a')` into queryChunks like:
 *   [{value: ['']}, <column-def>, {value: [' = ']}, {brand: '...', value: 'row-a', encoder: ...}, {value: ['']}]
 *
 * The bound value is a chunk with `value` as a string (not an array).
 */
function extractEqValue(expr: SqlLike): string | undefined {
  if (!expr?.queryChunks) return undefined;
  for (const chunk of expr.queryChunks) {
    if (chunk !== null && typeof chunk === 'object') {
      const c = chunk as Record<string, unknown>;
      // The bound parameter chunk has `value` as a plain string (not an array).
      if ('value' in c && typeof c['value'] === 'string') return c['value'];
    }
  }
  return undefined;
}

/**
 * Extract the first bound parameter from a `sql\`...\`` tagged template.
 *
 * Drizzle compiles `sql\`... ${sha} ...\`` into queryChunks like:
 *   [{value: ['... (']}, 'the-sha-value', {value: [') as count']}]
 *
 * The bound parameter is directly a plain string (not wrapped in an object).
 */
function extractSqlParam(expr: SqlLike): string | undefined {
  if (!expr?.queryChunks) return undefined;
  for (const chunk of expr.queryChunks) {
    // In `sql` tagged template, interpolated values appear as plain strings.
    if (typeof chunk === 'string') return chunk;
  }
  return undefined;
}

/**
 * Extract the values array from a Drizzle `inArray(col, values)` expression,
 * searching recursively through nested `and(...)` wrappers.
 *
 * Drizzle compiles `inArray(col, ['a', 'b'])` into queryChunks like:
 *   [{value: ['']}, <column-def>, {value: [' in ']}, <params-array>, {value: ['']}]
 *
 * where <params-array> is an Array of Drizzle bound-parameter objects with shape
 * `{brand: '...', value: 'the-string', encoder: ...}`. The values array chunk
 * immediately follows the chunk with `value: [' in ']`.
 */
function extractInArrayValues(expr: SqlLike): string[] | undefined {
  if (!expr?.queryChunks) return undefined;
  const chunks = expr.queryChunks;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Check if this chunk is an SQL-like sub-expression (nested and/inArray)
    if (chunk !== null && typeof chunk === 'object' && !Array.isArray(chunk)) {
      const c = chunk as Record<string, unknown>;
      // Recurse into nested expressions (e.g. and() wraps sub-expressions in queryChunks)
      if ('queryChunks' in c) {
        const found = extractInArrayValues(c as SqlLike);
        if (found !== undefined) return found;
      }
      // Detect " in " operator chunk, then next chunk is the bound-param values array
      if ('value' in c && Array.isArray(c['value'])) {
        const valArr = c['value'] as unknown[];
        if (valArr.length === 1 && typeof valArr[0] === 'string' && valArr[0].trim() === 'in') {
          const next = chunks[i + 1];
          if (Array.isArray(next)) {
            // Items are either plain strings (simple mock) or Drizzle bound-param objects
            // with shape {brand, value: string, encoder}.
            const extracted = next.map((item) => {
              if (typeof item === 'string') return item;
              if (item !== null && typeof item === 'object' && 'value' in (item as object)) {
                const v = (item as Record<string, unknown>)['value'];
                if (typeof v === 'string') return v;
              }
              return null;
            });
            if (extracted.every((v) => v !== null)) {
              return extracted as string[];
            }
          }
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 7. runStorageProgram shim factory
//    Runs the Effect with the provided in-memory storage layer and wraps
//    the result in Either (success or failure) — mirrors run.ts behaviour.
// ---------------------------------------------------------------------------

function makeRunStorageProgram(storage: ReturnType<typeof ObjectStorage.of>) {
  return async <A>(
    prog: Effect.Effect<A, import('@/storage').StorageError, ObjectStorage>,
  ): Promise<Either.Either<A, import('@/storage').StorageError>> => {
    const layer = Layer.succeed(ObjectStorage, storage);
    return Effect.runPromise(
      Effect.either(Effect.provide(prog, layer)) as Effect.Effect<
        Either.Either<A, import('@/storage').StorageError>,
        never,
        never
      >,
    );
  };
}

// ---------------------------------------------------------------------------
// 8. Test fixtures
// ---------------------------------------------------------------------------

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const TEST_BYTES = new TextEncoder().encode('hello dedup world').buffer as ArrayBuffer;

function makeUser(id: string) {
  return {
    id,
    email: `${id.slice(0, 4)}@test`,
    name: 'Test',
    plan: 'free' as const,
    storageUsageBytes: 0,
    storagePurchasedBytes: 0,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function finalizeRequest(body: {
  stagingKey: string;
  fileName: string;
  fileSize: number;
  bookHash?: string;
}) {
  return new Request('http://localhost/api/storage/finalize', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function downloadRequest(fileKey: string) {
  return new Request(
    `http://localhost/api/storage/download?fileKey=${encodeURIComponent(fileKey)}`,
    { method: 'GET' },
  );
}

function deleteRequest(fileKey: string) {
  return new Request(`http://localhost/api/storage/delete?fileKey=${encodeURIComponent(fileKey)}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// 9. Tests
// ---------------------------------------------------------------------------

describe('cross-user binary dedup — end-to-end (in-memory)', () => {
  let store: Map<string, ArrayBuffer>;
  let stats: InMemoryStorageStats;
  let filesRows: FilesRow[];
  let storage: ReturnType<typeof ObjectStorage.of>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new Map<string, ArrayBuffer>();
    stats = { copyObjectCallCount: 0, deleteObjectCallCount: 0 };
    filesRows = [];
    rowIdCounter = 0;
    lastSelectFileKeyFilter = undefined;
    storage = makeInMemoryStorage(store, stats);
    runStorageProgramMock.mockImplementation(makeRunStorageProgram(storage));
  });

  // ─── Assertion 1 + 2: dedup path ────────────────────────────────────────
  it('(1+2) User A finalizes → one content object; User B finalizes same bytes → deduped, no second object', async () => {
    const finalizeHandler = getHandler(FinalizeRoute, 'POST');

    // Compute expected sha
    const expectedSha = await sha256Hex(TEST_BYTES);
    const contentKey = `content/${expectedSha}`;

    // Arrange: pre-stage A's bytes (simulating a prior PUT to the signed URL)
    const stagingKeyA = `staging/${USER_A}/uuid-a-1`;
    store.set(stagingKeyA, TEST_BYTES);

    // --- User A finalizes ---
    const copyCallsBefore = stats.copyObjectCallCount;
    const resA = await finalizeHandler({
      request: finalizeRequest({
        stagingKey: stagingKeyA,
        fileName: 'book.epub',
        fileSize: TEST_BYTES.byteLength,
        bookHash: 'hash-book-1',
      }),
      params: {},
      context: { user: makeUser(USER_A), tx: makeUserAwareTx(USER_A, filesRows) },
    });

    expect(resA.status, 'A finalize status').toBe(200);
    const bodyA = (await resA.json()) as { ok?: boolean; contentHash?: string; deduped?: boolean };
    expect(bodyA.ok, 'A finalize ok').toBe(true);
    expect(bodyA.contentHash, 'A content_hash is the sha256').toBe(expectedSha);
    expect(bodyA.deduped, 'A is not deduped (first uploader)').toBe(false);

    // Exactly one copy happened (staging → content/<sha>)
    expect(stats.copyObjectCallCount - copyCallsBefore, 'copyObject called once for A').toBe(1);

    // The shared content object exists; staging key is cleaned up
    expect(store.has(contentKey), 'content/<sha> exists after A finalizes').toBe(true);
    expect(store.has(stagingKeyA), 'staging key deleted after A finalizes').toBe(false);

    // A has a files row
    const rowA = filesRows.find((r) => r.userId === USER_A);
    expect(rowA, "A's row exists").toBeDefined();
    expect(rowA?.contentHash, "A's content_hash").toBe(expectedSha);
    expect(rowA?.fileKey, "A's file_key").toBe(`${USER_A}/book.epub`);

    // --- User B stages + finalizes the SAME bytes ---
    const stagingKeyB = `staging/${USER_B}/uuid-b-1`;
    store.set(stagingKeyB, TEST_BYTES);

    const copyCallsBeforeB = stats.copyObjectCallCount;
    const resB = await finalizeHandler({
      request: finalizeRequest({
        stagingKey: stagingKeyB,
        fileName: 'book.epub',
        fileSize: TEST_BYTES.byteLength,
        bookHash: 'hash-book-1',
      }),
      params: {},
      context: { user: makeUser(USER_B), tx: makeUserAwareTx(USER_B, filesRows) },
    });

    expect(resB.status, 'B finalize status').toBe(200);
    const bodyB = (await resB.json()) as { ok?: boolean; contentHash?: string; deduped?: boolean };
    expect(bodyB.ok, 'B finalize ok').toBe(true);
    expect(bodyB.contentHash, 'B content_hash is the same sha256').toBe(expectedSha);
    expect(bodyB.deduped, 'B IS deduped (second uploader, same bytes)').toBe(true);

    // copyObject was NOT called for B (the content object already existed)
    expect(stats.copyObjectCallCount - copyCallsBeforeB, 'copyObject NOT called for B').toBe(0);

    // Still exactly ONE content object in store (no new key written)
    const contentKeys = [...store.keys()].filter((k) => k.startsWith('content/'));
    expect(contentKeys, 'exactly one content object').toHaveLength(1);
    expect(contentKeys[0], 'content key matches sha').toBe(contentKey);

    // B staging key is cleaned up
    expect(store.has(stagingKeyB), 'B staging key deleted after finalize').toBe(false);

    // B has its own row pointing at the same contentHash
    const rowB = filesRows.find((r) => r.userId === USER_B);
    expect(rowB, "B's row exists").toBeDefined();
    expect(rowB?.contentHash, "B's content_hash matches A's").toBe(expectedSha);
    expect(rowB?.userId, "B's row owned by B").toBe(USER_B);
  });

  // ─── Assertion 3: download gate ─────────────────────────────────────────
  it('(3) A and B download → both get content/<sha> URL; C (no row) → no URL', async () => {
    // Seed rows for A and B
    const sha = await sha256Hex(TEST_BYTES);
    const contentKey = `content/${sha}`;
    store.set(contentKey, TEST_BYTES);

    const fileKeyA = `${USER_A}/book.epub`;
    const fileKeyB = `${USER_B}/book.epub`;
    // A second row for User A with a DIFFERENT fileKey and a different content object.
    // This row must NOT appear in User A's download response when requesting fileKeyA.
    const fileKeyA2 = `${USER_A}/other-book.epub`;
    const otherContentKey = 'content/other-sha-not-requested';
    store.set(otherContentKey, new TextEncoder().encode('other content').buffer as ArrayBuffer);

    filesRows.push(
      {
        id: 'row-a',
        userId: USER_A,
        bookHash: 'hash-book-1',
        fileKey: fileKeyA,
        fileSize: TEST_BYTES.byteLength,
        contentHash: sha,
        deletedAt: null,
      },
      {
        id: 'row-a2',
        userId: USER_A,
        bookHash: 'hash-book-2',
        fileKey: fileKeyA2,
        fileSize: 13,
        contentHash: 'other-sha-not-requested',
        deletedAt: null,
      },
      {
        id: 'row-b',
        userId: USER_B,
        bookHash: 'hash-book-1',
        fileKey: fileKeyB,
        fileSize: TEST_BYTES.byteLength,
        contentHash: sha,
        deletedAt: null,
      },
    );

    const downloadHandler = getHandler(DownloadRoute, 'GET');

    // User A: should get a signed URL pointing at content/<sha>
    const resA = await downloadHandler({
      request: downloadRequest(fileKeyA),
      params: {},
      context: { user: makeUser(USER_A), tx: makeUserAwareTx(USER_A, filesRows) },
    });
    expect(resA.status, 'A download status').toBe(200);
    const bodyA = (await resA.json()) as { downloadUrl?: string };
    expect(bodyA.downloadUrl, 'A gets a signed URL').toContain(`fake-download.test/${contentKey}`);

    // Real regression-catcher: the fake-tx captures the inArray values from the
    // WHERE condition. If production code removes `inArray(files.fileKey, fileKeys)`
    // from the download SELECT, `extractInArrayValues` returns undefined and
    // `lastSelectFileKeyFilter` stays undefined → the assertion below fails.
    // This ensures the production fileKey filter cannot be silently removed.
    expect(
      lastSelectFileKeyFilter,
      'download SELECT must include inArray(files.fileKey, ...) filter',
    ).toEqual([fileKeyA]);

    // The returned URL must point at the correct content object (not the other-book URL).
    expect(
      bodyA.downloadUrl,
      'A download URL resolves to the correct content object',
    ).not.toContain('other-sha-not-requested');

    // User B: should get a signed URL pointing at the SAME content object
    const resB = await downloadHandler({
      request: downloadRequest(fileKeyB),
      params: {},
      context: { user: makeUser(USER_B), tx: makeUserAwareTx(USER_B, filesRows) },
    });
    expect(resB.status, 'B download status').toBe(200);
    const bodyB = (await resB.json()) as { downloadUrl?: string };
    expect(bodyB.downloadUrl, 'B gets a signed URL').toContain(`fake-download.test/${contentKey}`);

    // Both sign the SAME content key
    expect(bodyA.downloadUrl, 'A and B download the same content object').toBe(bodyB.downloadUrl);

    // User C: no row → 404 gate
    const resC = await downloadHandler({
      request: downloadRequest(fileKeyA), // asks for A's file key
      params: {},
      context: { user: makeUser(USER_C), tx: makeUserAwareTx(USER_C, filesRows) },
    });
    expect(resC.status, 'C download is gated (404)').toBe(404);
  });

  // ─── Assertion 4: refcount-gated GC ─────────────────────────────────────
  it('(4) A deletes → content/<sha> retained (B still holds ref); B deletes → GCd (refcount 0)', async () => {
    const sha = await sha256Hex(TEST_BYTES);
    const contentKey = `content/${sha}`;
    store.set(contentKey, TEST_BYTES);

    const fileKeyA = `${USER_A}/book.epub`;
    const fileKeyB = `${USER_B}/book.epub`;
    const rowA: FilesRow = {
      id: 'row-a',
      userId: USER_A,
      bookHash: null,
      fileKey: fileKeyA,
      fileSize: TEST_BYTES.byteLength,
      contentHash: sha,
      deletedAt: null,
    };
    const rowB: FilesRow = {
      id: 'row-b',
      userId: USER_B,
      bookHash: null,
      fileKey: fileKeyB,
      fileSize: TEST_BYTES.byteLength,
      contentHash: sha,
      deletedAt: null,
    };
    filesRows.push(rowA, rowB);

    const deleteHandler = getHandler(DeleteRoute, 'DELETE');

    // --- User A deletes ---
    const resA = await deleteHandler({
      request: deleteRequest(fileKeyA),
      params: {},
      context: { user: makeUser(USER_A), tx: makeUserAwareTx(USER_A, filesRows) },
    });
    expect(resA.status, 'A delete status').toBe(200);

    // A's DB row should be gone
    expect(
      filesRows.find((r) => r.id === 'row-a'),
      'A row removed from DB',
    ).toBeUndefined();

    // content/<sha> MUST still be in the store (B still references it)
    expect(store.has(contentKey), 'content object retained after A deletes (B has ref)').toBe(true);

    // --- User B deletes ---
    const resB = await deleteHandler({
      request: deleteRequest(fileKeyB),
      params: {},
      context: { user: makeUser(USER_B), tx: makeUserAwareTx(USER_B, filesRows) },
    });
    expect(resB.status, 'B delete status').toBe(200);

    // B's DB row should be gone
    expect(
      filesRows.find((r) => r.id === 'row-b'),
      'B row removed from DB',
    ).toBeUndefined();

    // content/<sha> MUST now be removed (refcount dropped to 0)
    expect(store.has(contentKey), 'content object GCd after B deletes (refcount 0)').toBe(false);
  });

  // ─── Assertion 5: anti-oracle (staging key ownership) ───────────────────
  it('(5) finalize with stagingKey owned by another user → 403, no files row created', async () => {
    // A staged bytes under A's prefix; B tries to finalize them
    const stagingKeyA = `staging/${USER_A}/uuid-evil-1`;
    store.set(stagingKeyA, TEST_BYTES);

    const finalizeHandler = getHandler(FinalizeRoute, 'POST');
    const rowCountBefore = filesRows.length;

    const res = await finalizeHandler({
      request: finalizeRequest({
        stagingKey: stagingKeyA, // A's staging key
        fileName: 'book.epub',
        fileSize: TEST_BYTES.byteLength,
      }),
      params: {},
      context: { user: makeUser(USER_B), tx: makeUserAwareTx(USER_B, filesRows) }, // but caller is B
    });

    expect(res.status, 'foreign stagingKey → 403').toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error, '403 body mentions invalid staging key').toMatch(/invalid staging key/i);

    // No files row was created
    expect(filesRows.length, 'no row created on 403').toBe(rowCountBefore);

    // The staging content should still be intact (not cleaned up by B)
    expect(store.has(stagingKeyA), 'A staging key untouched').toBe(true);
  });
});
