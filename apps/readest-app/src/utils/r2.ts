import { createServerOnlyFn } from '@tanstack/react-start';

const createR2Client = createServerOnlyFn(async () => {
  const { AwsClient } = await import('aws4fetch');

  return new AwsClient({
    service: 's3',
    region: process.env['R2_REGION'] || 'auto',
    accessKeyId: process.env['R2_ACCESS_KEY_ID']!,
    secretAccessKey: process.env['R2_SECRET_ACCESS_KEY']!,
  });
});

const getR2Url = createServerOnlyFn(() => {
  const R2_ACCOUNT_ID = process.env['R2_ACCOUNT_ID']!;
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
});

export const r2Storage = {
  getR2Client: createR2Client,
  getR2Url,

  getDownloadSignedUrl: createServerOnlyFn(
    async (bucketName: string, fileKey: string, expiresIn: number) => {
      const client = await createR2Client();
      const r2Url = getR2Url();

      return (
        await client.sign(
          new Request(`${r2Url}/${bucketName}/${fileKey}?X-Amz-Expires=${expiresIn}`),
          {
            aws: { signQuery: true },
          },
        )
      ).url.toString();
    },
  ),

  getUploadSignedUrl: createServerOnlyFn(
    async (bucketName: string, fileKey: string, contentLength: number, expiresIn: number) => {
      const client = await createR2Client();
      const r2Url = getR2Url();

      return (
        await client.sign(
          new Request(
            `${r2Url}/${bucketName}/${fileKey}?X-Amz-Expires=${expiresIn}&X-Amz-SignedHeaders=content-length`,
            {
              method: 'PUT',
              headers: {
                'Content-Length': contentLength.toString(),
              },
            },
          ),
          {
            aws: { signQuery: true },
          },
        )
      ).url.toString();
    },
  ),

  deleteObject: createServerOnlyFn(async (bucketName: string, fileKey: string) => {
    const client = await createR2Client();
    const r2Url = getR2Url();

    return await client.fetch(`${r2Url}/${bucketName}/${fileKey}`, {
      method: 'DELETE',
    });
  }),

  headObject: createServerOnlyFn(async (bucketName: string, fileKey: string) => {
    const client = await createR2Client();
    const r2Url = getR2Url();
    const response = await client.fetch(`${r2Url}/${bucketName}/${fileKey}`, {
      method: 'HEAD',
    });
    return response;
  }),

  copyObject: createServerOnlyFn(
    async (
      bucketName: string,
      sourceFileKey: string,
      destFileKey: string,
      sourceBucketName?: string,
    ) => {
      const client = await createR2Client();
      const r2Url = getR2Url();
      const srcBucket = sourceBucketName || bucketName;
      // S3 / R2 require the copy-source header to be URL-encoded segment-by-
      // segment. file_key is built from the original filename, so spaces and
      // reserved chars (e.g. `My Book.epub`, `A&B.epub`) are common and would
      // otherwise break the copy. We encode each path segment but keep the
      // separating slashes literal.
      const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');
      const copySource = `/${srcBucket}/${encodeKey(sourceFileKey)}`;
      const response = await client.fetch(`${r2Url}/${bucketName}/${destFileKey}`, {
        method: 'PUT',
        headers: {
          'x-amz-copy-source': copySource,
        },
      });
      return response;
    },
  ),
};
