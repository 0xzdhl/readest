import { Effect, Exit, Cause, Layer, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('aws4fetch', () => ({
  AwsClient: vi.fn(function AwsClientMock() {
    return { sign: vi.fn(), fetch: fetchMock };
  }),
}));

// Imports after mock hoisting.
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
  fetchMock.mockReset();
});

describe('ObjectStorage.getObjectBytes', () => {
  it('returns the ArrayBuffer on a 200 response', async () => {
    const knownBytes = new Uint8Array([1, 2, 3, 4, 5]);
    fetchMock.mockResolvedValueOnce(new Response(knownBytes.buffer, { status: 200 }));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        return yield* storage.getObjectBytes('user-123/book.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result)).toEqual(knownBytes);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9000/books/user-123/book.epub', {
      method: 'GET',
    });
  });

  it('uses the provided bucketName override', async () => {
    const knownBytes = new Uint8Array([9, 8, 7]);
    fetchMock.mockResolvedValueOnce(new Response(knownBytes.buffer, { status: 200 }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        return yield* storage.getObjectBytes('key.epub', 'other-bucket');
      }).pipe(Effect.provide(TestStorageLayer)),
    );

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9000/other-bucket/key.epub', {
      method: 'GET',
    });
  });

  it('fails with StorageNotFoundError on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.getObjectBytes('missing.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );

    expect(extractFailure(exit)).toBeInstanceOf(StorageNotFoundError);
  });

  it('fails with StorageRequestError(status) on 500', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.getObjectBytes('boom.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );

    const failure = extractFailure(exit);
    expect(failure).toBeInstanceOf(StorageRequestError);
    expect((failure as StorageRequestError).status).toBe(500);
  });

  it('wraps unexpected thrown errors as StorageRequestError', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* ObjectStorage;
        yield* storage.getObjectBytes('file.epub');
      }).pipe(Effect.provide(TestStorageLayer)),
    );

    const failure = extractFailure(exit);
    expect(failure).toBeInstanceOf(StorageRequestError);
    expect((failure as StorageRequestError).message).toContain('network error');
  });
});
