import { createFileRoute } from "@tanstack/react-router";
import { AuthCallback } from "@/components/AuthCallback";

/**
 * OAuth / magic-link callback landing page.
 *
 * Pre-Phase-7 this page hand-parsed supabase's hash-fragment tokens and
 * called `supabase.auth.setSession`. better-auth handles the entire
 * exchange on the server (`/api/auth/callback/<provider>` issues a
 * `Set-Cookie` for web, a `set-auth-token` header on native and redirects
 * to the URL specified in `callbackURL`). So all this component does now
 * is:
 *
 *  1. surface any `?error=…` query the server appended on failure;
 *  2. wait for `useSession()` to settle (the cookie was just set on the
 *     redirect, but the React store needs one render to pick it up);
 *  3. forward to `?next=` (defaulting to `/library`).
 */
export const Route = createFileRoute("/auth/callback/")({
	component: AuthCallback,
});
