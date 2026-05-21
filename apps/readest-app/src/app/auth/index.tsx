import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { z } from 'zod';

import { FcGoogle } from 'react-icons/fc';
import { FaApple, FaGithub, FaDiscord } from 'react-icons/fa';
import { IoArrowBack } from 'react-icons/io5';

import { authClient } from '@/auth';
import { useEnv } from '@/context/EnvContext';
import { useTheme } from '@/hooks/useTheme';
import { useThemeStore } from '@/store/themeStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useTrafficLightStore } from '@/store/trafficLightStore';
import { getBaseUrl, isTauriAppPlatform } from '@/services/environment';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { start, cancel, onUrl, onInvalidUrl } from '@fabianlars/tauri-plugin-oauth';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { readPublicFlag } from '@/utils/publicEnv';
import { getAppleIdAuth, type Scope } from './utils/appleIdAuth';
import {
  authWithCustomTab,
  authWithSafari,
  storeBearerFromCallback,
} from './utils/nativeAuth';
import WindowButtons from '@/components/WindowButtons';

type OAuthProvider = 'google' | 'apple' | 'github' | 'discord';

interface SingleInstancePayload {
  args: string[];
  cwd: string;
}

interface ProviderLoginProp {
  provider: OAuthProvider;
  handleSignIn: (provider: OAuthProvider) => void;
  Icon: React.ElementType;
  label: string;
}

const WEB_AUTH_CALLBACK = `${getBaseUrl()}/auth/callback`;
const DEEPLINK_CALLBACK = 'readest://auth-callback';
const USE_APPLE_SIGN_IN = readPublicFlag('VITE_USE_APPLE_SIGN_IN');

const authSearchSchema = z.object({
  redirect: z.string().default('/library').catch('/library'),
});

const ProviderLogin: React.FC<ProviderLoginProp> = ({ provider, handleSignIn, Icon, label }) => {
  return (
    <button
      onClick={() => handleSignIn(provider)}
      className={clsx(
        'mb-2 flex w-64 items-center justify-center rounded border p-2.5',
        'bg-base-100 border-base-300 hover:bg-base-200 shadow-sm transition',
      )}
    >
      <Icon />
      <span className='text-base-content/75 px-2 text-sm'>{label}</span>
    </button>
  );
};

export const Route = createFileRoute('/auth/')({
  validateSearch: authSearchSchema,
  component: AuthPage,
});

type Mode = 'signin' | 'signup' | 'forgot';

