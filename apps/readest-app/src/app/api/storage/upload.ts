import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNull, sum } from 'drizzle-orm';
import { files } from '@/db/schema';
import { env } from '@/env';
import { getStoragePlanData, STORAGE_QUOTA_GRACE_BYTES } from '@/libs/server/storage-plan';
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
 * POST /api/storage/upload — owner-only. Mints a presigned PUT URL for a new
 * object and (for non-temp uploads) inserts a `files` row tracking quota use.
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
          bookHash?: string;
          replicaKind?: string;
          replicaId?: string;
          temp?: boolean;
        } = await request.json();
        const { fileName, fileSize, bookHash, replicaKind, replicaId, temp = false } = body;

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

        try {
          if (!fileName || !fileSize) {
            return Response.json({ error: 'Missing file info' }, { status: 400 });
          }

          const fileKey = `${user.id}/${fileName}`;

          // Object keys are content-addressed (`<user>/<hash>/<hash>.<ext>`), so
          // if the object already exists in storage the bytes are identical.
          // Probe the store; on a hit, skip re-transmitting the binary (and the
          // quota gate — no new bytes). `headObject` checks the actual object,
          // not just the `files` row, so a tracked-but-missing object (e.g. a
          // prior failed PUT) is NOT skipped. Any non-NotFound error falls
          // through to a normal upload (never skip a genuinely needed PUT).
          const headResult = await runStorageProgram(
            Effect.gen(function* () {
              const storage = yield* ObjectStorage;
              return yield* storage.headObject(fileKey);
            }),
          );
          if (Either.isRight(headResult)) {
            // Ensure a tracking row exists for this user (idempotent), then tell
            // the client not to re-upload.
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

          // `getStoragePlanData` only supplies the plan + purchased quota; the
          // `usage` it returns reads `user.storageUsageBytes`, a counter that is
          // never written, so it cannot enforce cumulative quota. Compute REAL
          // usage in this tx as the sum of the caller's live (non-deleted) file
          // sizes. This auto-reflects deletes with no counter to maintain.
          const { quota } = getStoragePlanData(user);
          const [usageRow] = await tx
            .select({ total: sum(files.fileSize) })
            .from(files)
            .where(and(eq(files.userId, user.id), isNull(files.deletedAt)));
          // `sum()` is string | null (postgres-js preserves bigint precision).
          const usage = Number(usageRow?.total ?? 0);
          if (usage + fileSize > quota + STORAGE_QUOTA_GRACE_BYTES) {
            return Response.json({ error: 'Insufficient storage quota', usage }, { status: 403 });
          }

          // `file_key` is globally UNIQUE, so a plain SELECT-then-INSERT races:
          // two concurrent same-key uploads both miss the SELECT and the second
          // INSERT raises a unique violation that surfaces as a spurious 500.
          // Make the row creation idempotent with `onConflictDoNothing`, then
          // read the (now-guaranteed-present) row back to learn its stored size.
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

          // RLS scopes by `app.user_id`, so the `eq(files.userId, ...)` is
          // technically redundant — kept for read-clarity and to align with
          // the schema's unique key shape.
          const existing = await tx
            .select()
            .from(files)
            .where(and(eq(files.userId, user.id), eq(files.fileKey, fileKey)))
            .limit(1);
          const existingRecord = existing[0];
          // Sign for the size already stored (an existing row may differ from
          // the requested size); fall back to the requested size if the
          // read-back is unexpectedly empty.
          const objSize = existingRecord?.fileSize ?? fileSize;

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
      },
    },
  },
});
