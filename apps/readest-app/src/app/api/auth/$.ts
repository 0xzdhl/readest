import { createFileRoute } from '@tanstack/react-router';
import { auth } from '@/auth/server';

const handler = ({ request }: { request: Request }): Promise<Response> => auth.handler(request);

// All `/api/auth/*` traffic is delegated to better-auth's request handler.
// better-auth dispatches each endpoint (sign-in, callbacks, session, etc.)
// internally based on the request URL.
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
      PUT: handler,
      DELETE: handler,
      PATCH: handler,
      OPTIONS: handler,
    },
  },
});
