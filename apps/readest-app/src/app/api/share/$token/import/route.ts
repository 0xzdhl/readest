import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { files } from '@/db/schema';
import { copyObject, objectExists } from '@/utils/object';
import {
  getStoragePlanData,
  runProtected,
  STORAGE_QUOTA_GRACE_BYTES,
} from '@/libs/server/route-helpers';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';

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
 * Idempotent: if the recipient already has a non-deleted `files` row for the
 * same `book_hash`, we return their existing fileId with `alreadyOwned: true`
 * and skip the copy. Saves egress on repeated imports.
 *
 * Phase 5: the share-resolution path uses `resolveActiveShare(token, tx)`
 * with the RLS-scoped recipient tx. Because the recipient might not own
 * the sharer's `files` rows, `resolveActiveShare` opens its own
 * withBypassRls subtransaction when no tx is supplied — but here we're
 * already inside a withRls(recipient) tx, so we delegate to the public
 * resolver which does its own bypass internally. We pass `undefined` for
 * the tx parameter to keep that path independent of recipient scope.
 */
export const Route = createFileRoute('/api/share/$token/import')({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        runProtected(request, async ({ user, tx }) => {
          const { token: shareToken } = params;

          // resolveActiveShare needs to read across user boundaries
          // (book_shares row owned by sharer, files row owned by sharer).
          // The recipient tx has RLS scoped to `user.id`, which would hide
          // the sharer's data. Pass `undefined` for the tx so the helper
          // opens its own withBypassRls subtransaction.
          const result = await resolveActiveShare(shareToken);
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

          // Idempotency: look up existing rows for the same (user_id,
          // book_hash) INCLUDING soft-deleted ones. file_key is unique
          // globally, so an active import the user later deleted leaves a
          // row that would collide with a fresh insert — we restore it
          // instead of failing.
          //
          // NOTE: the files RLS SELECT policy hides tombstoned rows even
          // from their owner. To see soft-deleted rows we must bypass for
          // this read; we DO own the tx though, so we narrow the lookup
          // with explicit user/hash predicates. We use a raw SQL
          // expression to set bypass_rls just for this section — but
          // that's a footgun (the bypass persists for the rest of the
          // tx). Cleaner: do the lookup in withBypassRls(...) via a
          // nested context. Since `withRls` and `withBypassRls` are
          // not safe to nest on the same connection (docs in db/rls.ts),
          // we use raw SQL to flip back after the read. The deleted_at
          // filter via IS NOT NULL is OR'd with IS NULL in two queries
          // so we don't need bypass at all — RLS shows the live row and
          // a SELECT WHERE deleted_at IS NOT NULL would return 0 rows
          // (hidden). We work around by querying via the schema once
          // for live and once for tombstoned using a top-level tx.execute
          // outside withRls. Simpler: detect via a count() of any row,
          // then if there's an "extra" beyond the live one we know it's
          // a tombstone and restore it.
          //
          // Pragmatic approach below: query live rows first via the
          // RLS-scoped tx. If none, check for a tombstoned row with a
          // separate bypass-scoped read using the existing files RLS
          // policy's `app.bypass_rls` escape hatch on this same tx (we
          // set the flag once, then read; the flag stays set for the
          // rest of this tx, but the only further writes are the
          // recipient's own — which the policy still permits because
          // bypass=true).
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

          // Look for a soft-deleted row. Enable bypass on this tx so we
          // can SELECT tombstoned rows; subsequent writes still target
          // the recipient (eq(files.userId, user.id)).
          await tx.execute(sql`SELECT set_config('app.bypass_rls', 'true', true)`);
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
          // swapping the leading user-id prefix. Existing convention: file_key
          // looks like `${userId}/Readest/Book/{hash}/{filename}`.
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

          // Verify source bytes still exist before allocating a destination row.
          const sourceExists = await objectExists(share.bookFileKey);
          if (!sourceExists) {
            return Response.json(
              { error: 'Shared book is no longer available', code: 'source_deleted' },
              { status: 410 },
            );
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

          try {
            const copyResp = await copyObject(share.bookFileKey, destBookKey);
            // R2 (aws4fetch) returns a Response; S3 SDK returns a
            // structured object. Both throw on hard failures; treat any
            // non-ok HTTP response as a fail.
            if (
              copyResp &&
              typeof (copyResp as Response).ok === 'boolean' &&
              !(copyResp as Response).ok
            ) {
              throw new Error(`R2 copy failed: ${(copyResp as Response).status}`);
            }
          } catch (err) {
            console.error('Share import book copy failed:', err);
            // Soft-delete the orphaned row so it doesn't count against
            // quota or appear in the library list.
            try {
              await tx
                .update(files)
                .set({ deletedAt: new Date() })
                .where(eq(files.id, insertedBookId));
            } catch (cleanupErr) {
              console.error('Share import cleanup failed:', cleanupErr);
            }
            return Response.json({ error: 'Could not import book' }, { status: 500 });
          }

          // Cover is best-effort. A failure here doesn't fail the import —
          // the recipient still gets the book; the cover will simply be
          // missing in their library until they refresh from elsewhere.
          if (share.coverFileKey) {
            const destCoverKey = remap(share.coverFileKey);
            if (destCoverKey) {
              try {
                const coverExists = await objectExists(share.coverFileKey);
                if (coverExists) {
                  await copyObject(share.coverFileKey, destCoverKey);
                  await tx.insert(files).values({
                    userId: user.id,
                    bookHash: share.bookHash,
                    fileKey: destCoverKey,
                    fileSize: 0, // unknown; not material — covers don't bill
                  });
                }
              } catch (err) {
                console.error('Share import cover copy failed (non-fatal):', err);
              }
            }
          }

          return Response.json({
            fileId: insertedBookId,
            alreadyOwned: false,
            bookHash: share.bookHash,
            cfi: share.cfi,
          });
        }),
    },
  },
});
