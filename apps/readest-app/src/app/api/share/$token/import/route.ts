import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNotNull } from 'drizzle-orm';
import { setRlsBypass } from '@/db/rls';
import { files } from '@/db/schema';
import { rlsMiddleware } from '@/middlewares/rls';
import { getStoragePlanData, STORAGE_QUOTA_GRACE_BYTES } from '@/libs/server/storage-plan';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';
import { Effect, Either } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';

const isCoverKey = (fileKey: string): boolean => /\.(png|jpe?g|webp|gif)$/i.test(fileKey);

/**
 * POST /api/share/$token/import — recipient-side library import. Auth required.
 *
 * Strategy: R2 server-side byte-copy.
 * The existing `files` table consumers (stats / purge / delete / download)
 * all assume `file_key` starts with the row's `user_id`. A reference-based
 * import would silently break those invariants, so we copy the bytes into
 * the recipient's namespace instead. R2 server-side copy is one API call
 * and incurs no egress.
 *
 * RLS scoping: this route needs both the sharer's data (book_shares + files
 * rows owned by the sharer) AND the recipient's data (recipient's existing
 * files rows). `rlsMiddleware` opens the tx with `app.user_id = recipient`;
 * we flip `app.bypass_rls = true` at the very start with `setRlsBypass(tx)`
 * so the cross-user reads inside `resolveActiveShare` succeed. Every
 * recipient write below uses an explicit `eq(files.userId, user.id)` or
 * `eq(files.id, ...)` filter, so RLS bypass does not widen the blast radius
 * — the route's own filters are the security boundary for this single
 * cross-user operation.
 *
 * Idempotent: if the recipient already has a non-deleted `files` row for the
 * same `book_hash`, we return their existing fileId with `alreadyOwned: true`
 * and skip the copy. Saves egress on repeated imports.
 */
