import { createFileRoute } from '@tanstack/react-router';
import type { KoSyncProxyPayload } from '@/types/kosync';
import { getBaseUrl } from '@/services/environment';
import { isLanAddress, isRedirectStatus, fetchNoRedirect } from '@/utils/network';

const validEndpoints = [/\/users\/create/, /\/users\/auth/, /\/syncs\/progress/];

// Mirror of the CORS middleware allow-list (src/middlewares/cors.ts). Ideally
// this would be imported from there, but the list is not currently exported;
// it is derived the same way (getBaseUrl() + the Tauri/localhost dev origins).
const allowedOrigins = [
  getBaseUrl(),
  'https://tauri.localhost',
  'http://tauri.localhost',
  'http://localhost:3000',
  'http://localhost:3001',
  'tauri://localhost',
];

// KOReader sync auth headers (case-insensitive) that the proxy is allowed to
// forward upstream. Everything else from the client is dropped to shrink the
// open-relay surface.
const forwardedAuthHeaders = new Set(['x-auth-user', 'x-auth-key', 'authorization']);

/**
 * Per-IP edge rate limit — the REAL control for this unauthenticated open
 * relay (the Origin gate below is only forgeable defense-in-depth). Backed by
 * the Workers Rate Limiting binding `KOSYNC_RATE_LIMITER` (wrangler.jsonc). On
 * runtimes without the binding (local Node / self-host / tests) it is a no-op,
 * since the binding is Cloudflare-edge-specific.
 */
async function isRateLimited(request: Request): Promise<boolean> {
  try {
    const workersModule = await import(/* @vite-ignore */ 'cloudflare:workers');
    const env = (workersModule as unknown as { env?: Record<string, unknown> }).env;
    const limiter = env?.['KOSYNC_RATE_LIMITER'] as
      | { limit: (opts: { key: string }) => Promise<{ success: boolean }> }
      | undefined;
    if (!limiter?.limit) return false;
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await limiter.limit({ key: ip });
    return !success;
  } catch {
    return false;
  }
}

export const Route = createFileRoute('/api/kosync')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Enforce the per-IP rate limit first, so abusive traffic is capped
        // before any work (body parse / outbound subrequest) is done.
        if (await isRateLimited(request)) {
          return Response.json({ error: 'Too many requests' }, { status: 429 });
        }

        // Defense-in-depth ONLY (these headers are trivially forgeable by any
        // non-browser client): block obvious cross-site/scripted browser relay.
        // The real control for this unauthenticated open relay is the edge RATE
        // LIMIT (per-IP) on /api/kosync — see deployment config, not this code.
        // We ALLOW: no Origin (Tauri/native/non-browser) and Sec-Fetch-Site:
        // same-origin (the app's own posts). We REJECT only when an Origin is
        // present and is not in the CORS allow-list.
        const origin = request.headers.get('origin');
        const secFetchSite = request.headers.get('sec-fetch-site');
        if (origin && secFetchSite !== 'same-origin' && !allowedOrigins.includes(origin)) {
          return Response.json({ error: 'Origin not allowed' }, { status: 403 });
        }

        const body: KoSyncProxyPayload = await request.json();
        const { serverUrl, endpoint, method, headers: clientHeaders, body: clientBody } = body;

        if (!serverUrl || !endpoint) {
          return Response.json({ error: 'serverUrl and endpoint are required' }, { status: 400 });
        }

        if (!validEndpoints.some((regex) => regex.test(endpoint))) {
          return Response.json({ error: 'Invalid endpoint' }, { status: 400 });
        }

        try {
          const parsed = new URL(serverUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return Response.json(
              { error: 'Only http and https URLs are allowed' },
              { status: 400 },
            );
          }
        } catch {
          return Response.json({ error: 'Invalid serverUrl' }, { status: 400 });
        }

        if (isLanAddress(serverUrl)) {
          return Response.json(
            { error: 'Requests to private/internal addresses are not allowed' },
            { status: 400 },
          );
        }

        const targetUrl = `${serverUrl.replace(/\/$/, '')}${endpoint}`;

        try {
          // Forward ONLY the KOReader auth headers the sync server needs, plus
          // the proxy's own Accept/Content-Type. Spreading all client headers
          // would widen the relay surface (Cookie, X-Forwarded-*, Host, etc.).
          const outboundHeaders: Record<string, string> = {
            Accept: 'application/vnd.koreader.v1+json',
            'Content-Type': 'application/json',
          };
          for (const [key, value] of Object.entries(clientHeaders ?? {})) {
            if (forwardedAuthHeaders.has(key.toLowerCase())) {
              outboundHeaders[key] = value;
            }
          }

          // SSRF hardening: do not transparently follow redirects. A vetted,
          // public `serverUrl` could 302 to an internal/metadata address that
          // `isLanAddress` never inspected, so refuse any 3xx response (below).
          const response = await fetchNoRedirect(targetUrl, {
            method: method,
            headers: outboundHeaders,
            body: clientBody ? JSON.stringify(clientBody) : null,
          });

          if (isRedirectStatus(response.status)) {
            return Response.json(
              { error: 'Redirects from the sync server are not allowed' },
              { status: 502 },
            );
          }

          const data = await response.text();
          try {
            return Response.json(JSON.parse(data), { status: response.status });
          } catch {
            return new Response(data, { status: response.status });
          }
        } catch (error) {
          console.error('[KOSYNC PROXY] Error:', error);
          const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
          return Response.json(
            { error: 'Proxy request failed', details: errorMessage },
            { status: 500 },
          );
        }
      },
    },
  },
});
