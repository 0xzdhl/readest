import { createFileRoute } from '@tanstack/react-router';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { bookShares } from '@/db/schema';
import { publicMiddleware } from '@/middlewares/public';
import { hashShareToken, isValidShareToken } from '@/libs/shareServer';

/**
 * POST /api/share/$token/download/confirm — analytics ping fired by the
 * landing-page Download button (post-click) and the in-app deeplink hook on
 * successful import. Best-effort: the user-facing action does not depend
 * on this returning 2xx. Lookup is by token_hash so the row stays cheap
 * to find.
 *
 * Uses `publicMiddleware` (bypass-RLS) because the caller is anonymous; the
 * token-hash filter is the access control. Atomic conditional UPDATE
 * ensures concurrent confirms cannot race a read-modify-write and that
 * late-firing pings on expired/revoked shares don't pollute the count.
 */
export const Route = createFileRoute('/api/share/$token/download/confirm')({
  server: {
    middleware: [publicMiddleware],
    handlers: {
      POST: async ({ params, context }) => {
        const { token } = params;
        if (!isValidShareToken(token)) {
          // Silently OK — this is a best-effort beacon, not enforcement.
          return new Response(null, { status: 204 });
        }
        const tokenHash = await hashShareToken(token);
        const now = new Date();
        try {
          await context.tx
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
      },
    },
  },
});
