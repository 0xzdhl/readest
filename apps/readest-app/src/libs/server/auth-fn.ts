import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { Auth, Session } from "@/auth/server";
import { withBypassRls, withRls } from "@/db/rls";
import { authMiddleware } from "@/middlewares/auth";

/**
 * Resolve the better-auth session from incoming request headers, or throw a
 * 401 `Response` (suitable for letting TanStack Start serialise back to the
 * client).
 *
 * Extracted so it can be unit-tested in isolation from the
 * `createServerFn().middleware([...])` machinery — that wiring is
 * exercised end-to-end by the API-route tests added in Phase 4+.
 */
export async function resolveSessionOr401(
	auth: Auth,
	headers: Headers,
): Promise<NonNullable<Session>> {
	const session = await auth.api.getSession({ headers });
	if (!session) {
		throw new Response("Unauthorized", { status: 401 });
	}
	return session;
}

/**
 * Middleware: require a valid better-auth session and open a Postgres
 * transaction with `app.user_id` set so per-table RLS policies (see
 * `db/migrations/0001_rls_and_pg_funcs.sql`) allow access to the caller's
 * rows. Injects `{ user, session, tx }` onto `context`.
 */
export const requireAuthMiddleware = createMiddleware({ type: "function" })
	.middleware([authMiddleware])
	.server(async ({ next, context }) => {
    const auth = context.auth;
    const db = 
		const request = getRequest();
		const session = await resolveSessionOr401(auth, request.headers);
		return withRls(session.user.id, (tx) =>
			next({ context: { user: session.user, session, tx } }),
		);
	});

/**
 * Middleware: no session check, RLS bypassed via `app.bypass_rls = 'true'`.
 * Reserved for trusted server-only callers whose authenticity is verified
 * by their own mechanism — e.g. signature-verified webhooks (Stripe, IAP)
 * and admin scripts. The route is responsible for verifying the signature
 * *before* its handler runs.
 */
export const bypassRlsMiddleware = createMiddleware({
	type: "function",
}).server(async ({ next }) => withBypassRls((tx) => next({ context: { tx } })));

/**
 * Protected server function: composes `requireAuthMiddleware`.
 * Use for any RPC that touches per-user business tables.
 */
export const protectedFn = createServerFn().middleware([requireAuthMiddleware]);

/**
 * Service server function: composes `bypassRlsMiddleware`.
 * Use for signature-verified webhooks and admin scripts.
 */
export const serviceFn = createServerFn().middleware([bypassRlsMiddleware]);

/**
 * Public server function: no session, no RLS context. Use for genuinely
 * public endpoints (e.g. the token-based share download path) and rely on
 * the handler's own filter (`WHERE token_hash = $1`) for safety.
 */
export const publicFn = createServerFn();
