import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNull } from 'drizzle-orm';
import { files } from '@/db/schema';
import { rlsMiddleware } from '@/middlewares/rls';
import { Effect } from 'effect';
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
            .select({ id: files.id, userId: files.userId, fileKey: files.fileKey })
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

          try {
            await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                yield* storage.deleteObject(fileKey).pipe(
                  // Idempotent: storage already gone counts as success;
                  // the DB delete below still runs.
                  Effect.catchTag('StorageNotFoundError', () => Effect.void),
                );
              }),
            );
            await tx.delete(files).where(eq(files.id, fileRecord.id));
            return Response.json({ message: 'File deleted successfully' });
          } catch (error) {
            console.error('Error deleting file from storage:', error);
            return Response.json({ error: 'Could not delete file from storage' }, { status: 500 });
          }
        } catch (error) {
          console.error(error);
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});
