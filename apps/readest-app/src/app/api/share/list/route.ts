import { createFileRoute } from '@tanstack/react-router';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { bookShares } from '@/db/schema';
import { decryptShareToken } from '@/libs/shareServer';
import { rlsMiddleware } from '@/middlewares/rls';
import { getShareBaseUrl } from '@/services/environment';

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
    middleware: [rlsMiddleware],
    handlers: {
      GET: async ({ request, context }) => {
        const { user, tx } = context;
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
          const tieBreak = and(eq(bookShares.createdAt, cursorDate), lt(bookShares.id, cursorId));
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
        const nextCursor = hasMore && last ? `${toIso(last.createdAt)}|${last.id}` : null;

        const shares = await Promise.all(
          page.map(async (row) => ({
            id: row.id,
            // Plaintext token surfaced to the OWNER only. The row stores it
            // encrypted at rest (AAD = token_hash); we decrypt it here. RLS
            // ensures other users cannot read this row; this endpoint is
            // auth-gated and scoped by user_id so a token never leaves the
            // sharer's session. Legacy plaintext rows pass through unchanged.
            token: await decryptShareToken(row.tokenEnc, row.tokenHash),
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
        );

        return Response.json({
          shares,
          nextCursor,
          shareUrlBase: getShareBaseUrl(),
        });
      },
    },
  },
});
