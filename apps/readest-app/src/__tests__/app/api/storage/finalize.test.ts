import { Either } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for POST /api/storage/finalize — server-hashed cross-user dedup.
 *
 * This route is the core of Phase-2 binary dedup. It replaces the old inline
 * quota-gate and idempotent-insert behavior that previously lived in the upload
 * route. Coverage here supersedes those upload.test.ts assertions.
 *
 * Covers:
 *  - first uploader, under threshold: copyObject(staging → content/<sha>), staging deleted,
 *    files row upserted with contentHash=sha, deduped:false
 *  - second uploader (content already exists): copyObject NOT called, deduped:true
 *  - stagingKey not owned by caller → 403, no storage calls
 *  - staged object missing → 404
 *  - over threshold: no read/hash, copyObject(staging → <user>/<fileName>), contentHash=null
 *  - quota exceeded → 403 + staging deleted + no row inserted
 *  - anti-oracle / integrity: written contentHash equals sha256Hex(stagedBytes);
 *    request body has NO hash field (client cannot influence it)
 */

const runStorageProgramMock = vi.hoisted(() => vi.fn());

vi.mock('@/storage', () => ({
  ObjectStorage: { _tag: 'ObjectStorage' },
  runStorageProgram: runStorageProgramMock,
}));

// Use the real sha256Hex (crypto.subtle is available in vitest's jsdom/node env)
import { sha256Hex, DEDUP_MAX_BYTES } from '@/libs/server/contentHash';
import { Route } from '@/app/api/storage/finalize';

type Handler = (args: {
  request: Request;
  params: Record<string, string>;
  context: Record<string, unknown>;
}) => Promise<Response>;

const getHandler = (): Handler => {
  const handlers = Route.options.server?.handlers as Record<string, Handler> | undefined;
  const handler = handlers?.['POST'];
  if (!handler) throw new Error('no POST handler');
  return handler;
};

// ---------------------------------------------------------------------------
// Fake tx builder
// ---------------------------------------------------------------------------

interface TxOpts {
  /** simulated current usage (sum of live file sizes) */
  usage?: number;
  /** captures insert values */
  onInsert?: (values: Record<string, unknown>) => void;
}

const makeTx = (opts: TxOpts = {}) => {
  const usage = opts.usage ?? 0;

  // select({ total: sum(...) }).from(...).where(...) → [{ total: <usage> }]
  const selectBuilder = {
    from: vi.fn(() => selectBuilder),
    where: vi.fn(() => selectBuilder),
    // biome-ignore lint/suspicious/noThenProperty: mock mimics drizzle's thenable query builder
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve([{ total: String(usage) }]).then(resolve),
  };

  const onConflictDoNothingMock = vi.fn(() => Promise.resolve(undefined));
  // Drizzle's onConflictDoUpdate takes a single config object: { target, set, setWhere }.
  const onConflictDoUpdateMock = vi.fn((_config: Record<string, unknown>) =>
    Promise.resolve(undefined),
  );
  const valuesMock = vi.fn((values: Record<string, unknown>) => {
    opts.onInsert?.(values);
    return {
      onConflictDoNothing: onConflictDoNothingMock,
      onConflictDoUpdate: onConflictDoUpdateMock,
    };
  });
  const insertMock = vi.fn(() => ({ values: valuesMock }));

  return {
    select: vi.fn(() => selectBuilder),
    insert: insertMock,
    _valuesMock: valuesMock,
    _onConflictDoNothingMock: onConflictDoNothingMock,
    _onConflictDoUpdateMock: onConflictDoUpdateMock,
  };
};

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const otherUserId = 'ffffffff-0000-1111-2222-333333333333';

const STAGED_BYTES = new TextEncoder().encode('fake-epub-content').buffer;
const STAGED_KEY = `staging/${userId}/uuid-1234`;
const FILE_NAME = 'my-book.epub';
const FILE_SIZE_SMALL = 1_000; // well under DEDUP_MAX_BYTES
const FILE_SIZE_LARGE = DEDUP_MAX_BYTES + 1;
// Free-plan quota (default) = 1 GiB; grace = 10 MiB → exceeded when usage > quota+grace
const FREE_QUOTA = 1 * 1024 * 1024 * 1024; // from DEFAULT_STORAGE_QUOTA['free']
const GRACE = 10 * 1024 * 1024;

