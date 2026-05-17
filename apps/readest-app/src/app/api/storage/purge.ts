import { createFileRoute } from '@tanstack/react-router';
import { createSupabaseAdminClient } from '@/utils/supabase';
import { validateUserAndToken } from '@/utils/access';
import { deleteObject } from '@/utils/object';

interface BulkDeleteResult {
  success: string[];
  failed: Array<{ fileKey: string; error: string }>;
  deletedCount: number;
  failedCount: number;
}

export const Route = createFileRoute('/api/storage/purge')({
  server: {
    handlers: {
      DELETE: async ({ request }) => {
        try {
          const { user, token } = await validateUserAndToken(
            request.headers.get('authorization') ?? undefined,
          );
          if (!user || !token) {
            return Response.json({ error: 'Not authenticated' }, { status: 403 });
          }

          const body: { fileKeys?: unknown } = await request.json();
          const { fileKeys } = body;

          if (!fileKeys || !Array.isArray(fileKeys)) {
            return Response.json({ error: 'Missing or invalid fileKeys array' }, { status: 400 });
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

          const supabase = createSupabaseAdminClient();

          // Fetch all files that match the provided keys and belong to the user
          const { data: fileRecords, error: fileError } = await supabase
            .from('files')
            .select('id, user_id, file_key')
            .eq('user_id', user.id)
            .in('file_key', fileKeys)
            .is('deleted_at', null);

          if (fileError) {
            console.error('Error querying files:', fileError);
            return Response.json(
              { error: 'Failed to retrieve files for deletion' },
              { status: 500 },
            );
          }

          if (!fileRecords || fileRecords.length === 0) {
            return Response.json({ error: 'No matching files found' }, { status: 404 });
          }

          // Verify all files belong to the user
          const unauthorizedFiles = fileRecords.filter((record) => record.user_id !== user.id);
          if (unauthorizedFiles.length > 0) {
            return Response.json(
              { error: 'Unauthorized access to one or more files' },
              { status: 403 },
            );
          }

          // Process deletions
          const results = await Promise.allSettled(
            fileRecords.map(async (fileRecord) => {
              try {
                // Delete from storage
                await deleteObject(fileRecord.file_key);

                // Delete from database
                const { error: deleteError } = await supabase
                  .from('files')
                  .delete()
                  .eq('id', fileRecord.id);

                if (deleteError) {
                  throw new Error(`Database deletion failed: ${deleteError.message}`);
                }

                return { fileKey: fileRecord.file_key, success: true };
              } catch (error) {
                console.error(`Error deleting file ${fileRecord.file_key}:`, error);
                return {
                  fileKey: fileRecord.file_key,
                  success: false,
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
              failed.push({
                fileKey: 'unknown',
                error: result.reason?.message || 'Promise rejected',
              });
            }
          });

          // Handle files that weren't found in the database
          const foundFileKeys = new Set(fileRecords.map((record) => record.file_key));
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

          // Return 207 Multi-Status if there are partial failures
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
