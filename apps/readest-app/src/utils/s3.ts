import { createServerOnlyFn } from '@tanstack/react-start';
import { env } from '@/env';

const createS3Client = createServerOnlyFn(async () => {
  const { S3Client } = await import('@aws-sdk/client-s3');

  return new S3Client({
    forcePathStyle: true,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
});

export const s3Storage = {
  getClient: createS3Client,

  getDownloadSignedUrl: createServerOnlyFn(
    async (bucketName: string, fileKey: string, expiresIn: number) => {
      const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/s3-request-presigner'),
      ]);
      const client = await createS3Client();

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
      });
      const downloadUrl = await getSignedUrl(client, getCommand, {
        expiresIn,
      });
      return downloadUrl;
    },
  ),

  getUploadSignedUrl: createServerOnlyFn(
    async (bucketName: string, fileKey: string, contentLength: number, expiresIn: number) => {
      const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/s3-request-presigner'),
      ]);
      const client = await createS3Client();
      const signableHeaders = new Set<string>(['content-length']);
      const putCommand = new PutObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
        ContentLength: contentLength,
      });

      const uploadUrl = await getSignedUrl(client, putCommand, {
        expiresIn,
        signableHeaders,
      });

      return uploadUrl;
    },
  ),

  deleteObject: createServerOnlyFn(async (bucketName: string, fileKey: string) => {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await createS3Client();
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: fileKey,
    });

    return await client.send(deleteCommand);
  }),

  headObject: createServerOnlyFn(async (bucketName: string, fileKey: string) => {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await createS3Client();
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: fileKey,
    });

    return await client.send(headCommand);
  }),

  copyObject: createServerOnlyFn(
    async (
      bucketName: string,
      sourceFileKey: string,
      destFileKey: string,
      sourceBucketName?: string,
    ) => {
      const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await createS3Client();
      const srcBucket = sourceBucketName || bucketName;
      // S3 requires CopySource to be URL-encoded segment-by-segment. file_key
      // is built from the original filename, so spaces and reserved chars
      // (e.g. `My Book.epub`, `A&B.epub`) are common and would otherwise
      // break the copy.
      const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');
      const copyCommand = new CopyObjectCommand({
        Bucket: bucketName,
        Key: destFileKey,
        CopySource: `${srcBucket}/${encodeKey(sourceFileKey)}`,
      });

      return await client.send(copyCommand);
    },
  ),
};
