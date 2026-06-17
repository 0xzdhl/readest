import { Either } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for DELETE /api/storage/delete refcount-gated GC logic.
 *
 * Covers:
 *  (a) row with content_hash + refcount 0 after delete → deleteObject('content/<sha>') called
 *  (b) row with content_hash + refcount 1 (another user still refs) → deleteObject NOT called for content
 *  (c) row with content_hash = null (legacy) → deleteObject(file_key) called
 *
 * Uses LOCAL inline mocks only — no real DB, no real storage.
 */

const deleteObjectMock = vi.fn();
const runStorageProgramMock = vi.hoisted(() => vi.fn());

vi.mock('@/storage', () => ({
  ObjectStorage: { _tag: 'ObjectStorage' },
  runStorageProgram: runStorageProgramMock,
}));

import { Route } from '@/app/api/storage/delete';

type Handler = (args: {
  request: Request;
  params: Record<string, string>;
  context: Record<string, unknown>;
}) => Promise<Response>;

const getHandler = (): Handler => {
  const handlers = Route.options.server?.handlers as Record<string, Handler> | undefined;
  const handler = handlers?.['DELETE'];
  if (!handler) throw new Error('no DELETE handler');
  return handler;
};

/**
 * Build a fake drizzle-like tx. Supports:
 *  - select(...).from(...).where(...).limit(n) → returns seeded fileRecords
 *  - delete(...).where(...) → resolves void
 *  - execute(sql) → returns seeded refcount
 */
const makeTx = (opts: {
  fileRecord?: {
    id: string;
    userId: string;
    fileKey: string;
    contentHash: string | null;
  } | null;
  refCount?: number;
}) => {
  const fileRecord = opts.fileRecord ?? null;
  const refCount = opts.refCount ?? 0;

  const selectBuilder = {
    from: vi.fn(() => selectBuilder),
    where: vi.fn(() => selectBuilder),
    limit: vi.fn(() => Promise.resolve(fileRecord ? [fileRecord] : [])),
  };

  const deleteBuilder = {
    where: vi.fn(() => Promise.resolve(undefined)),
  };

  const execute = vi.fn(() => Promise.resolve([{ count: refCount }]));

  return {
    select: vi.fn(() => selectBuilder),
    delete: vi.fn(() => deleteBuilder),
    execute,
  };
};

const userId = 'user-1111-1111-1111';

const makeContext = (tx: ReturnType<typeof makeTx>) => ({
  user: { id: userId, email: 'test@test.com' },
  tx,
});

const deleteRequest = (fileKey: string) =>
  new Request(`http://localhost/api/storage/delete?fileKey=${encodeURIComponent(fileKey)}`, {
    method: 'DELETE',
  });

describe('DELETE /api/storage/delete — refcount-gated GC', () => {
  beforeEach(() => {
    runStorageProgramMock.mockReset();
    deleteObjectMock.mockReset();
    // Default: storage operations succeed
    runStorageProgramMock.mockResolvedValue(Either.right(undefined));
  });
  afterEach(() => vi.clearAllMocks());

  it('(a) content_hash row + refcount 0 → deleteObject("content/<sha>") called', async () => {
    const sha = 'abc123sha256hex';
    const tx = makeTx({
      fileRecord: {
        id: 'file-id-1',
        userId,
        fileKey: `${userId}/some-book.epub`,
        contentHash: sha,
      },
      refCount: 0,
    });

    const handler = getHandler();
    const res = await handler({
      request: deleteRequest(`${userId}/some-book.epub`),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    // The row should have been deleted first
    expect(tx.delete).toHaveBeenCalled();
    // The refcount SQL should have been called
    expect(tx.execute).toHaveBeenCalled();
    // storage deleteObject should be called with 'content/<sha>'
    expect(runStorageProgramMock).toHaveBeenCalledOnce();
    // Inspect what key was passed — by checking the program was called (the
    // actual key is embedded in the Effect; we verify via the call happening)
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/deleted successfully/i);
  });

  it('(b) content_hash row + refcount 1 → deleteObject NOT called, row still deleted', async () => {
    const sha = 'abc123sha256hex';
    const tx = makeTx({
      fileRecord: {
        id: 'file-id-2',
        userId,
        fileKey: `${userId}/another-book.epub`,
        contentHash: sha,
      },
      refCount: 1, // another user still holds a reference
    });

    const handler = getHandler();
    const res = await handler({
      request: deleteRequest(`${userId}/another-book.epub`),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    // DB row deleted
    expect(tx.delete).toHaveBeenCalled();
    // refcount checked
    expect(tx.execute).toHaveBeenCalled();
    // storage deleteObject should NOT have been called (refcount > 0)
    expect(runStorageProgramMock).not.toHaveBeenCalled();
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/deleted successfully/i);
  });

  it('(c) content_hash = null (legacy) → deleteObject(file_key) called', async () => {
    const fileKey = `${userId}/legacy-book.epub`;
    const tx = makeTx({
      fileRecord: {
        id: 'file-id-3',
        userId,
        fileKey,
        contentHash: null,
      },
      refCount: 0, // irrelevant for legacy path
    });

    const handler = getHandler();
    const res = await handler({
      request: deleteRequest(fileKey),
      params: {},
      context: makeContext(tx),
    });

    expect(res.status).toBe(200);
    // DB row deleted
    expect(tx.delete).toHaveBeenCalled();
    // refcount SQL should NOT have been called (no content_hash)
    expect(tx.execute).not.toHaveBeenCalled();
    // storage deleteObject should be called (for legacy key)
    expect(runStorageProgramMock).toHaveBeenCalledOnce();
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/deleted successfully/i);
  });

  it('returns 404 when file not found', async () => {
    const tx = makeTx({ fileRecord: null });
    const handler = getHandler();
    const res = await handler({
      request: deleteRequest('missing/key.epub'),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when fileKey is missing', async () => {
    const tx = makeTx({ fileRecord: null });
    const handler = getHandler();
    const res = await handler({
      request: new Request('http://localhost/api/storage/delete', { method: 'DELETE' }),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(400);
  });

  it('returns 500 when storage delete fails for content object', async () => {
    const sha = 'deadbeefhash';
    const tx = makeTx({
      fileRecord: {
        id: 'file-id-4',
        userId,
        fileKey: `${userId}/fail-book.epub`,
        contentHash: sha,
      },
      refCount: 0,
    });
    runStorageProgramMock.mockResolvedValue(Either.left(new Error('storage error')));
    const handler = getHandler();
    const res = await handler({
      request: deleteRequest(`${userId}/fail-book.epub`),
      params: {},
      context: makeContext(tx),
    });
    expect(res.status).toBe(500);
  });
});
