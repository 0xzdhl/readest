import { readPublicEnv } from '@/utils/publicEnv';

type ObjectStorageType = 'r2' | 's3';

export const getStorageType = (): ObjectStorageType => {
  // TODO: do not expose storage type to client
  const storageType = readPublicEnv('VITE_OBJECT_STORAGE_TYPE');
  if (storageType) {
    return storageType as ObjectStorageType;
  } else {
    return 'r2';
  }
};
