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
