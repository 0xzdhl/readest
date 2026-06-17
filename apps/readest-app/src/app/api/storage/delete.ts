import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { files } from '@/db/schema';
import { rlsMiddleware } from '@/middlewares/rls';
import { Effect, Either } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';

/**
 * DELETE /api/storage/delete?fileKey=… — owner-only. Removes the object from
 * R2/S3 then deletes the matching `files` row.
 */
export const Route = createFileRoute('/api/storage/delete')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      DELETE: async ({ request, context }) => {
        const { user, tx } = context;
        try {
          const url = new URL(request.url);
          const fileKey = url.searchParams.get('fileKey');

          if (!fileKey) {
            return Response.json({ error: 'Missing or invalid fileKey' }, { status: 400 });
          }

          // RLS hides tombstoned rows for the owner already; add an explicit
          // `deleted_at IS NULL` filter so behaviour matches the legacy
          // supabase query semantics (which also relied on a partial index).
          const rows = await tx
            .select({
              id: files.id,
              userId: files.userId,
              fileKey: files.fileKey,
              contentHash: files.contentHash,
            })
            .from(files)
            .where(
              and(eq(files.userId, user.id), eq(files.fileKey, fileKey), isNull(files.deletedAt)),
            )
            .limit(1);

          const fileRecord = rows[0];
          if (!fileRecord) {
            return Response.json({ error: 'File not found' }, { status: 404 });
          }
          if (fileRecord.userId !== user.id) {
            return Response.json({ error: 'Unauthorized access to the file' }, { status: 403 });
          }

          // Delete the DB row FIRST so the refcount reflects this removal.
          // (Race note: concurrent deletes of the last two refs to the same
          // content_hash may both see count=0 and both attempt to delete the
          // shared object — idempotent at the storage layer, but may orphan
          // in the opposite race; acceptable v1 limitation.)
          await tx.delete(files).where(eq(files.id, fileRecord.id));

          const targetKey = fileRecord.contentHash
            ? `content/${fileRecord.contentHash}`
            : fileRecord.fileKey;
          let shouldDeleteObject = true;
          if (fileRecord.contentHash) {
            const [{ count }] = (await tx.execute(
              sql`select files_content_ref_count(${fileRecord.contentHash}) as count`,
            )) as unknown as Array<{ count: number | string }>;
            shouldDeleteObject = Number(count) === 0;
          }

          if (shouldDeleteObject) {
            const deleteResult = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                yield* storage
                  .deleteObject(targetKey)
                  .pipe(Effect.catchTag('StorageNotFoundError', () => Effect.void));
              }),
            );
            if (Either.isLeft(deleteResult)) {
              console.error('Error deleting object from storage:', deleteResult.left);
              return Response.json(
                { error: 'Could not delete file from storage' },
                { status: 500 },
              );
            }
          }

          return Response.json({ message: 'File deleted successfully' });
        } catch (error) {
          console.error(error);
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});
