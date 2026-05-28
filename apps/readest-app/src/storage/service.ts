import { Context, type Effect } from 'effect';
import type { StorageNotFoundError, StorageRequestError, StorageSignError } from './errors';

export class ObjectStorage extends Context.Tag('ObjectStorage')<
  ObjectStorage,
  {
    readonly getUploadSignedUrl: (
      fileKey: string,
      contentLength: number,
      expiresIn: number,
      bucketName?: string,
    ) => Effect.Effect<string, StorageSignError>;

    readonly getDownloadSignedUrl: (
      fileKey: string,
      expiresIn: number,
      bucketName?: string,
    ) => Effect.Effect<string, StorageSignError>;

    readonly deleteObject: (
      fileKey: string,
      bucketName?: string,
    ) => Effect.Effect<void, StorageRequestError | StorageNotFoundError>;

    readonly headObject: (
      fileKey: string,
      bucketName?: string,
    ) => Effect.Effect<void, StorageRequestError | StorageNotFoundError>;

    readonly copyObject: (
      sourceFileKey: string,
      destFileKey: string,
      bucketName?: string,
      sourceBucketName?: string,
    ) => Effect.Effect<void, StorageRequestError | StorageNotFoundError>;
  }
>() {}
