import { createFileRoute } from '@tanstack/react-router';
import { renderShareOgImage } from './render';

/**
 * GET /api/share/$token/og.png — server-rendered branded card for chat
 * unfurls. Stable URL, cached for an hour: unfurlers (iMessage, WhatsApp,
 * Twitter, Slack) cache aggressively, so a short-lived signed cover URL would
 * break previews after expiry. By proxying through this route we get a stable
 * URL even though the underlying R2 object is presigned per-fetch.
 *
 * JSX/Satori/Resvg rendering lives in the sibling `render.tsx` so this thin
 * route file stays serializable and the heavy WASM module is dynamically
 * loaded only when an OG fetch actually arrives (cf. CF Workers cold start).
 *
 * Public endpoint — no auth gate. `renderShareOgImage` calls
 * `resolveActiveShare` which opens its own `withBypassRls` tx (the token
 * itself is the security boundary).
 */
export const Route = createFileRoute('/api/share/$token/og.png')({
  server: {
    handlers: {
      GET: async ({ params }) => renderShareOgImage(params.token),
    },
  },
});
