import { createFileRoute } from '@tanstack/react-router';
import { and, eq } from 'drizzle-orm';
import { files } from '@/db/schema';
import { env } from '@/env';
import { getStoragePlanData, STORAGE_QUOTA_GRACE_BYTES } from '@/libs/server/storage-plan';
import { rlsMiddleware } from '@/middlewares/rls';
import { READEST_PUBLIC_STORAGE_BASE_URL } from '@/services/constants';
import { Effect } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';

/**
 * POST /api/storage/upload — owner-only. Mints a presigned PUT URL for a new
 * object and (for non-temp uploads) inserts a `files` row tracking quota use.
 */
export const Route = createFileRoute('/api/storage/upload')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const { user, tx } = context;
        const body: {
          fileName?: string;
          fileSize?: number;
          bookHash?: string;
          replicaKind?: string;
          replicaId?: string;
          temp?: boolean;
        } = await request.json();
        const { fileName, fileSize, bookHash, replicaKind, replicaId, temp = false } = body;

        if (temp) {
          try {
            const datetime = new Date();
            const timeStr = datetime
              .toISOString()
              .replace(/[-:]/g, '')
              .replace('T', '')
              .slice(0, 10);
            const userStr = user.id.slice(0, 8);
            const fileKey = `temp/img/${timeStr}/${userStr}/${fileName}`;
            const bucketName = env.TEMP_STORAGE_PUBLIC_BUCKET_NAME;
            const uploadUrl = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.getUploadSignedUrl(fileKey, fileSize ?? 0, 1800, bucketName);
              }),
            );
            const downloadUrl = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.getDownloadSignedUrl(fileKey, 3 * 86400, bucketName);
              }),
            );
            const pathname = new URL(downloadUrl).pathname;
            const publicBaseUrl = READEST_PUBLIC_STORAGE_BASE_URL;
            const publicDownloadUrl = `${publicBaseUrl}${pathname.replace(`/${bucketName}`, '')}`;
            return Response.json({
              uploadUrl,
              downloadUrl: publicDownloadUrl,
            });
          } catch (error) {
            console.error('Error creating presigned post for temp file:', error);
            return Response.json({ error: 'Could not create presigned post' }, { status: 500 });
          }
        }

        try {
          if (!fileName || !fileSize) {
            return Response.json({ error: 'Missing file info' }, { status: 400 });
          }

          const { usage, quota } = getStoragePlanData(user);
          if (usage + fileSize > quota + STORAGE_QUOTA_GRACE_BYTES) {
            return Response.json({ error: 'Insufficient storage quota', usage }, { status: 403 });
          }

          const fileKey = `${user.id}/${fileName}`;

          // RLS scopes by `app.user_id`, so the `eq(files.userId, ...)` is
          // technically redundant — kept for read-clarity and to align with
          // the schema's unique key shape (`file_key` is globally unique;
          // the user filter just narrows the SELECT).
          const existing = await tx
            .select()
            .from(files)
            .where(and(eq(files.userId, user.id), eq(files.fileKey, fileKey)))
            .limit(1);

          const existingRecord = existing[0];
          let objSize = fileSize;
          if (existingRecord) {
            objSize = existingRecord.fileSize;
          } else {
            await tx.insert(files).values({
              userId: user.id,
              bookHash: bookHash ?? null,
              replicaKind: replicaKind ?? null,
              replicaId: replicaId ?? null,
              fileKey,
              fileSize,
            });
          }

          try {
            const uploadUrl = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.getUploadSignedUrl(fileKey, objSize, 1800);
              }),
            );
            return Response.json({
              uploadUrl,
              fileKey,
              usage: usage + fileSize,
              quota,
            });
          } catch (error) {
            console.error('Error creating presigned post:', error);
            return Response.json({ error: 'Could not create presigned post' }, { status: 500 });
          }
        } catch (error) {
          console.error(error);
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});
