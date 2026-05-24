import { createFileRoute } from "@tanstack/react-router";
import { authMiddleware } from "@/middlewares/auth";

// All `/api/auth/*` traffic is delegated to better-auth's request handler.
// better-auth dispatches each endpoint (sign-in, callbacks, session, etc.)
// internally based on the request URL.
export const Route = createFileRoute("/api/auth/$")({
	server: {
		middleware: [authMiddleware],
		handlers: {
			GET: async ({ request, context }) => {
				const auth = context.auth;
				return await auth.handler(request);
			},
			POST: async ({ request, context }) => {
				const auth = context.auth;
				return await auth.handler(request);
			},
		},
	},
});
