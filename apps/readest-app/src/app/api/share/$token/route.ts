import { createFileRoute } from '@tanstack/react-router';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';
import { publicMiddleware } from '@/middlewares/public';

/**
 * GET /api/share/$token — public metadata used by the /s landing page.
 * Returns 410 if the share is revoked, expired, or its source file no longer
 * exists. Never returns presigned URLs in this body — covers and downloads
 * are fetched from dedicated endpoints with their own caching semantics.
 *
 * `publicMiddleware` opens a bypass-RLS tx. The share token IS the security
 * boundary; the `WHERE token_hash = $1` query is the lookup gate.
 */
export const Route = createFileRoute('/api/share/$token')({
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
      },
    },
  },
});
