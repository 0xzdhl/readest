import { createFileRoute } from '@tanstack/react-router';
import { createSupabaseAdminClient } from '@/utils/supabase';
import {
  getStoragePlanData,
  validateUserAndToken,
  STORAGE_QUOTA_GRACE_BYTES,
} from '@/utils/access';
import { getDownloadSignedUrl, getUploadSignedUrl } from '@/utils/object';
import { READEST_PUBLIC_STORAGE_BASE_URL } from '@/services/constants';

export const Route = createFileRoute('/api/storage/upload')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { user, token } = await validateUserAndToken(
          request.headers.get('authorization') ?? undefined,
        );
        if (!user || !token) {
          return Response.json({ error: 'Not authenticated' }, { status: 403 });
        }

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
            const bucketName = process.env['TEMP_STORAGE_PUBLIC_BUCKET_NAME'] || '';
            const uploadUrl = await getUploadSignedUrl(fileKey, fileSize ?? 0, 1800, bucketName);
            const downloadUrl = await getDownloadSignedUrl(fileKey, 3 * 86400, bucketName);
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

          const { usage, quota } = getStoragePlanData(token);
          if (usage + fileSize > quota + STORAGE_QUOTA_GRACE_BYTES) {
            return Response.json({ error: 'Insufficient storage quota', usage }, { status: 403 });
          }

          const fileKey = `${user.id}/${fileName}`;
          const supabase = createSupabaseAdminClient();
          const { data: existingRecord, error: fetchError } = await supabase
            .from('files')
            .select('*')
            .eq('user_id', user.id)
            .eq('file_key', fileKey)
            .limit(1)
            .single();

          if (fetchError && fetchError.code !== 'PGRST116') {
            return Response.json({ error: fetchError.message }, { status: 500 });
          }
          let objSize = fileSize;
          if (existingRecord) {
            objSize = existingRecord.file_size;
          } else {
            const { data: inserted, error: insertError } = await supabase
              .from('files')
              .insert([
                {
                  user_id: user.id,
                  book_hash: bookHash ?? null,
                  replica_kind: replicaKind ?? null,
                  replica_id: replicaId ?? null,
                  file_key: fileKey,
                  file_size: fileSize,
                },
              ])
              .select()
              .single();
            console.log('Inserted record:', inserted);
            if (insertError) return Response.json({ error: insertError.message }, { status: 500 });
          }

          try {
            const uploadUrl = await getUploadSignedUrl(fileKey, objSize, 1800);

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
