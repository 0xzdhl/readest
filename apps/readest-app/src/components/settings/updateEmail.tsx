import { useRouter } from '@tanstack/react-router';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { IoArrowBack } from 'react-icons/io5';
import AuthLayout from '@/components/AuthLayout';
import { authClient } from '@/auth';
import { useAuth } from '@/context/AuthContext';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * Email-change page. Pre-Phase-7 this called `supabase.auth.updateUser({
 * email })`. better-auth's equivalent for an email *change* (as opposed to
 * email update of arbitrary profile fields) is `authClient.changeEmail`,
 * which fires a confirmation link to the *new* address; only when the user
 * clicks that link does the change take effect.
 */
export function UpdateEmail() {
  const _ = useTranslation();
  const router = useRouter();
  const { user } = useAuth();

  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!user) {
      router.navigate({ to: '/auth' });
    }
  }, [user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');
    setErrorMsg('');

    try {
      const { error } = await authClient.changeEmail({
        newEmail: email,
        // Redirect back to the library once the user confirms the new
        // address from their inbox.
        callbackURL: '/library',
      });
      if (error) {
        setErrorMsg(error.message ?? _('Failed to update email'));
        return;
      }
      setMessage(
        _(
          'Confirmation email sent! Please check your old and new email addresses to confirm the change.',
        ),
      );
      setEmail('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : _('Failed to update email'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className='mb-6 flex flex-col gap-1.5'>
        <h1 className='text-base-content text-lg font-semibold tracking-tight'>{_('New Email')}</h1>
        <p className='text-base-content/70 text-sm leading-relaxed'>
          {_('Update the email address used to sign in to your account.')}
        </p>
      </div>
      <form onSubmit={handleSubmit} className='flex w-full flex-col gap-4'>
        <div className='flex flex-col gap-2'>
          <label htmlFor='email' className='text-base-content/75 text-xs'>
            {_('New Email')}
          </label>
          <input
            id='email'
            type='email'
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={_('Your new email')}
            required
            disabled={loading}
            autoComplete='email'
            className={clsx(
              'eink-bordered bg-base-100 border-base-300 text-base-content rounded-lg border p-2.5 text-sm',
              'focus:ring-primary/40 focus:outline-none focus:ring-2',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          />
        </div>

        {errorMsg && <div className='text-error text-sm'>{errorMsg}</div>}
        {message && <div className='text-base-content text-sm'>{message}</div>}

        <button
          type='submit'
          disabled={loading || !email}
          className={clsx(
            'btn btn-primary h-auto min-h-0 rounded-lg p-2.5 text-sm font-medium',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {loading ? _('Updating email ...') : _('Update email')}
        </button>

        <button
          type='button'
          onClick={() => router.history.back()}
          className={clsx(
            'eink-bordered flex items-center justify-center gap-2 rounded-lg border p-2.5 text-sm',
            'bg-base-100 border-base-300 hover:bg-base-200 transition-colors duration-150',
            'focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2',
          )}
        >
          <IoArrowBack className='h-4 w-4' aria-hidden='true' />
          {_('Back')}
        </button>
      </form>

      {user?.email && (
        <div className='text-base-content/70 mt-6 text-center text-sm'>
          {_('Current email')}: {user.email}
        </div>
      )}
    </AuthLayout>
  );
}