export function AuthPage() {
  const _ = useTranslation();
  const router = useRouter();
  const { envConfig, appService } = useEnv();
  const { safeAreaInsets, isRoundedWindow } = useThemeStore();
  const { isTrafficLightVisible } = useTrafficLightStore();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const [port, setPort] = useState<number | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [mode, setMode] = useState<Mode>('signin');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const isOAuthServerRunning = useRef(false);
  const useCustomeOAuth = useRef(false);
  const headerRef = useRef<HTMLDivElement>(null);

  useTheme({ systemUIVisible: false });

  // Magic-link is a web-only convenience — better-auth's bearer flow on
  // native lacks the email-confirmation round-trip the magic-link plugin
  // assumes, and we don't expose Tauri's `mailto:` UX for it. Hide it on
  // the desktop / mobile apps; cookie sessions on the web get the option.
  const showMagicLink = !isTauriAppPlatform();

  const getTauriRedirectTo = (isOAuth: boolean) => {
    if (
      !useCustomeOAuth.current &&
      (process.env['NODE_ENV'] === 'production' ||
        appService?.isMobileApp ||
        USE_APPLE_SIGN_IN)
    ) {
      if (appService?.isMobileApp) {
        return isOAuth ? DEEPLINK_CALLBACK : WEB_AUTH_CALLBACK;
      }
      return DEEPLINK_CALLBACK;
    }
    return `http://localhost:${port}`;
  };

  const getWebRedirectTo = () => {
    return process.env['NODE_ENV'] === 'production'
      ? WEB_AUTH_CALLBACK
      : `${window.location.origin}/auth/callback`;
  };

  const handleOAuthUrl = async (url: string) => {
    storeBearerFromCallback(url);
    router.navigate({ to: '/library' });
  };

  const tauriSignInApple = async () => {
    if (appService?.isIOSApp || USE_APPLE_SIGN_IN) {
      // Generate a nonce for the Apple ID token request. Apple echoes
      // the nonce back on the JWT's `nonce` claim; better-auth's
      // id-token verifier checks the match to defend against replay.
      const nonce =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '';
      const request = {
        scope: ['fullName', 'email'] as Scope[],
        nonce,
      };
      try {
        const appleAuthResponse = await getAppleIdAuth(request);
        if (appleAuthResponse.identityToken) {
          const { error } = await authClient.signIn.social({
            provider: 'apple',
            idToken: {
              token: appleAuthResponse.identityToken,
              nonce,
            },
          });
          if (error) {
            console.error('Authentication error:', error);
            setErrorMsg(error.message ?? _('Sign-in failed'));
          }
        }
      } catch (err) {
        console.error('Authentication error:', err);
      }
    } else {
      console.log('Sign in with Apple on this platform is not supported yet');
    }
  };

  const tauriSignIn = async (provider: OAuthProvider) => {
    try {
      const { data, error } = await authClient.signIn.social({
        provider,
        callbackURL: getTauriRedirectTo(true),
        disableRedirect: true,
      });

      if (error) {
        console.error('Authentication error:', error);
        setErrorMsg(error.message ?? _('Sign-in failed'));
        return;
      }
      const authUrl =
        data && typeof (data as { url?: unknown }).url === 'string'
          ? (data as { url: string }).url
          : null;
      if (!authUrl) {
        setErrorMsg(_('Sign-in failed'));
        return;
      }

      if (appService?.isIOSApp || appService?.isMacOSApp) {
        const res = await authWithSafari({ authUrl });
        if (res) {
          handleOAuthUrl(res.redirectUrl);
        }
      } else if (appService?.isAndroidApp) {
        const res = await authWithCustomTab({ authUrl });
        if (res) {
          handleOAuthUrl(res.redirectUrl);
        }
      } else {
        await openUrl(authUrl);
      }
    } catch (err) {
      console.error('Authentication error:', err);
    }
  };

  const webSignInSocial = async (provider: OAuthProvider) => {
    setErrorMsg('');
    try {
      const { error } = await authClient.signIn.social({
        provider,
        callbackURL: getWebRedirectTo(),
      });
      if (error) {
        setErrorMsg(error.message ?? _('Sign-in failed'));
      }
    } catch (err) {
      console.error('Authentication error:', err);
      setErrorMsg(err instanceof Error ? err.message : _('Sign-in failed'));
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setStatusMsg('');
    setLoading(true);
    try {
      if (mode === 'signin') {
        const { error } = await authClient.signIn.email({ email, password });
        if (error) setErrorMsg(error.message ?? _('Sign-in failed'));
      } else if (mode === 'signup') {
        const { error } = await authClient.signUp.email({
          email,
          password,
          name: email.split('@')[0] ?? email,
        });
        if (error) setErrorMsg(error.message ?? _('Sign-up failed'));
        else setStatusMsg(_('Check your email for the confirmation link'));
      } else if (mode === 'forgot') {
        // Method name is `requestPasswordReset` on the React client (the
        // underlying server route is `/api/auth/request-password-reset`).
        // `forgetPassword` is the same endpoint exposed by the email-OTP
        // plugin, which we don't load.
        const { error } = await authClient.requestPasswordReset({
          email,
          redirectTo: isTauriAppPlatform() ? DEEPLINK_CALLBACK : `${getBaseUrl()}/auth/recovery`,
        });
        if (error) setErrorMsg(error.message ?? _('Failed to send reset email'));
        else setStatusMsg(_('Check your email for the password reset link'));
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : _('Operation failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async () => {
    setErrorMsg('');
    setStatusMsg('');
    if (!email) {
      setErrorMsg(_('Please enter your email address'));
      return;
    }
    setLoading(true);
    try {
      const { error } = await authClient.signIn.magicLink({
        email,
        callbackURL: getWebRedirectTo(),
      });
      if (error) setErrorMsg(error.message ?? _('Failed to send magic link'));
      else setStatusMsg(_('Check your email for the magic link'));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : _('Failed to send magic link'));
    } finally {
      setLoading(false);
    }
  };

  const startTauriOAuth = async () => {
    try {
      if (
        !useCustomeOAuth.current &&
        (process.env['NODE_ENV'] === 'production' ||
          appService?.isMobileApp ||
          USE_APPLE_SIGN_IN)
      ) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        currentWindow.listen('single-instance', ({ event, payload }) => {
          console.log('Received deep link:', event, payload);
          const { args } = payload as SingleInstancePayload;
          if (args?.[1]) {
            handleOAuthUrl(args[1]);
          }
        });
        await onOpenUrl((urls) => {
          urls.forEach((url) => {
            handleOAuthUrl(url);
          });
        });
      } else {
        const newPort = await start();
        setPort(newPort);
        console.log(`OAuth server started on port ${newPort}`);

        await onUrl(handleOAuthUrl);
        await onInvalidUrl((url) => {
          console.log('Received invalid OAuth URL:', url);
        });
      }
    } catch (error) {
      console.error('Error starting OAuth server:', error);
    }
  };

  const stopTauriOAuth = async () => {
    try {
      if (port) {
        await cancel(port);
        console.log('OAuth server stopped');
      }
    } catch (error) {
      console.error('Error stopping OAuth server:', error);
    }
  };

  const handleGoBack = () => {
    settings.keepLogin = false;
    setSettings(settings);
    saveSettings(envConfig, settings);
    const redirectTo = new URLSearchParams(window.location.search).get('redirect');
    if (redirectTo) {
      router.navigate({ to: redirectTo });
    } else {
      router.history.back();
    }
  };

  useEffect(() => {
    if (!isTauriAppPlatform()) return;
    if (isOAuthServerRunning.current) return;
    isOAuthServerRunning.current = true;

    invoke('get_environment_variable', { name: 'USE_CUSTOM_OAUTH' }).then((value) => {
      if (value === 'true') {
        useCustomeOAuth.current = true;
      }
    });

    startTauriOAuth();
    return () => {
      isOAuthServerRunning.current = false;
      stopTauriOAuth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Forward to library once the better-auth session is observed. We
  // rate-limit consecutive redirects to avoid bouncing the user when
  // multiple subscribers (e.g. AuthProvider + this page) observe the
  // same session-change tick.
  const { data: session } = authClient.useSession();
  useEffect(() => {
    if (!session?.user) return;
    const redirectTo = new URLSearchParams(window.location.search).get('redirect');
    const lastRedirectAtKey = 'lastRedirectAt';
    const lastRedirectAt = Number.parseInt(
      localStorage.getItem(lastRedirectAtKey) || '0',
      10,
    );
    const now = Date.now();
    localStorage.setItem(lastRedirectAtKey, now.toString());
    if (now - lastRedirectAt > 3000) {
      router.navigate({ to: redirectTo ?? '/library' });
    }
  }, [session?.user, router]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    return null;
  }

  const renderProviderButtons = (signInWith: (p: OAuthProvider) => void) => (
    <>
      <ProviderLogin
        provider='google'
        handleSignIn={signInWith}
        Icon={FcGoogle}
        label={_('Sign in with {{provider}}', { provider: 'Google' })}
      />
      <ProviderLogin
        provider='apple'
        handleSignIn={
          isTauriAppPlatform() && (appService?.isIOSApp || USE_APPLE_SIGN_IN)
            ? tauriSignInApple
            : signInWith
        }
        Icon={FaApple}
        label={_('Sign in with {{provider}}', { provider: 'Apple' })}
      />
      <ProviderLogin
        provider='github'
        handleSignIn={signInWith}
        Icon={FaGithub}
        label={_('Sign in with {{provider}}', { provider: 'GitHub' })}
      />
      <ProviderLogin
        provider='discord'
        handleSignIn={signInWith}
        Icon={FaDiscord}
        label={_('Sign in with {{provider}}', { provider: 'Discord' })}
      />
    </>
  );

  const renderEmailForm = () => (
    <form onSubmit={handleEmailSubmit} className='flex w-64 flex-col gap-2'>
      <label htmlFor='auth-email' className='text-base-content/75 text-xs'>
        {_('Email address')}
      </label>
      <input
        id='auth-email'
        type='email'
        required
        autoComplete='email'
        placeholder={_('Your email address')}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={loading}
        className={clsx(
          'bg-base-100 border-base-300 text-base-content rounded border p-2 text-sm',
          'focus:outline-none focus:ring-1',
        )}
      />
      {mode !== 'forgot' && (
        <>
          <label htmlFor='auth-password' className='text-base-content/75 mt-1 text-xs'>
            {mode === 'signup' ? _('Create a Password') : _('Your Password')}
          </label>
          <input
            id='auth-password'
            type='password'
            required
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            placeholder={_('Your password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            minLength={8}
            className={clsx(
              'bg-base-100 border-base-300 text-base-content rounded border p-2 text-sm',
              'focus:outline-none focus:ring-1',
            )}
          />
        </>
      )}
      <button
        type='submit'
        disabled={loading || !email || (mode !== 'forgot' && !password)}
        className={clsx(
          'mt-2 rounded p-2 text-sm font-medium transition',
          'bg-primary text-primary-content hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {loading
          ? mode === 'signin'
            ? _('Signing in...')
            : mode === 'signup'
              ? _('Signing up...')
              : _('Sending reset instructions ...')
          : mode === 'signin'
            ? _('Sign in')
            : mode === 'signup'
              ? _('Sign up')
              : _('Send reset password instructions')}
      </button>
      {errorMsg && <div className='text-xs text-red-500'>{errorMsg}</div>}
      {statusMsg && <div className='text-base-content/75 text-xs'>{statusMsg}</div>}

      <div className='mt-2 flex flex-col gap-1 text-xs'>
        {mode === 'signin' && (
          <>
            <button
              type='button'
              onClick={() => {
                setMode('forgot');
                setErrorMsg('');
                setStatusMsg('');
              }}
              className='text-base-content/75 hover:underline'
            >
              {_('Forgot your password?')}
            </button>
            <button
              type='button'
              onClick={() => {
                setMode('signup');
                setErrorMsg('');
                setStatusMsg('');
              }}
              className='text-base-content/75 hover:underline'
            >
              {_("Don't have an account? Sign up")}
            </button>
          </>
        )}
        {mode === 'signup' && (
          <button
            type='button'
            onClick={() => {
              setMode('signin');
              setErrorMsg('');
              setStatusMsg('');
            }}
            className='text-base-content/75 hover:underline'
          >
            {_('Already have an account? Sign in')}
          </button>
        )}
        {mode === 'forgot' && (
          <button
            type='button'
            onClick={() => {
              setMode('signin');
              setErrorMsg('');
              setStatusMsg('');
            }}
            className='text-base-content/75 hover:underline'
          >
            {_('Back to sign in')}
          </button>
        )}
      </div>

      {showMagicLink && mode === 'signin' && (
        <>
          <hr aria-hidden='true' className='border-base-300 my-2 border-t' />
          <button
            type='button'
            onClick={handleMagicLink}
            disabled={loading || !email}
            className={clsx(
              'rounded border p-2 text-sm transition',
              'bg-base-100 border-base-300 hover:bg-base-200 disabled:cursor-not-allowed disabled:opacity-50',
            )}
            aria-label={_('Send Magic Link')}
          >
            {_('Send Magic Link')}
          </button>
        </>
      )}
    </form>
  );

  // Tauri (desktop + mobile) shell: window-chrome + native OAuth handoff.
  // Web shell: just a centred card.
  return isTauriAppPlatform() ? (
    <div
      className={clsx(
        'bg-base-100 full-height inset-0 flex select-none flex-col items-center overflow-hidden',
        appService?.hasRoundedWindow && isRoundedWindow && 'window-border rounded-window',
      )}
    >
      <div
        className={clsx('flex h-full w-full flex-col items-center overflow-y-auto')}
        style={{
          paddingTop: `${safeAreaInsets?.top || 0}px`,
        }}
      >
        <div
          ref={headerRef}
          className={clsx(
            'fixed z-10 flex w-full items-center justify-between py-2 pe-6 ps-4',
            appService?.hasTrafficLight && 'pt-11',
          )}
        >
          <button
            aria-label={_('Go Back')}
            onClick={handleGoBack}
            className={clsx('btn btn-ghost h-12 min-h-12 w-12 p-0 sm:h-8 sm:min-h-8 sm:w-8')}
          >
            <IoArrowBack className='text-base-content' />
          </button>

          {appService?.hasWindowBar && (
            <WindowButtons
              headerRef={headerRef}
              showMinimize={!isTrafficLightVisible}
              showMaximize={!isTrafficLightVisible}
              showClose={!isTrafficLightVisible}
              onClose={handleGoBack}
            />
          )}
        </div>
        <div
          className={clsx(
            'z-20 flex flex-col items-center pb-8',
            appService?.hasTrafficLight ? 'mt-24' : 'mt-12',
          )}
          style={{ maxWidth: '420px' }}
        >
          {renderProviderButtons(tauriSignIn)}
          <hr aria-hidden='true' className='border-base-300 my-3 mt-6 w-64 border-t' />
          {renderEmailForm()}
        </div>
      </div>
    </div>
  ) : (
    <div style={{ maxWidth: '420px', margin: 'auto', padding: '2rem', paddingTop: '4rem' }}>
      <button
        onClick={handleGoBack}
        className='btn btn-ghost fixed left-6 top-6 h-8 min-h-8 w-8 p-0'
      >
        <IoArrowBack className='text-base-content' />
      </button>
      <div className='flex flex-col items-center'>
        {renderProviderButtons(webSignInSocial)}
        <hr aria-hidden='true' className='border-base-300 my-3 mt-6 w-64 border-t' />
        {renderEmailForm()}
      </div>
    </div>
  );
}
