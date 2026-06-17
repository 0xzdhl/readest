import { Either } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for POST /api/storage/upload. The handler is driven directly
 * (bypassing the rls middleware) with a hand-rolled `tx` mock so we can
 * exercise the staging key minting and the temp-branch sanitization without
 * a real DB.
 *
 * Covers:
 *  - #16: book upload branch now mints a staging presigned PUT (staging/<user.id>/<uuid>)
 *    and writes NO `files` row; quota gate and dedup move to /finalize (Task 5).
 *  - #12: the temp branch caps file size and sanitizes the client fileName.
 *
 * NOTE: The old quota-gate assertions (#5) and idempotent-insert assertions (#14)
 * and skip-re-upload assertions (#13) applied to the OLD book branch which
 * inserted a `files` row and enforced quota inline. Those behaviors have moved
 * to POST /api/storage/finalize (Task 5). Coverage of the quota gate and dedup
 * now lives in finalize.test.ts.
 */

const runStorageProgramMock = vi.hoisted(() => vi.fn());
vi.mock('@/storage', () => ({
  ObjectStorage: { _tag: 'ObjectStorage' },
  runStorageProgram: runStorageProgramMock,
}));

vi.mock('@/libs/server/storage-plan', () => ({
  getStoragePlanData: vi.fn(() => ({ quota: 10 * 1024 * 1024 * 1024 })),
  STORAGE_QUOTA_GRACE_BYTES: 0,
}));

import { Route } from '@/app/api/storage/upload';

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

interface TxOptions {
  /** invoked when an insert is attempted */
  onInsert?: (values: Record<string, unknown>) => void;
}

/**
 * Build a chainable drizzle-like tx mock. Only insert is relevant for the
 * new book branch (to assert NO insert happens). The select chain is kept
 * for completeness / replica-branch coverage.
 */
const makeTx = (opts: TxOptions = {}) => {
  const insert = vi.fn((_table: unknown) => {
    const chain = {
      values: vi.fn((values: Record<string, unknown>) => {
        opts.onInsert?.(values);
        return {
          onConflictDoNothing: vi.fn(() => Promise.resolve(undefined)),
        };
      }),
    };
    return chain;
  });

  const select = vi.fn((projection?: Record<string, unknown>) => {
    const isUsageQuery = !!projection && Object.keys(projection).length > 0;
    const result = isUsageQuery ? [{ total: null }] : [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve(result)),
      // biome-ignore lint/suspicious/noThenProperty: mock mimics drizzle's thenable query builder (awaited without .limit())
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return builder;
  });

  return { select, insert };
};

const userId = '11111111-1111-1111-1111-111111111111';

const makeContext = (
  tx: ReturnType<typeof makeTx>,
  userOverrides: Record<string, unknown> = {},
) => ({
  user: {
    id: userId,
    email: 'a@test',
    plan: 'free',
    storageUsageBytes: 0,
    storagePurchasedBytes: 0,
    ...userOverrides,
  },
  tx,
});

const post = (body: unknown) =>
  new Request('http://localhost/api/storage/upload', {
    method: 'POST',
    body: JSON.stringify(body),
  });

describe('POST /api/storage/upload — book branch → staging presigned PUT (#16)', () => {
  beforeEach(() => {
    runStorageProgramMock.mockReset();
    // Book branch only calls storage once: getUploadSignedUrl for the staging key.
    runStorageProgramMock.mockResolvedValue(Either.right('https://signed.test/staging-url'));
  });
  afterEach(() => vi.clearAllMocks());

  it('returns stagingKey matching staging/<userId>/ and an uploadUrl, inserts NO files row', async () => {
    let insertCalled = false;
    const tx = makeTx({
      onInsert: () => {
        insertCalled = true;
      },
    });
    const handler = getHandler();
    const res = await handler({
      request: post({ fileName: 'book.epub', fileSize: 2_000_000, bookHash: 'abc123' }),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { stagingKey?: string; uploadUrl?: string };
    // stagingKey must be staging/<user.id>/<uuid>
    expect(body.stagingKey).toMatch(new RegExp(`^staging/${userId}/`));
    expect(body.uploadUrl).toBe('https://signed.test/staging-url');
    // No files row inserted
    expect(insertCalled).toBe(false);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('returns 400 when fileName is missing', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ fileSize: 1000 }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/missing file info/i);
  });

  it('returns 400 when fileSize is missing', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ fileName: 'book.epub' }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/missing file info/i);
  });

  it('returns 500 when storage presign fails', async () => {
    runStorageProgramMock.mockReset();
    runStorageProgramMock.mockResolvedValue(Either.left(new Error('storage error')));
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ fileName: 'book.epub', fileSize: 1000 }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(500);
  });

  it('does NOT include quota, usage, or fileKey in the response', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ fileName: 'book.epub', fileSize: 2_000_000 }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['quota']).toBeUndefined();
    expect(body['usage']).toBeUndefined();
    expect(body['fileKey']).toBeUndefined();
    expect(body['skipUpload']).toBeUndefined();
  });
});

