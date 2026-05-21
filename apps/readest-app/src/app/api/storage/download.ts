import { createFileRoute } from '@tanstack/react-router';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { files } from '@/db/schema';
import { runProtected, type ProtectedRouteContext } from '@/libs/server/route-helpers';
import { getDownloadSignedUrl } from '@/utils/object';

/**
 * GET / POST /api/storage/download — owner-only. Mints short-lived presigned
 * GET URLs for one (GET) or many (POST) keys. Phase 5 swaps the supabase
 * admin client for an RLS-scoped drizzle tx; the presigner is unchanged.
 *
 * The fallback path (lookup-by-book_hash when a literal file_key match
 * misses) preserves the legacy behaviour where the client can pass a
 * client-side reconstructed `${userId}/Readest/Book/{hash}/{filename}` key
 * and the server resolves it to whatever file actually backs the book hash
 * + extension — needed for cases where the on-disk filename drifted.
 */

interface FileRow {
  userId: string;
  fileKey: string;
  bookHash: string | null;
}

async function processFileKeys(
  fileKeys: string[],
  userId: string,
  tx: ProtectedRouteContext['tx'],
): Promise<Record<string, string | undefined>> {
  let fileRecords: FileRow[] = [];
  try {
    fileRecords = await tx
      .select({
        userId: files.userId,
        fileKey: files.fileKey,
        bookHash: files.bookHash,
      })
      .from(files)
      .where(
        and(
          eq(files.userId, userId),
          inArray(files.fileKey, fileKeys),
          isNull(files.deletedAt),
        ),
      );
  } catch (error) {
    console.error('Error querying files:', error);
    return Object.fromEntries(fileKeys.map((key) => [key, undefined]));
  }

  const fileRecordMap = new Map<string, FileRow>(fileRecords.map((r) => [r.fileKey, r]));
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
      try {
        const fallbackRecords = await tx
          .select({
            userId: files.userId,
            fileKey: files.fileKey,
            bookHash: files.bookHash,
          })
          .from(files)
          .where(
            and(
              eq(files.userId, userId),
              inArray(files.bookHash, bookHashes),
              isNull(files.deletedAt),
            ),
          );
        for (const candidate of fallbackCandidates) {
          const matchedFile = fallbackRecords.find(
            (f) =>
              f.bookHash === candidate.bookHash &&
              f.fileKey.endsWith(`.${candidate.fileExtension}`),
          );
          if (matchedFile) {
            fileRecordMap.set(candidate.originalKey, matchedFile);
          }
        }
      } catch (error) {
        console.error('Error querying fallback files:', error);
      }
    }
  }

  const results = await Promise.allSettled(
    fileKeys.map(async (fileKey) => {
      const fileRecord = fileRecordMap.get(fileKey);
      if (!fileRecord) {
        return { fileKey, downloadUrl: undefined };
      }
      if (fileRecord.userId !== userId) {
        return { fileKey, downloadUrl: undefined };
      }
      try {
        const downloadUrl = await getDownloadSignedUrl(fileRecord.fileKey, 1800);
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
      GET: async ({ request }) =>
        runProtected(request, async ({ user, tx }) => {
          try {
            const url = new URL(request.url);
            let fileKey = url.searchParams.get('fileKey');

            // Also parse fileKey directly from raw URL to handle special characters like & in filenames.
            // Frameworks may incorrectly split parameters when the fileKey value contains
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

            const downloadUrlsMap = await processFileKeys([fileKey], user.id, tx);
            const downloadUrl = downloadUrlsMap[fileKey];

            if (!downloadUrl) {
              return Response.json({ error: 'File not found' }, { status: 404 });
            }

            return Response.json({ downloadUrl });
          } catch (error) {
            console.error(error);
            return Response.json({ error: 'Something went wrong' }, { status: 500 });
          }
        }),

      POST: async ({ request }) =>
        runProtected(request, async ({ user, tx }) => {
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
            if (!fileKeys.every((key) => typeof key === 'string')) {
              return Response.json({ error: 'All fileKeys must be strings' }, { status: 400 });
            }

            const downloadUrls = await processFileKeys(fileKeys, user.id, tx);
            return Response.json({ downloadUrls });
          } catch (error) {
            console.error(error);
            return Response.json({ error: 'Something went wrong' }, { status: 500 });
          }
        }),
    },
  },
});
