import { createFileRoute } from '@tanstack/react-router';
import { createSupabaseAdminClient } from '@/utils/supabase';
import { getDownloadSignedUrl } from '@/utils/object';
import { validateUserAndToken } from '@/utils/access';

async function processFileKeys(
  fileKeys: string[],
  userId: string,
): Promise<Record<string, string | undefined>> {
  const supabase = createSupabaseAdminClient();

  const { data: fileRecords, error: fileError } = await supabase
    .from('files')
    .select('user_id, file_key, book_hash')
    .eq('user_id', userId)
    .in('file_key', fileKeys)
    .is('deleted_at', null);

  if (fileError) {
    console.error('Error querying files:', fileError);
    return Object.fromEntries(fileKeys.map((key) => [key, undefined]));
  }

  const fileRecordMap = new Map((fileRecords || []).map((record) => [record.file_key, record]));

  const missingFileKeys = fileKeys.filter((key) => !fileRecordMap.has(key));

  if (missingFileKeys.length > 0) {
    const fallbackCandidates = missingFileKeys
      .filter((key) => key.includes('Readest/Book'))
      .map((key) => {
        const parts = key.split('/');
        if (parts.length === 5) {
          const bookHash = parts[3]!;
          const filename = parts[4]!;
          const fileExtension = filename.split('.').pop() || '';
          return { originalKey: key, bookHash, fileExtension };
        }
        return null;
      })
      .filter(Boolean) as Array<{ originalKey: string; bookHash: string; fileExtension: string }>;

    if (fallbackCandidates.length > 0) {
      const bookHashes = [...new Set(fallbackCandidates.map((c) => c.bookHash))];

      const { data: fallbackRecords, error: fallbackError } = await supabase
        .from('files')
        .select('user_id, file_key, book_hash')
        .eq('user_id', userId)
        .in('book_hash', bookHashes)
        .is('deleted_at', null);

      if (!fallbackError && fallbackRecords) {
        for (const candidate of fallbackCandidates) {
          const matchedFile = fallbackRecords.find(
            (f) =>
              f.book_hash === candidate.bookHash &&
              f.file_key.endsWith(`.${candidate.fileExtension}`),
          );
          if (matchedFile) {
            fileRecordMap.set(candidate.originalKey, matchedFile);
          }
        }
      }
    }
  }

  const results = await Promise.allSettled(
    fileKeys.map(async (fileKey) => {
      const fileRecord = fileRecordMap.get(fileKey);

      if (!fileRecord) {
        return { fileKey, downloadUrl: undefined };
      }

      if (fileRecord.user_id !== userId) {
        return { fileKey, downloadUrl: undefined };
      }

      try {
        const downloadUrl = await getDownloadSignedUrl(fileRecord.file_key, 1800);
        return { fileKey, downloadUrl };
      } catch (error) {
        console.error('Error creating signed URL for %s:', fileKey, error);
        return { fileKey, downloadUrl: undefined };
      }
    }),
  );

  const downloadUrls: Record<string, string | undefined> = {};

  results.forEach((result, index) => {
    const fileKey = fileKeys[index]!;
    if (result.status === 'fulfilled') {
      downloadUrls[fileKey] = result.value.downloadUrl;
    } else {
      downloadUrls[fileKey] = undefined;
    }
  });

  return downloadUrls;
}

export const Route = createFileRoute('/api/storage/download')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { user, token } = await validateUserAndToken(
            request.headers.get('authorization') ?? undefined,
          );
          if (!user || !token) {
            return Response.json({ error: 'Not authenticated' }, { status: 403 });
          }

          const url = new URL(request.url);
          let fileKey = url.searchParams.get('fileKey');

          // Also parse fileKey directly from raw URL to handle special characters like & in filenames.
          // because frameworks may incorrectly split parameters when the fileKey value contains
          // encoded & (%26), treating it as a parameter separator.
          if (request.url.includes('fileKey=') && request.url.includes('&')) {
            const fileKeyFromUrl = request.url
              .substring(request.url.indexOf('fileKey=') + 8)
              .replace(/\+/g, '%20')
              .replace(/&/g, '%26')
              .replace(/=$/, '');
            fileKey = decodeURIComponent(fileKeyFromUrl);
          }

          if (!fileKey) {
            return Response.json({ error: 'Missing or invalid fileKey' }, { status: 400 });
          }

          const downloadUrlsMap = await processFileKeys([fileKey], user.id);
          const downloadUrl = downloadUrlsMap[fileKey];

          if (!downloadUrl) {
            return Response.json({ error: 'File not found' }, { status: 404 });
          }

          return Response.json({ downloadUrl });
        } catch (error) {
          console.error(error);
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },

      POST: async ({ request }) => {
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

          if (!fileKeys.every((key) => typeof key === 'string')) {
            return Response.json({ error: 'All fileKeys must be strings' }, { status: 400 });
          }

          const downloadUrls = await processFileKeys(fileKeys, user.id);

          return Response.json({ downloadUrls });
        } catch (error) {
          console.error(error);
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});