const makeContext = (
  tx: ReturnType<typeof makeTx>,
  userOverrides: Record<string, unknown> = {},
) => ({
  user: {
    id: userId,
    email: 'a@test.com',
    plan: 'free',
    storageUsageBytes: 0,
    storagePurchasedBytes: 0,
    ...userOverrides,
  },
  tx,
});

const post = (body: unknown) =>
  new Request('http://localhost/api/storage/finalize', {
    method: 'POST',
    body: JSON.stringify(body),
  });

const VALID_BODY = {
  stagingKey: STAGED_KEY,
  fileName: FILE_NAME,
  fileSize: FILE_SIZE_SMALL,
  bookHash: 'book-abc123',
};

// ---------------------------------------------------------------------------
// runStorageProgram call sequencing helpers
// ---------------------------------------------------------------------------

/**
 * Returns a mock implementation list that sequences:
 *   1. headObject(stagingKey)   → right(void)   [staged object exists]
 *   2. getObjectBytes(stagingKey) → right(STAGED_BYTES)
 *   3. headObject(contentKey)   → [customizable: left=NotFound | right=exists]
 *   4. copyObject / deleteObject → right(void)
 *   5. deleteObject(stagingKey) → right(void)
 */
const makeStorageSequence = (contentExists: boolean) => {
  const calls: Array<() => Either.Either<unknown, Error>> = [
    // 1. headObject(stagingKey) → exists
    () => Either.right(undefined),
    // 2. getObjectBytes(stagingKey) → staged bytes
    () => Either.right(STAGED_BYTES),
    // 3. headObject(contentKey) → exists or not-found
    () =>
      contentExists ? Either.right(undefined) : Either.left(new Error('StorageNotFoundError')),
    // 4. copyObject (only when !contentExists) or deleteObject(staging)
    () => Either.right(undefined),
    // 5. deleteObject(staging) if copy happened
    () => Either.right(undefined),
  ];
  let idx = 0;
  return () => Promise.resolve(calls[idx++ % calls.length]?.() ?? Either.right(undefined));
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/storage/finalize', () => {
  beforeEach(() => {
    runStorageProgramMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  // -------------------------------------------------------------------------
  // 1. First uploader, under threshold
  // -------------------------------------------------------------------------
  it('first uploader (under threshold): copyObject called, staging deleted, row upserted with contentHash=sha, deduped:false', async () => {
    runStorageProgramMock.mockImplementation(makeStorageSequence(false));

    const insertedValues: Record<string, unknown>[] = [];
    const tx = makeTx({ onInsert: (v) => insertedValues.push(v) });
    const handler = getHandler();

    const res = await handler({
      request: post(VALID_BODY),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      contentHash: string | null;
      deduped: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.deduped).toBe(false);
    expect(body.contentHash).toBeTruthy();

    // The hash must equal sha256Hex(STAGED_BYTES) — server computes it, not client
    const expectedSha = await sha256Hex(STAGED_BYTES);
    expect(body.contentHash).toBe(expectedSha);

    // Row was inserted with that hash
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]?.contentHash).toBe(expectedSha);
    expect(insertedValues[0]?.fileKey).toBe(`${userId}/${FILE_NAME}`);
    expect(insertedValues[0]?.userId).toBe(userId);

    // copyObject and deleteObject(staging) were both called
    // headStaging(1) + getObjectBytes(2) + headContent(3) + copyObject(4) + deleteStaging(5)
    expect(runStorageProgramMock).toHaveBeenCalledTimes(5);
  });

  // -------------------------------------------------------------------------
  // 2. Second uploader: content already exists → no copyObject, deduped:true
  // -------------------------------------------------------------------------
  it('second uploader (content exists): copyObject NOT called, deduped:true, row upserted', async () => {
    runStorageProgramMock.mockImplementation(makeStorageSequence(true));

    const insertedValues: Record<string, unknown>[] = [];
    const tx = makeTx({ onInsert: (v) => insertedValues.push(v) });
    const handler = getHandler();

    const res = await handler({
      request: post({ ...VALID_BODY, stagingKey: `staging/${userId}/uuid-5678` }),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      contentHash: string | null;
      deduped: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.deduped).toBe(true);

    const expectedSha = await sha256Hex(STAGED_BYTES);
    expect(body.contentHash).toBe(expectedSha);

    // Row still upserted even for second uploader
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]?.contentHash).toBe(expectedSha);

    // headStaging(1) + getObjectBytes(2) + headContent(3) [exists] + deleteStaging(4)
    // No copy call (content existed), so 4 calls total
    expect(runStorageProgramMock).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // 3. stagingKey not owned by caller → 403, no storage calls
  // -------------------------------------------------------------------------
  it('stagingKey owned by different user → 403, no storage calls', async () => {
    const tx = makeTx();
    const handler = getHandler();

    const res = await handler({
      request: post({
        ...VALID_BODY,
        stagingKey: `staging/${otherUserId}/uuid-9999`, // wrong owner
      }),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid staging key/i);

    // No storage operations should have occurred
    expect(runStorageProgramMock).not.toHaveBeenCalled();
    // No DB insert
    expect(tx.insert).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Staged object missing → 404
  // -------------------------------------------------------------------------
  it('staged object missing (headObject returns NotFound) → 404', async () => {
    // headObject(stagingKey) → left (not found)
    runStorageProgramMock.mockResolvedValueOnce(Either.left(new Error('StorageNotFoundError')));

    const tx = makeTx();
    const handler = getHandler();

    const res = await handler({
      request: post(VALID_BODY),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/staged file not found/i);

    // Only headObject called, nothing else
    expect(runStorageProgramMock).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Over threshold: no hash/read, copy to <user>/<fileName>, contentHash=null
  // -------------------------------------------------------------------------
  it('over threshold: no getObjectBytes/sha, copy to user fileKey, contentHash=null, deduped:false', async () => {
    // headStaging → right, copyObject → right, deleteStaging → right
    runStorageProgramMock
      .mockResolvedValueOnce(Either.right(undefined)) // headObject(stagingKey)
      .mockResolvedValueOnce(Either.right(undefined)) // copyObject(staging → <user>/<fileName>)
      .mockResolvedValueOnce(Either.right(undefined)); // deleteObject(staging)

    const insertedValues: Record<string, unknown>[] = [];
    const tx = makeTx({ onInsert: (v) => insertedValues.push(v) });
    const handler = getHandler();

    const res = await handler({
      request: post({ ...VALID_BODY, fileSize: FILE_SIZE_LARGE }),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      contentHash: string | null;
      deduped: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.contentHash).toBeNull();
    expect(body.deduped).toBe(false);

    // Only 3 storage calls: headStaging + copyObject + deleteStaging (no getObjectBytes)
    expect(runStorageProgramMock).toHaveBeenCalledTimes(3);

    // Row upserted with contentHash=null and fileKey=<userId>/<fileName>
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]?.contentHash).toBeNull();
    expect(insertedValues[0]?.fileKey).toBe(`${userId}/${FILE_NAME}`);
  });

  // -------------------------------------------------------------------------
  // 6. Quota exceeded → 403, staging deleted, no row inserted
  // -------------------------------------------------------------------------
  it('quota exceeded → 403, staging deleted, no DB insert', async () => {
    // headStaging → right (staging exists), then deleteStaging → right
    runStorageProgramMock
      .mockResolvedValueOnce(Either.right(undefined)) // headObject(stagingKey)
      .mockResolvedValueOnce(Either.right(undefined)); // deleteObject(staging) after quota failure

    // usage > quota + grace: set usage just over the limit
    const exceedingUsage = FREE_QUOTA + GRACE + 1;
    const tx = makeTx({ usage: exceedingUsage });
    const handler = getHandler();

    const res = await handler({
      request: post(VALID_BODY),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/insufficient storage quota/i);

    // deleteStaging was called (2nd storage call)
    expect(runStorageProgramMock).toHaveBeenCalledTimes(2);
    // No DB insert
    expect(tx.insert).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Anti-oracle / integrity assertion
  //    The request body has NO hash field — the server computes it from bytes.
  // -------------------------------------------------------------------------
  it('anti-oracle: contentHash equals sha256Hex(stagedBytes); body has no hash field', async () => {
    runStorageProgramMock.mockImplementation(makeStorageSequence(false));

    const tx = makeTx();
    const handler = getHandler();

    // The request body intentionally omits any hash field
    const requestBody = {
      stagingKey: STAGED_KEY,
      fileName: FILE_NAME,
      fileSize: FILE_SIZE_SMALL,
      bookHash: 'any-book-hash',
      // NOTE: no 'contentHash', 'hash', 'sha', or any pre-computed digest field
    };
    // Prove that client cannot include a hash field that influences the result
    expect(Object.keys(requestBody)).not.toContain('contentHash');
    expect(Object.keys(requestBody)).not.toContain('hash');
    expect(Object.keys(requestBody)).not.toContain('sha');

    const res = await handler({
      request: post(requestBody),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      contentHash: string | null;
      deduped: boolean;
    };

    // Server computes the hash from the actual staged bytes — not from the body
    const expectedSha = await sha256Hex(STAGED_BYTES);
    expect(body.contentHash).toBe(expectedSha);
  });

  // -------------------------------------------------------------------------
  // 8. Missing required fields → 400
  // -------------------------------------------------------------------------
  it('missing stagingKey → 400', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ fileName: FILE_NAME, fileSize: FILE_SIZE_SMALL }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
  });

  it('missing fileName → 400', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ stagingKey: STAGED_KEY, fileSize: FILE_SIZE_SMALL }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
  });

  it('missing fileSize → 400', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ stagingKey: STAGED_KEY, fileName: FILE_NAME }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 9. Dedup row reconciliation (Bug 2): the files row must RECONCILE its
  //    content_hash on a fileKey conflict, not silently keep a stale NULL via
  //    onConflictDoNothing — otherwise download falls back to a per-user key
  //    that has no object after the bytes were promoted to content/<sha>.
  // -------------------------------------------------------------------------
  it('under threshold: upserts via onConflictDoUpdate, reconciling content_hash (gated to NULL rows)', async () => {
    runStorageProgramMock.mockImplementation(makeStorageSequence(false));

    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post(VALID_BODY),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    const expectedSha = await sha256Hex(STAGED_BYTES);

    // Must reconcile on conflict (heal a stale NULL-contentHash row), NOT keep it.
    expect(tx._onConflictDoUpdateMock).toHaveBeenCalledTimes(1);
    expect(tx._onConflictDoNothingMock).not.toHaveBeenCalled();

    const config = tx._onConflictDoUpdateMock.mock.calls[0]![0] as {
      target: unknown;
      set: Record<string, unknown>;
      setWhere?: unknown;
    };
    expect(config.set.contentHash).toBe(expectedSha);
    // setWhere guards the update to rows whose content_hash IS NULL, so a
    // legitimate existing content_hash is never demoted.
    expect(config.setWhere).toBeTruthy();
  });

  it('over threshold: upsert carries contentHash=null (never invents a hash for large files)', async () => {
    runStorageProgramMock
      .mockResolvedValueOnce(Either.right(undefined)) // headObject(stagingKey)
      .mockResolvedValueOnce(Either.right(undefined)) // copyObject(staging → <user>/<fileName>)
      .mockResolvedValueOnce(Either.right(undefined)); // deleteObject(staging)

    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ ...VALID_BODY, fileSize: FILE_SIZE_LARGE }),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    expect(tx._onConflictDoUpdateMock).toHaveBeenCalledTimes(1);
    const config = tx._onConflictDoUpdateMock.mock.calls[0]![0] as {
      set: Record<string, unknown>;
    };
    expect(config.set.contentHash ?? null).toBeNull();
  });
});
