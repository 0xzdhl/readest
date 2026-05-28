import { Layer } from 'effect';
import { StorageConfigLive } from './config';
import { S3CompatibleStorageLive } from './s3Compatible';

export const StorageLive = S3CompatibleStorageLive.pipe(Layer.provide(StorageConfigLive));
