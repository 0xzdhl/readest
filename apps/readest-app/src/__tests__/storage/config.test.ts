import { describe, expect, it, vi } from 'vitest';

const loadConfig = async (envOverrides: Record<string, string>) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(envOverrides)) {
    process.env[key] = value;
  }
  const errors = await import('@/storage/errors');
  const config = await import('@/storage/config');
  return { ...errors, ...config };
};

describe('makeStorageConfig', () => {
  it('builds S3 config from env', async () => {
    const { makeStorageConfig } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 's3',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_REGION: 'us-east-1',
      S3_BUCKET_NAME: 'bucket-s3',
      S3_ACCESS_KEY_ID: 'key-s3',
      S3_SECRET_ACCESS_KEY: 'secret-s3',
      TEMP_STORAGE_PUBLIC_BUCKET_NAME: 'temp-bucket',
    });
    const cfg = makeStorageConfig();
    expect(cfg.endpoint).toBe('https://s3.example.com');
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.bucketName).toBe('bucket-s3');
    expect(cfg.tempBucketName).toBe('temp-bucket');
    expect(cfg.accessKeyId).toBe('key-s3');
    expect(cfg.secretAccessKey).toBe('secret-s3');
  });

  it('builds R2 config from env (endpoint uses account id)', async () => {
    const { makeStorageConfig } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 'r2',
      R2_ACCOUNT_ID: 'acct123',
      R2_REGION: 'auto',
      R2_BUCKET_NAME: 'bucket-r2',
      R2_ACCESS_KEY_ID: 'key-r2',
      R2_SECRET_ACCESS_KEY: 'secret-r2',
      TEMP_STORAGE_PUBLIC_BUCKET_NAME: 'temp-r2',
    });
    const cfg = makeStorageConfig();
    expect(cfg.endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(cfg.region).toBe('auto');
    expect(cfg.bucketName).toBe('bucket-r2');
    expect(cfg.tempBucketName).toBe('temp-r2');
    expect(cfg.accessKeyId).toBe('key-r2');
    expect(cfg.secretAccessKey).toBe('secret-r2');
  });

  it('throws StorageConfigError when S3 endpoint missing', async () => {
    const { makeStorageConfig, StorageConfigError } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 's3',
      S3_ENDPOINT: '',
      S3_REGION: 'us-east-1',
      S3_BUCKET_NAME: 'bucket-s3',
      S3_ACCESS_KEY_ID: 'key-s3',
      S3_SECRET_ACCESS_KEY: 'secret-s3',
    });
    expect(() => makeStorageConfig()).toThrow(StorageConfigError);
  });

  it('throws StorageConfigError when R2 account id missing', async () => {
    const { makeStorageConfig, StorageConfigError } = await loadConfig({
      VITE_OBJECT_STORAGE_TYPE: 'r2',
      R2_ACCOUNT_ID: '',
      R2_BUCKET_NAME: 'bucket-r2',
      R2_ACCESS_KEY_ID: 'key-r2',
      R2_SECRET_ACCESS_KEY: 'secret-r2',
    });
    expect(() => makeStorageConfig()).toThrow(StorageConfigError);
  });
});
