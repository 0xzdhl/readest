import { createFileRoute } from '@tanstack/react-router';
import { AuthError } from '@/components/AuthError';

/**
 * Generic auth-error landing page. Better-auth appends `?error=…` (and
 * sometimes `error_description=…`) to the redirect URL on failure (OAuth
 * grant errors, expired magic-link tokens, etc). We surface what we got
 * so the user has something more diagnostic than a blank page, then
 * auto-redirect to `/auth` after a few seconds.
 */
export const Route = createFileRoute('/auth/error/')({
  component: AuthError,
});