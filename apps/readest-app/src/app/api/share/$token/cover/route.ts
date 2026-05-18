import { createFileRoute } from '@tanstack/react-router';
import { getDownloadSignedUrl } from '@/utils/object';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';
import { SHARE_PRESIGN_TTL_SECONDS } from '@/services/constants';

// GET /api/share/$token/cover — public 302 redirect to a presigned cover URL.
// Cached briefly so chat-app preview crawlers don't re-fetch the same image
// for every recipient. Covers aren't sensitive; max-age is intentional.
export const Route = createFileRoute('/api/share/$token/cover')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { token } = params;

        const result = await resolveActiveShare(token);
        if (!result.ok) {
          const { status, body } = rejectionToHttp(result.reason);
          return Response.json(body, { status });
        }
        const { share } = result;

        if (!share.coverFileKey) {
          return Response.json({ error: 'No cover for this share' }, { status: 404 });
        }

        let url: string;
        try {
          url = await getDownloadSignedUrl(share.coverFileKey, SHARE_PRESIGN_TTL_SECONDS);
        } catch (err) {
          console.error('Share cover presign failed:', err);
          return Response.json({ error: 'Could not sign cover URL' }, { status: 500 });
        }

        return new Response(null, {
          status: 302,
          headers: {
            Location: url,
            'Cache-Control': 'public, max-age=300',
          },
        });
      },
    },
  },
});
