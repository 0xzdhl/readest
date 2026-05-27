import { AwsClient } from 'aws4fetch';
import { Effect, Layer } from 'effect';
import { StorageConfig } from './config';
import { StorageNotFoundError, StorageRequestError, StorageSignError } from './errors';
import { ObjectStorage } from './service';

const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

export const S3CompatibleStorageLive = Layer.effect(
  ObjectStorage,
  Effect.gen(function* () {
    const config = yield* StorageConfig;

    const client = new AwsClient({
      service: 's3',
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });

    const objectUrl = (bucket: string, key: string): string =>
      `${trimSlash(config.endpoint)}/${bucket}/${encodeKey(key)}`;

    return ObjectStorage.of({
      getUploadSignedUrl: (fileKey, contentLength, expiresIn, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const url = new URL(objectUrl(bucketName ?? config.bucketName, fileKey));
            url.searchParams.set('X-Amz-Expires', expiresIn.toString());
            const signed = await client.sign(
              new Request(url, {
                method: 'PUT',
                headers: { 'Content-Length': contentLength.toString() },
              }),
              { aws: { signQuery: true, allHeaders: true } },
            );
            return signed.url;
          },
          catch: (e) => new StorageSignError(String(e)),
        }),

      getDownloadSignedUrl: (fileKey, expiresIn, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const url = new URL(objectUrl(bucketName ?? config.bucketName, fileKey));
            url.searchParams.set('X-Amz-Expires', expiresIn.toString());
            const signed = await client.sign(new Request(url), {
              aws: { signQuery: true },
            });
            return signed.url;
          },
          catch: (e) => new StorageSignError(String(e)),
        }),

      deleteObject: (fileKey, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const r = await client.fetch(objectUrl(bucketName ?? config.bucketName, fileKey), {
              method: 'DELETE',
            });
            if (r.status === 404) {
              throw new StorageNotFoundError(`Not found: ${fileKey}`);
            }
            if (!r.ok) {
              throw new StorageRequestError(`Delete failed: ${r.status}`, r.status);
            }
          },
          catch: (e) => {
            if (e instanceof StorageNotFoundError) return e;
            if (e instanceof StorageRequestError) return e;
            return new StorageRequestError(String(e));
          },
        }),

      headObject: (fileKey, bucketName) =>
        Effect.tryPromise({
          try: async () => {
            const r = await client.fetch(objectUrl(bucketName ?? config.bucketName, fileKey), {
              method: 'HEAD',
            });
            if (r.status === 404) {
              throw new StorageNotFoundError(`Not found: ${fileKey}`);
            }
            if (!r.ok) {
              throw new StorageRequestError(`Head failed: ${r.status}`, r.status);
            }
          },
          catch: (e) => {
            if (e instanceof StorageNotFoundError) return e;
            if (e instanceof StorageRequestError) return e;
            return new StorageRequestError(String(e));
          },
        }),

      copyObject: (sourceFileKey, destFileKey, bucketName, sourceBucketName) =>
        Effect.tryPromise({
          try: async () => {
            const destBucket = bucketName ?? config.bucketName;
            const srcBucket = sourceBucketName ?? destBucket;
            const r = await client.fetch(objectUrl(destBucket, destFileKey), {
              method: 'PUT',
              headers: {
                'x-amz-copy-source': `/${srcBucket}/${encodeKey(sourceFileKey)}`,
              },
            });
            if (r.status === 404) {
              throw new StorageNotFoundError(`Source not found: ${srcBucket}/${sourceFileKey}`);
            }
            if (!r.ok) {
              throw new StorageRequestError(`Copy failed: ${r.status}`, r.status);
            }
          },
          catch: (e) => {
            if (e instanceof StorageNotFoundError) return e;
            if (e instanceof StorageRequestError) return e;
            return new StorageRequestError(String(e));
          },
        }),
    });
  }),
);
