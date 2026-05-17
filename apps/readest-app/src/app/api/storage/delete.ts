import { createFileRoute } from '@tanstack/react-router';
import { createSupabaseAdminClient } from '@/utils/supabase';
import { validateUserAndToken } from '@/utils/access';
import { deleteObject } from '@/utils/object';

export const Route = createFileRoute('/api/storage/delete')({
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

          const url = new URL(request.url);
          const fileKey = url.searchParams.get('fileKey');

          if (!fileKey) {
            return Response.json({ error: 'Missing or invalid fileKey' }, { status: 400 });
          }

          const supabase = createSupabaseAdminClient();
          const { data: fileRecord, error: fileError } = await supabase
            .from('files')
            .select('user_id, id')
            .eq('user_id', user.id)
            .eq('file_key', fileKey)
            .limit(1)
            .single();

          if (fileError || !fileRecord) {
            return Response.json({ error: 'File not found' }, { status: 404 });
          }

          if (fileRecord.user_id !== user.id) {
            return Response.json({ error: 'Unauthorized access to the file' }, { status: 403 });
          }

          try {
            await deleteObject(fileKey);
            const { error: deleteError } = await supabase
              .from('files')
              .delete()
              .eq('id', fileRecord.id);

            if (deleteError) {
              console.error('Error updating file record:', deleteError);
              return Response.json({ error: 'Could not update file record' }, { status: 500 });
            }

            return Response.json({ message: 'File deleted successfully' });
          } catch (error) {
            console.error('Error deleting file from S3:', error);
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
