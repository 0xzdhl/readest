import { createFileRoute } from '@tanstack/react-router';
import { AuthCallback } from '@/components/AuthCallback';

/**
 * OAuth / magic-link callback landing page.
 *
 * Pre-Phase-7 this page hand-parsed supabase's hash-fragment tokens and
 * called `supabase.auth.setSession`. better-auth handles the entire
 * exchange on the server. On the web, `/api/auth/callback/<provider>`
 * sets the browser session cookie before redirecting to the URL specified
 * in `callbackURL`. Native social OAuth does not land on this page; it
 * resumes through the deep-link callback-token bridge in
 * `app/auth/utils/nativeAuth.ts`. So all this component does now is:
 *
 *  1. surface any `?error=…` query the server appended on failure;
 *  2. wait for `useSession()` to settle (the cookie was just set on the
 *     redirect, but the React store needs one render to pick it up);
 *  3. forward to `?next=` (defaulting to `/library`).
 */
export const Route = createFileRoute('/auth/callback/')({
  component: AuthCallback,
});
