import { describe, expect, it, vi } from 'vitest';

/**
 * TDD: download route signs `content/<contentHash>` when content_hash is set,
 * and falls back to `file_key` when content_hash is null.
 */

// We only mock runStorageProgram; ObjectStorage (the Context.Tag class) comes
// from the real @/storage/service so the Effect.gen provider works correctly.
const runStorageProgramMock = vi.hoisted(() => vi.fn());

vi.mock('@/storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/storage')>();
  return {
    ...real,
    runStorageProgram: runStorageProgramMock,
  };
});

import { Either, Effect, Layer } from 'effect';
import { ObjectStorage } from '@/storage';
import { Route } from '@/app/api/storage/download';

type Handler = (args: {
  request: Request;
  params: Record<string, string>;
  context: Record<string, unknown>;
}) => Promise<Response>;

const getHandler = (): Handler => {
  const handlers = Route.options.server?.handlers as Record<string, Handler> | undefined;
  const handler = handlers?.['GET'];
  if (!handler) throw new Error('no GET handler');
  return handler;
};

interface FakeFileRow {
  userId: string;
  fileKey: string;
  bookHash: string | null;
  contentHash: string | null;
}

const makeTx = (rows: FakeFileRow[]) => {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => ({
      // biome-ignore lint/suspicious/noThenProperty: mimics drizzle query builder
      then: (resolve: (v: FakeFileRow[]) => unknown, _reject?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve),
    })),
  };
  const select = vi.fn(() => builder);
  return { select };
};

/**
 * Build a runStorageProgram mock that executes the passed Effect with a real
 * ObjectStorage service layer, capturing the key passed to getDownloadSignedUrl.
 */
const makeStorageMock = (capturedKey: string[]) =>
  vi.fn(async (prog: Effect.Effect<string, never, ObjectStorage>) => {
    const mockStorage = ObjectStorage.of({
      getDownloadSignedUrl: (key: string, _expiresIn: number, _bucket?: string) => {
        capturedKey.push(key);
        return Effect.succeed(`https://cdn.example.com/${key}`) as Effect.Effect<
          string,
          never,
          never
        >;
      },
      getUploadSignedUrl: (_key: string, _size: number, _exp: number, _bucket?: string) =>
        Effect.succeed('') as Effect.Effect<string, never, never>,
      deleteObject: (_key: string, _bucket?: string) =>
        Effect.void as Effect.Effect<void, never, never>,
      headObject: (_key: string, _bucket?: string) =>
        Effect.void as Effect.Effect<void, never, never>,
      copyObject: (_src: string, _dst: string, _bucket?: string, _srcBucket?: string) =>
        Effect.void as Effect.Effect<void, never, never>,
      getObjectBytes: (_key: string, _bucket?: string) =>
        Effect.succeed(new ArrayBuffer(0)) as Effect.Effect<ArrayBuffer, never, never>,
    });
    const layer = Layer.succeed(ObjectStorage, mockStorage);
    const result = await Effect.runPromise(
      Effect.provide(prog, layer) as Effect.Effect<string, never, never>,
    );
    return Either.right(result);
  });

const userId = 'user-1';
const fileKey = 'Readest/Book/user-1/abc123/book.epub';

describe('download route: content object signing', () => {
  it('signs content/<contentHash> when row has content_hash', async () => {
    const contentHash = 'deadbeef';
    const capturedKey: string[] = [];
    runStorageProgramMock.mockImplementation(makeStorageMock(capturedKey));

    const { select } = makeTx([{ userId, fileKey, bookHash: 'abc123', contentHash }]);
    const handler = getHandler();
    const request = new Request(
      `http://localhost/api/storage/download?fileKey=${encodeURIComponent(fileKey)}`,
    );

    const response = await handler({
      request,
      params: {},
      context: { user: { id: userId }, tx: { select } },
    });

    expect(response.status).toBe(200);
    expect(capturedKey).toHaveLength(1);
    expect(capturedKey[0]).toBe(`content/${contentHash}`);
    expect(capturedKey[0]).not.toBe(fileKey);
  });

  it('signs file_key when content_hash is null (legacy path)', async () => {
    const capturedKey: string[] = [];
    runStorageProgramMock.mockImplementation(makeStorageMock(capturedKey));

    const { select } = makeTx([{ userId, fileKey, bookHash: 'abc123', contentHash: null }]);
    const handler = getHandler();
    const request = new Request(
      `http://localhost/api/storage/download?fileKey=${encodeURIComponent(fileKey)}`,
    );

    const response = await handler({
      request,
      params: {},
      context: { user: { id: userId }, tx: { select } },
    });

    expect(response.status).toBe(200);
    expect(capturedKey).toHaveLength(1);
    expect(capturedKey[0]).toBe(fileKey);
  });
});
