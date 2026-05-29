import { Effect, Either } from 'effect';
import { describe, expect, it, vi } from 'vitest';

/**
 * `runStorageProgram` surfaces typed failures as `Either.left` values instead of
 * rejecting, so callers can discriminate on `_tag` without `try/catch`. Config
 * failures are folded into the same channel by `StorageConfigLive`.
 *
 * Programs here are `Effect.succeed` / `Effect.fail` so no network is hit; only
 * the run-time + layer-build behaviour of `runStorageProgram` is exercised.
 */

const VALID_S3_ENV = {
  OBJECT_STORAGE_TYPE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_REGION: 'us-east-1',
  S3_BUCKET_NAME: 'bucket-s3',
  S3_ACCESS_KEY_ID: 'key-s3',
  S3_SECRET_ACCESS_KEY: 'secret-s3',
  TEMP_STORAGE_PUBLIC_BUCKET_NAME: 'temp-bucket',
};

const loadRun = async (envOverrides: Record<string, string>) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(envOverrides)) {
    process.env[key] = value;
  }
  const run = await import('@/storage/run');
  const errors = await import('@/storage/errors');
  return { ...run, ...errors };
};

describe('runStorageProgram', () => {
  it('returns Either.right with the success value', async () => {
    const { runStorageProgram } = await loadRun(VALID_S3_ENV);
    const result = await runStorageProgram(Effect.succeed('signed-url'));
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right).toBe('signed-url');
    }
  });

  it('returns Either.left tagged with the typed failure (no rejection)', async () => {
    const { runStorageProgram, StorageSignError } = await loadRun(VALID_S3_ENV);
    const result = await runStorageProgram(Effect.fail(new StorageSignError('boom')));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('StorageSignError');
      expect(result.left.message).toBe('boom');
    }
  });

  it('surfaces a misconfiguration as Either.left(StorageConfigError)', async () => {
    const { runStorageProgram } = await loadRun({
      OBJECT_STORAGE_TYPE: 's3',
      S3_ENDPOINT: '',
      S3_BUCKET_NAME: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
    });
    const result = await runStorageProgram(Effect.succeed('never-reached'));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('StorageConfigError');
    }
  });
});