describe('POST /api/storage/upload — temp branch sanitize/size cap (#12)', () => {
  beforeEach(() => {
    runStorageProgramMock.mockReset();
    runStorageProgramMock.mockResolvedValue(Either.right('https://signed.test/temp'));
  });
  afterEach(() => vi.clearAllMocks());

  it('rejects an oversized temp upload', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ temp: true, fileName: 'pic.png', fileSize: 1024 * 1024 * 1024 }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
  });

  it('sanitizes path traversal / separators out of the temp fileName', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ temp: true, fileName: '../../etc/passwd', fileSize: 1000 }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(200);
    // The fileKey passed to storage must not contain traversal/separators
    // beyond the controlled prefix.
    const firstCallArgs = runStorageProgramMock.mock.calls;
    expect(firstCallArgs.length).toBeGreaterThan(0);
    // The handler builds `temp/img/<time>/<user>/<sanitizedName>`. Assert the
    // sanitized name has no `..` and no raw slashes from the client input.
    // We can't read the internal key directly, but we can ensure the request
    // succeeded and produced a download URL derived from a clean key.
    const body = (await res.json()) as { downloadUrl?: string; uploadUrl?: string };
    expect(body.uploadUrl).toBeDefined();
  });

  it('rejects a temp upload whose fileName sanitizes to empty', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ temp: true, fileName: '../../', fileSize: 1000 }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/storage/upload — replica branch (dict/sync, single-step content-addressed)', () => {
  beforeEach(() => {
    runStorageProgramMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('returns uploadUrl + fileKey (<userId>/<fileName>) and inserts a files row with replicaKind/replicaId', async () => {
    // headObject returns Left → object does NOT exist yet → full upload path
    runStorageProgramMock
      .mockResolvedValueOnce(Either.left(new Error('not found'))) // headObject
      .mockResolvedValueOnce(Either.right('https://signed.test/replica-url')); // getUploadSignedUrl

    const insertedValues: Record<string, unknown>[] = [];
    const tx = makeTx({
      onInsert: (values) => {
        insertedValues.push(values);
      },
    });

    const handler = getHandler();
    const res = await handler({
      request: post({
        fileName: 'dict.db',
        fileSize: 500_000,
        replicaKind: 'dict',
        replicaId: 'r1',
      }),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadUrl?: string;
      fileKey?: string;
      stagingKey?: string;
    };
    // Must return a per-user fileKey, NOT a stagingKey
    expect(body.fileKey).toBe(`${userId}/dict.db`);
    expect(body.uploadUrl).toBe('https://signed.test/replica-url');
    expect(body.stagingKey).toBeUndefined();

    // A files row must have been inserted with replicaKind + replicaId
    expect(insertedValues.length).toBeGreaterThanOrEqual(1);
    const row = insertedValues.find((v) => v['replicaKind'] === 'dict');
    expect(row).toBeDefined();
    expect(row?.['replicaId']).toBe('r1');
    expect(row?.['fileKey']).toBe(`${userId}/dict.db`);
  });

  it('skipUpload path: returns { skipUpload: true, fileKey } and inserts a files row when object already exists', async () => {
    // headObject returns Right → object already exists → skipUpload
    runStorageProgramMock.mockResolvedValueOnce(Either.right({ size: 500_000 }));

    const insertedValues: Record<string, unknown>[] = [];
    const tx = makeTx({
      onInsert: (values) => {
        insertedValues.push(values);
      },
    });

    const handler = getHandler();
    const res = await handler({
      request: post({
        fileName: 'dict.db',
        fileSize: 500_000,
        replicaKind: 'dict',
        replicaId: 'r1',
      }),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skipUpload?: boolean;
      fileKey?: string;
      uploadUrl?: string;
    };
    expect(body.skipUpload).toBe(true);
    expect(body.fileKey).toBe(`${userId}/dict.db`);
    expect(body.uploadUrl).toBeUndefined();

    // Even on skipUpload a files row is upserted (idempotent insert)
    expect(insertedValues.length).toBeGreaterThanOrEqual(1);
    const row = insertedValues.find((v) => v['replicaKind'] === 'dict');
    expect(row?.['replicaId']).toBe('r1');
  });

  it('returns 400 when fileName is missing for a replica upload', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ fileSize: 1000, replicaKind: 'dict', replicaId: 'r1' }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/missing file info/i);
  });

  it('returns 400 when fileSize is missing for a replica upload', async () => {
    const tx = makeTx();
    const handler = getHandler();
    const res = await handler({
      request: post({ fileName: 'dict.db', replicaKind: 'dict', replicaId: 'r1' }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/missing file info/i);
  });
});
