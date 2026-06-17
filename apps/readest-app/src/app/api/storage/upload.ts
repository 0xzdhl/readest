import { createFileRoute } from '@tanstack/react-router';
import { env } from '@/env';
import { rlsMiddleware } from '@/middlewares/rls';
import { Effect, Either } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';

/**
 * Hard cap on a single temp (public-bucket) upload. The temp branch writes a
 * client-supplied fileName into the public bucket with no per-user quota row,
 * so an unbounded size lets a caller dump arbitrarily large public objects.
 * 50 MiB comfortably covers cover/preview images while bounding abuse.
 */
const MAX_TEMP_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Sanitize a client-supplied temp fileName before it becomes part of a public
 * object key. Strips path separators, control chars and traversal sequences,
 * and restricts the result to a safe charset. Returns `null` when nothing
 * usable remains (e.g. the input was only separators / traversal).
 */
function sanitizeTempFileName(fileName: string): string | null {
  // Keep only the basename: drop anything up to the last separator so
  // `../../etc/passwd` and `a\\b\\c.png` collapse to their trailing segment.
  const basename = fileName.split(/[/\\]/).pop() ?? '';
  const cleaned = basename
    // Drop control chars (incl. NUL) before charset filtering.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Collapse any traversal dot-runs.
    .replace(/\.{2,}/g, '')
    // Restrict to a safe charset; everything else becomes `_`.
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // No leading dot/dash/underscore (avoids hidden/odd keys).
    .replace(/^[._-]+/, '')
    .slice(0, 255);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * POST /api/storage/upload — owner-only. Mints a presigned PUT URL. For a book
 * upload it stages the bytes (`staging/<user>/<uuid>`); the `files` row + quota
 * gate + cross-user dedup happen at POST /api/storage/finalize. The temp
 * (public bucket) and replica branches keep the single-step content-addressed
 * flow.
 */
export const Route = createFileRoute('/api/storage/upload')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const { user } = context;
        const body: {
          fileName?: string;
          fileSize?: number;
          temp?: boolean;
        } = await request.json();
        const { fileName, fileSize, temp = false } = body;

        if (temp) {
          try {
            if (!fileName) {
              return Response.json({ error: 'Missing file info' }, { status: 400 });
            }
            // Size cap: the temp branch writes into the public bucket without a
            // per-user quota row, so an unbounded `fileSize` is an abuse vector.
            if ((fileSize ?? 0) > MAX_TEMP_UPLOAD_BYTES) {
              return Response.json({ error: 'File too large' }, { status: 400 });
            }
            // Sanitize the client fileName before it becomes part of a public
            // object key (strip separators/control chars/traversal).
            const safeFileName = sanitizeTempFileName(fileName);
            if (!safeFileName) {
              return Response.json({ error: 'Invalid file name' }, { status: 400 });
            }
            const datetime = new Date();
            const timeStr = datetime
              .toISOString()
              .replace(/[-:]/g, '')
              .replace('T', '')
              .slice(0, 10);
            const userStr = user.id.slice(0, 8);
            const fileKey = `temp/img/${timeStr}/${userStr}/${safeFileName}`;
            const bucketName = env.TEMP_STORAGE_PUBLIC_BUCKET_NAME;
            const uploadResult = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.getUploadSignedUrl(fileKey, fileSize ?? 0, 1800, bucketName);
              }),
            );
            if (Either.isLeft(uploadResult)) {
              console.error('Error creating presigned post for temp file:', uploadResult.left);
              return Response.json({ error: 'Could not create presigned post' }, { status: 500 });
            }
            const downloadResult = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.getDownloadSignedUrl(fileKey, 3 * 86400, bucketName);
              }),
            );
            if (Either.isLeft(downloadResult)) {
              console.error('Error creating presigned post for temp file:', downloadResult.left);
              return Response.json({ error: 'Could not create presigned post' }, { status: 500 });
            }
            const pathname = new URL(downloadResult.right).pathname;
            const publicBaseUrl = env.STORAGE_PUBLIC_BASE_URL;
            const publicDownloadUrl = `${publicBaseUrl}${pathname.replace(`/${bucketName}`, '')}`;
            return Response.json({
              uploadUrl: uploadResult.right,
              downloadUrl: publicDownloadUrl,
            });
          } catch (error) {
            console.error('Error creating presigned post for temp file:', error);
            return Response.json({ error: 'Could not create presigned post' }, { status: 500 });
          }
        }

        // BOOK upload: stage the bytes; dedup happens at /finalize after the
        // server hashes the staged object. No files row / quota gate here.
        if (!fileName || !fileSize) {
          return Response.json({ error: 'Missing file info' }, { status: 400 });
        }
        const stagingKey = `staging/${user.id}/${crypto.randomUUID()}`;
        const uploadResult = await runStorageProgram(
          Effect.gen(function* () {
            const storage = yield* ObjectStorage;
            return yield* storage.getUploadSignedUrl(stagingKey, fileSize, 1800);
          }),
        );
        if (Either.isLeft(uploadResult)) {
          console.error('Error creating presigned post:', uploadResult.left);
          return Response.json({ error: 'Could not create presigned post' }, { status: 500 });
        }
        return Response.json({ stagingKey, uploadUrl: uploadResult.right });
      },
    },
  },
});
