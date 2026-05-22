import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { authClient } from '@/auth';
import { useTranslation } from '@/hooks/useTranslation';
import { useThemeStore } from '@/store/themeStore';

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
  const { isDarkMode } = useThemeStore();

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
    <div className='flex min-h-screen items-center justify-center'>
      <div className='w-full max-w-md p-8'>
        <form onSubmit={handleSubmit} className='space-y-6'>
          <div className='space-y-1'>
            <label
              htmlFor='new-password'
              className={`block text-sm font-normal ${
                isDarkMode ? 'text-gray-300' : 'text-gray-400'
              }`}
            >
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
              className={`w-full rounded-md border bg-transparent px-4 py-2.5 focus:outline-none focus:ring-1 disabled:cursor-not-allowed disabled:opacity-50 ${
                isDarkMode ? 'text-gray-300' : 'text-gray-400'
              }`}
            />
          </div>

          {errorMsg && <div className='text-sm text-red-500'>{errorMsg}</div>}
          {message && <div className='text-base-content text-sm'>{message}</div>}

          <button
            type='submit'
            disabled={loading || !password}
            className='w-full rounded-md bg-green-400 px-4 py-2.5 font-medium text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed'
          >
            {loading ? _('Updating password ...') : _('Update password')}
          </button>

          <button
            type='button'
            onClick={() => router.history.back()}
            className={`mt-2 flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2.5 text-sm transition-colors ${
              isDarkMode
                ? 'border-gray-600 text-gray-300 hover:bg-gray-800'
                : 'border-gray-300 text-gray-700 hover:bg-gray-100'
            }`}
          >
            <svg
              xmlns='http://www.w3.org/2000/svg'
              className='h-4 w-4'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M15 19l-7-7 7-7'
              />
            </svg>
            {_('Back')}
          </button>
        </form>
      </div>
    </div>
  );
}
