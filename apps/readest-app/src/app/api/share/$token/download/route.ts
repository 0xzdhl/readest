import { createFileRoute } from '@tanstack/react-router';
import { getDownloadSignedUrl } from '@/utils/object';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';
import { publicMiddleware } from '@/middlewares/public';
import { SHARE_PRESIGN_TTL_SECONDS } from '@/services/constants';

/**
 * GET /api/share/$token/download — public, 302 to a short-lived presigned URL.
 *
 * IMPORTANT: this endpoint MUST NOT write to the database. iMessage / WhatsApp /
 * Slack / Twitter unfurlers and browser prefetchers will hit this URL just by
 * previewing a link. Counting them would inflate `download_count` to garbage.
 * Real downloads ping POST /download/confirm separately so the count tracks
 * user intent, not crawler curiosity.
 */
export const Route = createFileRoute('/api/share/$token/download')({
  server: {
    middleware: [publicMiddleware],
    handlers: {
      GET: async ({ params, context }) => {
        const result = await resolveActiveShare(params.token, context.tx);
        if (!result.ok) {
          const { status, body } = rejectionToHttp(result.reason);
          return Response.json(body, { status });
        }
        const { share } = result;
        let url: string;
        try {
          url = await getDownloadSignedUrl(share.bookFileKey, SHARE_PRESIGN_TTL_SECONDS);
        } catch (err) {
          console.error('Share download presign failed:', err);
          return Response.json({ error: 'Could not sign download URL' }, { status: 500 });
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: url,
            // Don't let intermediaries cache the redirect target itself; the
            // presign expires fast but caching the 302 would point future
            // requests at a soon-to-be-dead URL.
            'Cache-Control': 'private, no-store',
          },
        });
      },
    },
  },
});
