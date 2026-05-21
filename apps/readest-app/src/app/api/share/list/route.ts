import { createFileRoute } from '@tanstack/react-router';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { bookShares } from '@/db/schema';
import { runProtected } from '@/libs/server/route-helpers';
import { SHARE_BASE_URL } from '@/services/constants';

const PAGE_SIZE = 25;

const toIso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

/**
 * GET /api/share/list?cursor=<created_at_iso>|<id>
 *
 * Owner-only. Cursor-paginated list of the caller's shares (active +
 * expired). Cursor mirrors the (created_at DESC, id DESC) order so
 * duplicates and drops are impossible across pages even when rows are
 * added concurrently.
 */
export const Route = createFileRoute('/api/share/list')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        runProtected(request, async ({ user, tx }) => {
          const url = new URL(request.url);
          const rawCursor = url.searchParams.get('cursor');
          let cursorCreatedAt: string | null = null;
          let cursorId: string | null = null;
          if (rawCursor) {
            const sep = rawCursor.indexOf('|');
            if (sep > 0) {
              cursorCreatedAt = rawCursor.slice(0, sep);
              cursorId = rawCursor.slice(sep + 1);
            }
          }

          const where: SQL[] = [eq(bookShares.userId, user.id)];
          if (cursorCreatedAt && cursorId) {
            const cursorDate = new Date(cursorCreatedAt);
            // Strict less-than on (created_at, id) lexicographic — same
            // semantics as the legacy supabase filter:
            //   created_at < c OR (created_at = c AND id < cId)
            const tieBreak = and(
              eq(bookShares.createdAt, cursorDate),
              lt(bookShares.id, cursorId),
            );
            const condition = or(lt(bookShares.createdAt, cursorDate), tieBreak);
            if (condition) where.push(condition);
          }

          let rows: Array<typeof bookShares.$inferSelect>;
          try {
            rows = await tx
              .select()
              .from(bookShares)
              .where(and(...where))
              .orderBy(desc(bookShares.createdAt), desc(bookShares.id))
              .limit(PAGE_SIZE + 1);
          } catch (error) {
            console.error('book_shares list failed:', error);
            return Response.json({ error: 'Could not list shares' }, { status: 500 });
          }

          const hasMore = rows.length > PAGE_SIZE;
          const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
          const last = page.length > 0 ? page[page.length - 1] : null;
          const nextCursor =
            hasMore && last ? `${toIso(last.createdAt)}|${last.id}` : null;

          return Response.json({
            shares: page.map((row) => ({
              id: row.id,
              // Plaintext token surfaced to the OWNER only. RLS ensures
              // other users cannot read this row; this endpoint is
              // auth-gated and scoped by user_id so a token never leaves
              // the sharer's session.
              token: row.token,
              bookHash: row.bookHash,
              title: row.bookTitle,
              author: row.bookAuthor,
              format: row.bookFormat,
              size: row.bookSize,
              hasCfi: !!row.cfi,
              expiresAt: toIso(row.expiresAt),
              revokedAt: toIso(row.revokedAt),
              downloadCount: row.downloadCount,
              createdAt: toIso(row.createdAt),
            })),
            nextCursor,
            shareUrlBase: SHARE_BASE_URL,
          });
        }),
    },
  },
});
