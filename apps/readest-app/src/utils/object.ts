import { createServerOnlyFn } from '@tanstack/react-start';
import { getStorageType } from './storage';

export const getDownloadSignedUrl = createServerOnlyFn(
  async (fileKey: string, expiresIn: number, bucketName?: string) => {
    const storageType = getStorageType();
    if (storageType === 'r2') {
      const { r2Storage } = await import('./r2');
      bucketName = bucketName || process.env['R2_BUCKET_NAME'] || '';
      return await r2Storage.getDownloadSignedUrl(bucketName, fileKey, expiresIn);
    } else {
      const { s3Storage } = await import('./s3');
      bucketName = bucketName || process.env['S3_BUCKET_NAME'] || '';
      return await s3Storage.getDownloadSignedUrl(bucketName, fileKey, expiresIn);
    }
  },
);

export const getUploadSignedUrl = createServerOnlyFn(
  async (fileKey: string, contentLength: number, expiresIn: number, bucketName?: string) => {
    const storageType = getStorageType();
    if (storageType === 'r2') {
      const { r2Storage } = await import('./r2');
      bucketName = bucketName || process.env['R2_BUCKET_NAME'] || '';
      return await r2Storage.getUploadSignedUrl(bucketName, fileKey, contentLength, expiresIn);
    } else {
      const { s3Storage } = await import('./s3');
      bucketName = bucketName || process.env['S3_BUCKET_NAME'] || '';
      return await s3Storage.getUploadSignedUrl(bucketName, fileKey, contentLength, expiresIn);
    }
  },
);

export const deleteObject = createServerOnlyFn(async (fileKey: string, bucketName?: string) => {
  const storageType = getStorageType();
  if (storageType === 'r2') {
    const { r2Storage } = await import('./r2');
    bucketName = bucketName || process.env['R2_BUCKET_NAME'] || '';
    return await r2Storage.deleteObject(bucketName, fileKey);
  } else {
    const { s3Storage } = await import('./s3');
    bucketName = bucketName || process.env['S3_BUCKET_NAME'] || '';
    return await s3Storage.deleteObject(bucketName, fileKey);
  }
});

// Returns true if the object exists in storage. Used to verify uploads completed
// before treating a `files` row as shareable.
export const objectExists = createServerOnlyFn(
  async (fileKey: string, bucketName?: string): Promise<boolean> => {
    const storageType = getStorageType();
    try {
      if (storageType === 'r2') {
        const { r2Storage } = await import('./r2');
        bucketName = bucketName || process.env['R2_BUCKET_NAME'] || '';
        const response = await r2Storage.headObject(bucketName, fileKey);
        return response.ok;
      } else {
        const { s3Storage } = await import('./s3');
        bucketName = bucketName || process.env['S3_BUCKET_NAME'] || '';
        await s3Storage.headObject(bucketName, fileKey);
        return true;
      }
    } catch {
      return false;
    }
  },
);

// Server-side byte copy used by /api/share/$token/import to clone a shared
// book into the recipient's namespace without egress.
export const copyObject = createServerOnlyFn(
  async (sourceFileKey: string, destFileKey: string, bucketName?: string) => {
    const storageType = getStorageType();
    if (storageType === 'r2') {
      const { r2Storage } = await import('./r2');
      bucketName = bucketName || process.env['R2_BUCKET_NAME'] || '';
      return await r2Storage.copyObject(bucketName, sourceFileKey, destFileKey);
    } else {
      const { s3Storage } = await import('./s3');
      bucketName = bucketName || process.env['S3_BUCKET_NAME'] || '';
      return await s3Storage.copyObject(bucketName, sourceFileKey, destFileKey);
    }
  },
);
