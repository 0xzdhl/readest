import { useRouter } from '@tanstack/react-router';
import clsx from 'clsx';
import { useState } from 'react';
import { IoArrowBack } from 'react-icons/io5';
import AuthLayout from '@/components/AuthLayout';
import { authClient } from '@/auth';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * Password-reset completion page. The user lands here via a link from the
 * password-reset email (`/auth/recovery?token=…`). We collect the new
 * password and POST it to better-auth's `auth.resetPassword({ newPassword,
 * token })` endpoint. On success, redirect back to `/auth` so the user can
 * sign in with the new credentials.
 */
export function ResetPassword() {
  const _ = useTranslation();
  const router = useRouter();

  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');
    setErrorMsg('');

    // The reset-token is appended to the email link by better-auth's
    // `sendResetPassword` callback (see auth/server.ts). It carries the
    // proof that this browser is the same one that requested the reset.
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    if (!token) {
      setErrorMsg(_('Missing or invalid reset token'));
      setLoading(false);
      return;
    }

    try {
      const { error } = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      if (error) {
        setErrorMsg(error.message ?? _('Failed to reset password'));
        return;
      }
      setMessage(_('Your password has been updated'));
      setTimeout(() => router.navigate({ to: '/auth' }), 1200);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : _('Failed to reset password'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className='mb-6 flex flex-col gap-1.5'>
        <h1 className='text-base-content text-lg font-semibold tracking-tight'>
          {_('New Password')}
        </h1>
        <p className='text-base-content/70 text-sm leading-relaxed'>
          {_('Choose a new password to finish resetting your account.')}
        </p>
      </div>
      <form onSubmit={handleSubmit} className='flex w-full flex-col gap-4'>
        <div className='flex flex-col gap-2'>
          <label htmlFor='new-password' className='text-base-content/75 text-xs'>
            {_('New Password')}
          </label>
          <input
            id='new-password'
            type='password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={_('Your new password')}
            required
            minLength={8}
            disabled={loading}
            autoComplete='new-password'
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
          disabled={loading || !password}
          className={clsx(
            'btn btn-primary h-auto min-h-0 rounded-lg p-2.5 text-sm font-medium',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {loading ? _('Updating password ...') : _('Update password')}
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
    </AuthLayout>
  );
}
