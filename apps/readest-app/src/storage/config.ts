import { Context, Layer } from 'effect';
import { clientEnv } from '@/clientEnv';
import { env } from '@/env';
import { StorageConfigError } from './errors';

export interface StorageConfigShape {
  readonly endpoint: string;
  readonly region: string;
  readonly bucketName: string;
  readonly tempBucketName: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export class StorageConfig extends Context.Tag('StorageConfig')<
  StorageConfig,
  StorageConfigShape
>() {}

export const makeStorageConfig = (): StorageConfigShape => {
  if (clientEnv.VITE_OBJECT_STORAGE_TYPE === 'r2') {
    if (
      !env.R2_ACCOUNT_ID ||
      !env.R2_BUCKET_NAME ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY
    ) {
      throw new StorageConfigError('Missing required R2 storage configuration');
    }
    return {
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      region: env.R2_REGION,
      bucketName: env.R2_BUCKET_NAME,
      tempBucketName: env.TEMP_STORAGE_PUBLIC_BUCKET_NAME,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    };
  }

  if (
    !env.S3_ENDPOINT ||
    !env.S3_BUCKET_NAME ||
    !env.S3_ACCESS_KEY_ID ||
    !env.S3_SECRET_ACCESS_KEY
  ) {
    throw new StorageConfigError('Missing required S3 storage configuration');
  }

  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucketName: env.S3_BUCKET_NAME,
    tempBucketName: env.TEMP_STORAGE_PUBLIC_BUCKET_NAME,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
};

export const StorageConfigLive = Layer.sync(StorageConfig, makeStorageConfig);
