import { createFileRoute } from '@tanstack/react-router';
import { Effect, Either } from 'effect';
import { ObjectStorage, runStorageProgram } from '@/storage';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';
import { publicMiddleware } from '@/middlewares/public';
import { SHARE_PRESIGN_TTL_SECONDS } from '@/services/constants';

/**
 * GET /api/share/$token/cover — public, same-origin cover image.
 *
 * The bytes are proxied through this endpoint rather than 302-redirecting to
 * the presigned storage URL. The share landing page is cross-origin isolated
 * (COEP: require-corp), and object storage (R2 / MinIO) doesn't send
 * Cross-Origin-Resource-Policy, so a redirected cross-origin <img> is blocked
 * with ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep.
 * Streaming keeps the image same-origin so it always loads. Cached briefly so
 * chat-app preview crawlers don't re-fetch for every recipient; covers aren't
 * sensitive, so max-age is intentional.
 */
export const Route = createFileRoute('/api/share/$token/cover')({
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
        if (!share.coverFileKey) {
          return Response.json({ error: 'No cover for this share' }, { status: 404 });
        }
        const signed = await runStorageProgram(
          Effect.gen(function* () {
            const storage = yield* ObjectStorage;
            return yield* storage.getDownloadSignedUrl(
              share.coverFileKey!,
              SHARE_PRESIGN_TTL_SECONDS,
            );
          }),
        );
        if (Either.isLeft(signed)) {
          console.error('Share cover presign failed:', signed.left);
          return Response.json({ error: 'Could not sign cover URL' }, { status: 500 });
        }

        const upstream = await fetch(signed.right);
        if (!upstream.ok || !upstream.body) {
          console.error('Share cover fetch failed:', upstream.status);
          return Response.json({ error: 'Could not fetch cover' }, { status: 502 });
        }

        const headers = new Headers({
          'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=300',
          // Same-origin response, so the cross-origin-isolated landing page can
          // embed it under COEP: require-corp.
          'Cross-Origin-Resource-Policy': 'same-origin',
        });
        const contentLength = upstream.headers.get('Content-Length');
        if (contentLength) headers.set('Content-Length', contentLength);

        return new Response(upstream.body, { status: 200, headers });
      },
    },
  },
});
