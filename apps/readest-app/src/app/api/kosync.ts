import { createFileRoute } from '@tanstack/react-router';
import type { KoSyncProxyPayload } from '@/types/kosync';
import { isLanAddress } from '@/utils/network';

const validEndpoints = [/\/users\/create/, /\/users\/auth/, /\/syncs\/progress/];

export const Route = createFileRoute('/api/kosync')({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
          const response = await fetch(targetUrl, {
            method: method,
            headers: {
              ...clientHeaders,
              Accept: 'application/vnd.koreader.v1+json',
              'Content-Type': 'application/json',
            },
            body: clientBody ? JSON.stringify(clientBody) : null,
          });

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
