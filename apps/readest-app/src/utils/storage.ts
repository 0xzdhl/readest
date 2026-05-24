import { env } from '@/env';

type ObjectStorageType = 'r2' | 's3';

export const getStorageType = (): ObjectStorageType => {
  return env.VITE_OBJECT_STORAGE_TYPE;
};
