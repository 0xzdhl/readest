import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

import { authClient } from '@/auth';

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
export const Route = createFileRoute('/auth/callback/')({
  component: AuthCallback,
});

export function AuthCallback() {
  const router = useRouter();
  const { data, isPending } = authClient.useSession();

  useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');
    if (error) {
      router.navigate({ to: '/auth/error' });
      return;
    }

    // Wait for session to be resolved before forwarding. Without this
    // guard, a slow cookie-read race could navigate to /library while
    // `useSession()` still reports `data: null`, sending the user into
    // an immediate "not authenticated" redirect loop.
    if (isPending) return;

    const next = url.searchParams.get('next') ?? '/library';
    router.navigate({ to: next });
  }, [data, isPending, router]);

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center'>
      <span className='loading loading-infinity loading-xl w-20' />
    </div>
  );
}
