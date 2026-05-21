import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTheme } from '@/hooks/useTheme';

/**
 * Generic auth-error landing page. Better-auth appends `?error=…` (and
 * sometimes `error_description=…`) to the redirect URL on failure (OAuth
 * grant errors, expired magic-link tokens, etc). We surface what we got
 * so the user has something more diagnostic than a blank page, then
 * auto-redirect to `/auth` after a few seconds.
 */
export const Route = createFileRoute('/auth/error/')({
  component: AuthErrorPage,
});

export function AuthErrorPage() {
  const router = useRouter();
  const [errorDescription, setErrorDescription] = useState<string | null>(null);
  useTheme({ systemUIVisible: false });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const description = params.get('error_description') ?? params.get('error');
    setErrorDescription(description);

    const timer = setTimeout(() => {
      router.navigate({ to: '/auth' });
    }, 3000);

    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className='bg-base-200/50 text-base-content hero h-screen items-center justify-center'>
      <div className='hero-content text-neutral-content text-center'>
        <div className='max-w-md'>
          {errorDescription && (
            <p className='mb-2 text-red-500'>{errorDescription}</p>
          )}
          <p className='mb-5'>You will be redirected to the login page shortly...</p>
          <button
            className='btn btn-primary rounded-xl'
            onClick={() => router.navigate({ to: '/auth' })}
          >
            Go to Login
          </button>
        </div>
      </div>
    </div>
  );
}
