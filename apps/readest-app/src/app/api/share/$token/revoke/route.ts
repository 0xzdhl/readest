import { createFileRoute } from '@tanstack/react-router';
import { createSupabaseAdminClient } from '@/utils/supabase';
import { validateUserAndToken } from '@/utils/access';
import { hashShareToken, isValidShareToken } from '@/libs/shareServer';

// POST /api/share/$token/revoke — owner-only. Sets revoked_at = now() so
// future landing-page visits and downloads return 410. Note: presigned URLs
// already minted (max ~5 min TTL) cannot be canceled — this is a documented
// soft-revocation grace, not a hard guarantee.
export const Route = createFileRoute('/api/share/$token/revoke')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { token } = params;

        if (!isValidShareToken(token)) {
          return Response.json({ error: 'Invalid share token' }, { status: 400 });
        }

        const { user, token: jwt } = await validateUserAndToken(
          request.headers.get('authorization'),
        );
        if (!user || !jwt) {
          return Response.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const supabase = createSupabaseAdminClient();
        const tokenHash = await hashShareToken(token);

        // RLS would suffice, but we use the admin client elsewhere; gate
        // explicitly on user_id to keep the contract obvious to readers.
        const { data: share, error: lookupError } = await supabase
          .from('book_shares')
          .select('id, user_id, revoked_at')
          .eq('token_hash', tokenHash)
          .maybeSingle();

        if (lookupError) {
          console.error('book_shares lookup failed:', lookupError);
          return Response.json({ error: 'Could not look up share' }, { status: 500 });
        }
        if (!share) {
          return Response.json({ error: 'Share not found' }, { status: 404 });
        }
        if (share.user_id !== user.id) {
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        }
        // Idempotent: re-revoking returns success without churning the timestamp.
        if (share.revoked_at) {
          return new Response(null, { status: 204 });
        }

        const { error: updateError } = await supabase
          .from('book_shares')
          .update({ revoked_at: new Date().toISOString() })
          .eq('id', share.id);
        if (updateError) {
          console.error('book_shares revoke failed:', updateError);
          return Response.json({ error: 'Could not revoke share' }, { status: 500 });
        }

        return new Response(null, { status: 204 });
      },
    },
  },
});
