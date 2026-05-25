import { createFileRoute } from '@tanstack/react-router';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { files } from '@/db/schema';
import { rlsMiddleware } from '@/middlewares/rls';
import { deleteObject } from '@/utils/object';

interface BulkDeleteResult {
  success: string[];
  failed: Array<{ fileKey: string; error: string }>;
  deletedCount: number;
  failedCount: number;
}

/**
 * DELETE /api/storage/purge — owner-only, bulk delete (≤100 keys per call).
 */
export const Route = createFileRoute('/api/storage/purge')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      DELETE: async ({ request, context }) => {
        const { user, tx } = context;
        try {
          const body: { fileKeys?: unknown } = await request.json();
          const { fileKeys } = body;

          if (!fileKeys || !Array.isArray(fileKeys)) {
            return Response.json(
              { error: 'Missing or invalid fileKeys array' },
              { status: 400 },
            );
          }
          if (fileKeys.length === 0) {
            return Response.json({ error: 'fileKeys array cannot be empty' }, { status: 400 });
          }
          if (fileKeys.length > 100) {
            return Response.json(
              { error: 'Cannot delete more than 100 files at once' },
              { status: 400 },
            );
          }
          if (!fileKeys.every((key) => typeof key === 'string')) {
            return Response.json({ error: 'All fileKeys must be strings' }, { status: 400 });
          }

          let fileRecords: Array<{ id: string; userId: string; fileKey: string }>;
          try {
            fileRecords = await tx
              .select({ id: files.id, userId: files.userId, fileKey: files.fileKey })
              .from(files)
              .where(
                and(
                  eq(files.userId, user.id),
                  inArray(files.fileKey, fileKeys),
                  isNull(files.deletedAt),
                ),
              );
          } catch (error) {
            console.error('Error querying files:', error);
            return Response.json(
              { error: 'Failed to retrieve files for deletion' },
              { status: 500 },
            );
          }

          if (fileRecords.length === 0) {
            return Response.json({ error: 'No matching files found' }, { status: 404 });
          }

          const unauthorizedFiles = fileRecords.filter((record) => record.userId !== user.id);
          if (unauthorizedFiles.length > 0) {
            return Response.json(
              { error: 'Unauthorized access to one or more files' },
              { status: 403 },
            );
          }

          const results = await Promise.allSettled(
            fileRecords.map(async (fileRecord) => {
              try {
                await deleteObject(fileRecord.fileKey);
                await tx.delete(files).where(eq(files.id, fileRecord.id));
                return { fileKey: fileRecord.fileKey, success: true as const };
              } catch (error) {
                console.error(`Error deleting file ${fileRecord.fileKey}:`, error);
                return {
                  fileKey: fileRecord.fileKey,
                  success: false as const,
                  error: error instanceof Error ? error.message : 'Unknown error',
                };
              }
            }),
          );

          const success: string[] = [];
          const failed: Array<{ fileKey: string; error: string }> = [];

          results.forEach((result) => {
            if (result.status === 'fulfilled') {
              if (result.value.success) {
                success.push(result.value.fileKey);
              } else {
                failed.push({
                  fileKey: result.value.fileKey,
                  error: result.value.error || 'Unknown error',
                });
              }
            } else {
              const reason = result.reason as { message?: string } | undefined;
              failed.push({
                fileKey: 'unknown',
                error: reason?.message || 'Promise rejected',
              });
            }
          });

          // Handle files that weren't found in the database
          const foundFileKeys = new Set(fileRecords.map((record) => record.fileKey));
          const notFoundKeys = fileKeys.filter((key) => !foundFileKeys.has(key));
          notFoundKeys.forEach((key) => {
            failed.push({
              fileKey: key,
              error: 'File not found or already deleted',
            });
          });

          const response: BulkDeleteResult = {
            success,
            failed,
            deletedCount: success.length,
            failedCount: failed.length,
          };

          const statusCode =
            failed.length > 0 && success.length > 0 ? 207 : failed.length > 0 ? 500 : 200;

          return Response.json(response, { status: statusCode });
        } catch (error) {
          console.error(error);
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});
