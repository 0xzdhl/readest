import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNull, sum } from 'drizzle-orm';
import { files } from '@/db/schema';
import { rlsMiddleware } from '@/middlewares/rls';
import { Effect, Either } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
import { DEDUP_MAX_BYTES, sha256Hex } from '@/libs/server/contentHash';
import { getStoragePlanData, STORAGE_QUOTA_GRACE_BYTES } from '@/libs/server/storage-plan';

const CONTENT_PREFIX = 'content';

export const Route = createFileRoute('/api/storage/finalize')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const { user, tx } = context;
        const body: {
          stagingKey?: string;
          fileName?: string;
          bookHash?: string;
          fileSize?: number;
        } = await request.json();
        const { stagingKey, fileName, bookHash, fileSize } = body;

        if (!stagingKey || !fileName || !fileSize) {
          return Response.json({ error: 'Missing finalize info' }, { status: 400 });
        }
        // The staging object must belong to the caller — never let a client
        // finalize someone else's upload.
        if (!stagingKey.startsWith(`staging/${user.id}/`)) {
          return Response.json({ error: 'Invalid staging key' }, { status: 403 });
        }

        const fileKey = `${user.id}/${fileName}`;
        const deleteStaging = () =>
          runStorageProgram(
            Effect.gen(function* () {
              const storage = yield* ObjectStorage;
              yield* storage
                .deleteObject(stagingKey)
                .pipe(Effect.catchTag('StorageNotFoundError', () => Effect.void));
            }),
          );

        // Confirm the staged object exists (a checksum-mismatched / never-sent
        // PUT leaves nothing to finalize).
        const headStaging = await runStorageProgram(
          Effect.gen(function* () {
            const storage = yield* ObjectStorage;
            return yield* storage.headObject(stagingKey);
          }),
        );
        if (Either.isLeft(headStaging)) {
          return Response.json({ error: 'Staged file not found' }, { status: 404 });
        }

        // Quota gate (logical): real usage = sum of caller's live file sizes.
        const { quota } = getStoragePlanData(user);
        const [usageRow] = await tx
          .select({ total: sum(files.fileSize) })
          .from(files)
          .where(and(eq(files.userId, user.id), isNull(files.deletedAt)));
        const usage = Number(usageRow?.total ?? 0);
        if (usage + fileSize > quota + STORAGE_QUOTA_GRACE_BYTES) {
          await deleteStaging();
          return Response.json({ error: 'Insufficient storage quota', usage }, { status: 403 });
        }

        let contentHash: string | null = null;
        let deduped = false;
        try {
          if (fileSize <= DEDUP_MAX_BYTES) {
            const bytesResult = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.getObjectBytes(stagingKey);
              }),
            );
            if (Either.isLeft(bytesResult)) {
              await deleteStaging();
              return Response.json({ error: 'Could not read staged file' }, { status: 500 });
            }
            const sha = await sha256Hex(bytesResult.right);
            contentHash = sha;
            const contentKey = `${CONTENT_PREFIX}/${sha}`;
            const exists = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.headObject(contentKey);
              }),
            );
            if (Either.isLeft(exists)) {
              // Not present yet → promote staging to the shared content object.
              const copy = await runStorageProgram(
                Effect.gen(function* () {
                  const storage = yield* ObjectStorage;
                  return yield* storage.copyObject(stagingKey, contentKey);
                }),
              );
              if (Either.isLeft(copy)) {
                await deleteStaging();
                return Response.json({ error: 'Could not store file' }, { status: 500 });
              }
            } else {
              deduped = true;
            }
            await deleteStaging();
          } else {
            // Too large to hash in-worker: keep a per-user object, no dedup.
            const copy = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                return yield* storage.copyObject(stagingKey, fileKey);
              }),
            );
            if (Either.isLeft(copy)) {
              await deleteStaging();
              return Response.json({ error: 'Could not store file' }, { status: 500 });
            }
            await deleteStaging();
          }

          await tx
            .insert(files)
            .values({
              userId: user.id,
              bookHash: bookHash ?? null,
              fileKey,
              fileSize,
              contentHash,
            })
            .onConflictDoNothing({ target: files.fileKey });

          return Response.json({ ok: true, contentHash, deduped });
        } catch (error) {
          console.error('finalize failed', error);
          await deleteStaging();
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});
