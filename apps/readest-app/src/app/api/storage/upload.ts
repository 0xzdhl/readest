import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNull, sum } from 'drizzle-orm';
import { files } from '@/db/schema';
import { env } from '@/env';
import { rlsMiddleware } from '@/middlewares/rls';
import { Effect, Either } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
import { getStoragePlanData, STORAGE_QUOTA_GRACE_BYTES } from '@/libs/server/storage-plan';

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
 * POST /api/storage/upload — owner-only. Mints a presigned PUT URL. Three
 * branches:
 *
 *  1. temp (`temp:true`) — writes into the public bucket with no quota row;
 *     returns `{ uploadUrl, downloadUrl }`.
 *
 *  2. replica (`replicaKind` present, `temp` absent/false) — single-step
 *     content-addressed per-user flow for dictionaries / large sync objects.
 *     Replicas are NOT cross-user deduped. Enforces quota, inserts a `files`
 *     row, returns `{ uploadUrl, fileKey }` (or `{ skipUpload, fileKey }` if
 *     the object already exists).
 *
 *  3. book (fallthrough) — stages bytes to `staging/<user>/<uuid>`; the
 *     `files` row, quota gate, and cross-user dedup happen at POST
 *     /api/storage/finalize. Returns `{ stagingKey, uploadUrl }`.
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
          temp?: boolean;
          bookHash?: string;
          replicaKind?: string;
          replicaId?: string;
        } = await request.json();
        const { fileName, fileSize, temp = false, bookHash, replicaKind, replicaId } = body;

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

        if (replicaKind) {
          // Replica (dictionary / sync) upload: single-step content-addressed
          // per-user flow (replicas are NOT cross-user deduped). Restores the
          // pre-dedup behavior the replica path depends on.
          try {
            if (!fileName || !fileSize) {
              return Response.json({ error: 'Missing file info' }, { status: 400 });
            }
            const fileKey = `${user.id}/${fileName}`;
            const headResult = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.headObject(fileKey);
              }),
            );
            if (Either.isRight(headResult)) {
              await tx
                .insert(files)
                .values({
                  userId: user.id,
                  bookHash: bookHash ?? null,
                  replicaKind: replicaKind ?? null,
                  replicaId: replicaId ?? null,
                  fileKey,
                  fileSize,
                })
                .onConflictDoNothing({ target: files.fileKey });
              return Response.json({ skipUpload: true, fileKey });
            }
            const { quota } = getStoragePlanData(user);
            const [usageRow] = await tx
              .select({ total: sum(files.fileSize) })
              .from(files)
              .where(and(eq(files.userId, user.id), isNull(files.deletedAt)));
            const usage = Number(usageRow?.total ?? 0);
            if (usage + fileSize > quota + STORAGE_QUOTA_GRACE_BYTES) {
              return Response.json({ error: 'Insufficient storage quota', usage }, { status: 403 });
            }
            await tx
              .insert(files)
              .values({
                userId: user.id,
                bookHash: bookHash ?? null,
                replicaKind: replicaKind ?? null,
                replicaId: replicaId ?? null,
                fileKey,
                fileSize,
              })
              .onConflictDoNothing({ target: files.fileKey });
            const existing = await tx
              .select()
              .from(files)
              .where(and(eq(files.userId, user.id), eq(files.fileKey, fileKey)))
              .limit(1);
            const objSize = existing[0]?.fileSize ?? fileSize;
            const uploadResult = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.getUploadSignedUrl(fileKey, objSize, 1800);
              }),
            );
            if (Either.isLeft(uploadResult)) {
              console.error('Error creating presigned post:', uploadResult.left);
              return Response.json({ error: 'Could not create presigned post' }, { status: 500 });
            }
            return Response.json({
              uploadUrl: uploadResult.right,
              fileKey,
              usage: usage + fileSize,
              quota,
            });
          } catch (error) {
            console.error(error);
            return Response.json({ error: 'Something went wrong' }, { status: 500 });
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
