import { createFileRoute } from '@tanstack/react-router';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';
import { runPublic } from '@/libs/server/route-helpers';

/**
 * GET /api/share/$token — public metadata used by the /s landing page.
 * Returns 410 if the share is revoked, expired, or its source file no longer
 * exists. Never returns presigned URLs in this body — covers and downloads
 * are fetched from dedicated endpoints with their own caching semantics.
 *
 * Phase 5: public + bypass-RLS. The share token IS the security boundary;
 * the WHERE token_hash = $1 query is the lookup gate.
 */
export const Route = createFileRoute('/api/share/$token')({
  server: {
    handlers: {
      GET: async ({ params }) =>
        runPublic(async ({ tx }) => {
          const result = await resolveActiveShare(params.token, tx);
          if (!result.ok) {
            const { status, body } = rejectionToHttp(result.reason);
            return Response.json(body, { status });
          }
          const { share } = result;
          return Response.json(
            {
              title: share.bookTitle,
              author: share.bookAuthor,
              format: share.bookFormat,
              size: share.bookSize,
              expiresAt: share.expiresAt,
              hasCover: !!share.coverFileKey,
              hasCfi: !!share.cfi,
              downloadCount: share.downloadCount,
            },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }),
    },
  },
});
