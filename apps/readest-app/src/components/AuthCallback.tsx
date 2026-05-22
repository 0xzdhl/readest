import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { authClient } from '@/auth';

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