export const Route = createFileRoute('/api/share/$token/import')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      POST: async ({ params, context }) => {
        const { user, tx } = context;
        const { token: shareToken } = params;

        // Flip the tx into bypass mode for the rest of this handler — see
        // route docstring for why this is safe given the explicit filters
        // on every recipient write below.
        await setRlsBypass(tx);

        const result = await resolveActiveShare(shareToken, tx);
        if (!result.ok) {
          const { status, body } = rejectionToHttp(result.reason);
          return Response.json(body, { status });
        }
        const { share } = result;

        // Self-imports are no-ops; redirect the user to their own copy
        // without burning a copy operation.
        if (share.userId === user.id) {
          const own = await tx
            .select({ id: files.id, bookHash: files.bookHash, fileKey: files.fileKey })
            .from(files)
            .where(and(eq(files.userId, user.id), eq(files.bookHash, share.bookHash)));
          const ownBook = own.find((f) => !isCoverKey(f.fileKey));
          if (ownBook) {
            return Response.json({
              fileId: ownBook.id,
              alreadyOwned: true,
              bookHash: share.bookHash,
              cfi: share.cfi,
            });
          }
        }

        // Idempotency: live recipient row first.
        const liveRows = await tx
          .select({ id: files.id, fileKey: files.fileKey })
          .from(files)
          .where(and(eq(files.userId, user.id), eq(files.bookHash, share.bookHash)));
        const liveBook = liveRows.find((f) => !isCoverKey(f.fileKey));
        if (liveBook) {
          return Response.json({
            fileId: liveBook.id,
            alreadyOwned: true,
            bookHash: share.bookHash,
            cfi: share.cfi,
          });
        }

        // Tombstoned recipient row: with bypass already set we can SELECT
        // soft-deleted rows directly (the files RLS SELECT policy normally
        // hides them from the owner). Restore the row instead of inserting
        // a duplicate, which would collide on the globally unique file_key.
        const deletedRows = await tx
          .select({ id: files.id, fileKey: files.fileKey })
          .from(files)
          .where(
            and(
              eq(files.userId, user.id),
              eq(files.bookHash, share.bookHash),
              isNotNull(files.deletedAt),
            ),
          );
        const deletedRow = deletedRows.find((f) => !isCoverKey(f.fileKey));
        if (deletedRow) {
          try {
            await tx
              .update(files)
              .set({ deletedAt: null, updatedAt: new Date() })
              .where(eq(files.id, deletedRow.id));
          } catch (error) {
            console.error('Share import restore-deleted-row failed:', error);
            return Response.json({ error: 'Could not restore book' }, { status: 500 });
          }
          return Response.json({
            fileId: deletedRow.id,
            alreadyOwned: true,
            bookHash: share.bookHash,
            cfi: share.cfi,
          });
        }

        // Quota check before doing any byte-copy work.
        const { usage, quota } = getStoragePlanData(user);
        if (usage + share.bookSize > quota + STORAGE_QUOTA_GRACE_BYTES) {
          return Response.json(
            { error: 'Insufficient storage quota', code: 'quota_exceeded', usage, quota },
            { status: 402 },
          );
        }

        // Translate the sharer's file_keys into the recipient's namespace by
        // swapping the leading user-id prefix. Convention: file_key looks
        // like `${userId}/Readest/Book/{hash}/{filename}`.
        const sharerPrefix = `${share.userId}/`;
        const recipientPrefix = `${user.id}/`;
        const remap = (sourceKey: string): string | null => {
          if (!sourceKey.startsWith(sharerPrefix)) return null;
          return recipientPrefix + sourceKey.slice(sharerPrefix.length);
        };

        const destBookKey = remap(share.bookFileKey);
        if (!destBookKey) {
          console.error(
            'Share import: source key does not start with sharer user id',
            share.bookFileKey,
          );
          return Response.json({ error: 'Cannot remap shared file' }, { status: 500 });
        }
        // Insert destination row first (to grab a stable id), then copy
        // bytes, then mark the row clean. On copy failure we soft-delete
        // the row so the user's library doesn't show a phantom book.
        let insertedBookId: string;
        try {
          const inserted = await tx
            .insert(files)
            .values({
              userId: user.id,
              bookHash: share.bookHash,
              fileKey: destBookKey,
              fileSize: share.bookSize,
            })
            .returning({ id: files.id });
          const first = inserted[0];
          if (!first) {
            return Response.json({ error: 'Could not import book' }, { status: 500 });
          }
          insertedBookId = first.id;
        } catch (error) {
          console.error('Share import insert book row failed:', error);
          return Response.json({ error: 'Could not import book' }, { status: 500 });
        }

        const copyResult = await runStorageProgram(
          Effect.gen(function* () {
            const storage = yield* ObjectStorage;
            yield* storage.copyObject(share.bookFileKey, destBookKey);
          }),
        );
        if (Either.isLeft(copyResult)) {
          // Soft-delete the orphan row in either error case.
          try {
            await tx
              .update(files)
              .set({ deletedAt: new Date() })
              .where(eq(files.id, insertedBookId));
          } catch (cleanupErr) {
            console.error('Share import cleanup failed:', cleanupErr);
          }

          if (copyResult.left._tag === 'StorageNotFoundError') {
            return Response.json(
              { error: 'Shared book is no longer available', code: 'source_deleted' },
              { status: 410 },
            );
          }
          console.error('Share import book copy failed:', copyResult.left);
          return Response.json({ error: 'Could not import book' }, { status: 500 });
        }

        // Cover is best-effort. A failure here doesn't fail the import —
        // the recipient still gets the book; the cover will simply be
        // missing in their library until they refresh from elsewhere.
        if (share.coverFileKey) {
          const destCoverKey = remap(share.coverFileKey);
          if (destCoverKey) {
            const coverResult = await runStorageProgram(
              Effect.gen(function* () {
                const storage = yield* ObjectStorage;
                yield* storage.copyObject(share.coverFileKey!, destCoverKey);
              }),
            );
            if (Either.isRight(coverResult)) {
              try {
                await tx.insert(files).values({
                  userId: user.id,
                  bookHash: share.bookHash,
                  fileKey: destCoverKey,
                  fileSize: 0,
                });
              } catch (err) {
                // Cover is best-effort; a DB insert failure is non-fatal.
                console.error('Share import cover row insert failed (non-fatal):', err);
              }
            } else {
              // Cover is best-effort. NotFound or any other error is non-fatal.
              console.error('Share import cover copy failed (non-fatal):', coverResult.left);
            }
          }
        }

        return Response.json({
          fileId: insertedBookId,
          alreadyOwned: false,
          bookHash: share.bookHash,
          cfi: share.cfi,
        });
      },
    },
  },
});
