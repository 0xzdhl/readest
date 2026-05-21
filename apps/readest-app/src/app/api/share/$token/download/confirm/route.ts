import { createFileRoute } from '@tanstack/react-router';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { bookShares } from '@/db/schema';
import { runPublic } from '@/libs/server/route-helpers';
import { hashShareToken, isValidShareToken } from '@/libs/shareServer';

/**
 * POST /api/share/$token/download/confirm — analytics ping fired by the
 * landing-page Download button (post-click) and the in-app deeplink hook on
 * successful import. Best-effort: the user-facing action does not depend
 * on this returning 2xx. Lookup is by token_hash so the row stays cheap
 * to find.
 *
 * Phase 5: inlines the legacy `increment_book_share_download(p_token_hash,
 * p_now)` SECURITY DEFINER plpgsql function (from
 * docker/volumes/db/migrations/002_add_book_shares.sql) as a drizzle
 * UPDATE that bumps `download_count` only when the share is still active:
 *
 *   UPDATE book_shares
 *   SET download_count = download_count + 1
 *   WHERE token_hash = $1
 *     AND revoked_at IS NULL
 *     AND expires_at > $2;
 *
 * Uses `runPublic` (bypass-RLS) because the caller is anonymous; the
 * token-hash filter is the access control.
 */
export const Route = createFileRoute('/api/share/$token/download/confirm')({
  server: {
    handlers: {
      POST: async ({ params }) => {
        const { token } = params;
        if (!isValidShareToken(token)) {
          // Silently OK — this is a best-effort beacon, not enforcement.
          return new Response(null, { status: 204 });
        }
        return runPublic(async ({ tx }) => {
          const tokenHash = await hashShareToken(token);
          const now = new Date();
          try {
            // Atomic conditional update — concurrent confirms cannot race a
            // read-modify-write. Only bumps rows still active so late-firing
            // pings on expired/revoked shares don't pollute the count.
            await tx
              .update(bookShares)
              .set({ downloadCount: sql`${bookShares.downloadCount} + 1` })
              .where(
                and(
                  eq(bookShares.tokenHash, tokenHash),
                  isNull(bookShares.revokedAt),
                  gt(bookShares.expiresAt, now),
                ),
              );
          } catch (error) {
            // Best-effort beacon — log but never surface to the caller.
            console.error('download confirm update failed:', error);
          }
          return new Response(null, {
            status: 204,
            headers: { 'Cache-Control': 'private, no-store' },
          });
        });
      },
    },
  },
});
