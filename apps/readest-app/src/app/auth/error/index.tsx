import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTheme } from '@/hooks/useTheme';

export const Route = createFileRoute('/auth/error/')({
  component: AuthErrorPage,
});

function AuthErrorPage() {
  const router = useRouter();
  useTheme({ systemUIVisible: false });

  useEffect(() => {
    const timer = setTimeout(() => {
      router.navigate({ to: '/auth' });
    }, 3000);

    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className='bg-base-200/50 text-base-content hero h-screen items-center justify-center'>
      <div className='hero-content text-neutral-content text-center'>
        <div className='max-w-md'>
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
