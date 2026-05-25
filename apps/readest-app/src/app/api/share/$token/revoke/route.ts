import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { bookShares } from '@/db/schema';
import { hashShareToken, isValidShareToken } from '@/libs/shareServer';
import { rlsMiddleware } from '@/middlewares/rls';

/**
 * POST /api/share/$token/revoke — owner-only. Sets revoked_at = now() so
 * future landing-page visits and downloads return 410. Presigned URLs
 * already minted (max ~5 min TTL) cannot be canceled — this is a
 * documented soft-revocation grace, not a hard guarantee.
 */
export const Route = createFileRoute('/api/share/$token/revoke')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      POST: async ({ params, context }) => {
        const { user, tx } = context;
        const { token } = params;
        if (!isValidShareToken(token)) {
          return Response.json({ error: 'Invalid share token' }, { status: 400 });
        }
        const tokenHash = await hashShareToken(token);
        // RLS already gates `user_id = current_setting('app.user_id')`, so
        // a wrong-user lookup just returns 0 rows (404). Keep the explicit
        // owner check anyway so the audit trail in the response
        // distinguishes "no such share" from "not yours".
        let share: typeof bookShares.$inferSelect | undefined;
        try {
          const rows = await tx
            .select()
            .from(bookShares)
            .where(eq(bookShares.tokenHash, tokenHash))
            .limit(1);
          share = rows[0];
        } catch (error) {
          console.error('book_shares lookup failed:', error);
          return Response.json({ error: 'Could not look up share' }, { status: 500 });
        }
        if (!share) {
          return Response.json({ error: 'Share not found' }, { status: 404 });
        }
        if (share.userId !== user.id) {
          // RLS would have hidden the row already; this branch is for
          // belt-and-braces clarity if a future refactor ever loosens the
          // policy.
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        }
        // Idempotent: re-revoking returns success without churning the
        // timestamp.
        if (share.revokedAt) {
          return new Response(null, { status: 204 });
        }
        try {
          await tx
            .update(bookShares)
            .set({ revokedAt: new Date() })
            .where(eq(bookShares.id, share.id));
        } catch (error) {
          console.error('book_shares revoke failed:', error);
          return Response.json({ error: 'Could not revoke share' }, { status: 500 });
        }
        return new Response(null, { status: 204 });
      },
    },
  },
});
