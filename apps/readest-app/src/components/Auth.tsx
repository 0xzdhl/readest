import { cancel, onInvalidUrl, onUrl, start } from '@fabianlars/tauri-plugin-oauth';
import { useRouter } from '@tanstack/react-router';
import { invoke } from '@tauri-apps/api/core';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { FaApple, FaDiscord, FaGithub } from 'react-icons/fa';
import { FcGoogle } from 'react-icons/fc';
import { IoArrowBack } from 'react-icons/io5';
import { getAppleIdAuth, type Scope } from '@/app/auth/utils/appleIdAuth';
import {
  authWithCustomTab,
  authWithSafari,
  storeSessionTokenFromCallback,
} from '@/app/auth/utils/nativeAuth';
import { authClient } from '@/auth';
import { clientEnv } from '@/clientEnv';
import { fetchAuthConfig } from '@/services/authConfig';
import { usePlatformInfo } from '@/context/EffectRuntimeProvider';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from '@/hooks/useTranslation';
import { getBaseUrl, isTauriAppPlatform } from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';
import { useThemeStore } from '@/store/themeStore';
import { useTrafficLightStore } from '@/store/trafficLightStore';
import AuthLayout from './AuthLayout';
import WindowButtons from './WindowButtons';

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
const USE_APPLE_SIGN_IN = clientEnv.VITE_USE_APPLE_SIGN_IN === 'true';

const ProviderLogin: React.FC<ProviderLoginProp> = ({ provider, handleSignIn, Icon, label }) => {
  return (
    <button
      onClick={() => handleSignIn(provider)}
      className={clsx(
        'eink-bordered flex w-full items-center justify-center gap-2 rounded-lg border p-2.5',
        'bg-base-100 border-base-300 hover:bg-base-200 transition-colors duration-150',
        'focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2',
      )}
    >
      <Icon />
      <span className='text-base-content/75 text-sm'>{label}</span>
    </button>
  );
};

type Mode = 'signin' | 'signup' | 'forgot';

export function AuthComponent() {
  const _ = useTranslation();
  const router = useRouter();
  const platformInfo = usePlatformInfo();
  const { safeAreaInsets, isRoundedWindow } = useThemeStore();
  const { isTrafficLightVisible } = useTrafficLightStore();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const [port, setPort] = useState<number | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [modeState, setMode] = useState<Mode>('signin');
  // OAuth providers the server has actually configured. Defaults to none so
  // an unconfigured deployment shows email-only sign-in; populated once the
  // /api/auth-config probe resolves.
  const [enabledProviders, setEnabledProviders] = useState<OAuthProvider[]>([]);
  // Whether new-account creation is allowed. Defaults to enabled (the
  // documented default); the /api/auth-config probe may turn it off, which
  // hides the sign-up affordance. The server still enforces the real rule.
  const [signupEnabled, setSignupEnabled] = useState(true);

  // When registration is off, collapse the sign-up view back to sign-in so no
  // registration wording can render — including the brief window where the
  // config probe is still pending and a user could click into sign-up.
  const mode: Mode = !signupEnabled && modeState === 'signup' ? 'signin' : modeState;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const isOAuthServerRunning = useRef(false);
  const useCustomeOAuth = useRef(false);
  const headerRef = useRef<HTMLDivElement>(null);

  useTheme({ systemUIVisible: false });

  // Magic-link is a web-only convenience — the native app's deep-link
  // callback bridge does not model the mail-confirmation round-trip the
  // magic-link plugin assumes. Hide it on the desktop / mobile apps;
  // browser cookie sessions on the web still get the option.
  const showMagicLink = !isTauriAppPlatform();

  const getTauriRedirectTo = (isOAuth: boolean) => {
    if (
      !useCustomeOAuth.current &&
      (clientEnv.NODE_ENV === 'production' || platformInfo.isMobileApp || USE_APPLE_SIGN_IN)
    ) {
      if (platformInfo.isMobileApp) {
        return isOAuth ? DEEPLINK_CALLBACK : WEB_AUTH_CALLBACK;
      }
      return DEEPLINK_CALLBACK;
    }
    return `http://localhost:${port}`;
  };

  const getWebRedirectTo = () => {
    return clientEnv.NODE_ENV === 'production'
      ? WEB_AUTH_CALLBACK
      : `${window.location.origin}/auth/callback`;
  };

  const handleOAuthUrl = async (url: string) => {
    storeSessionTokenFromCallback(url);
    router.navigate({ to: '/library' });
  };

  const tauriSignInApple = async () => {
    if (platformInfo.isIOSApp || USE_APPLE_SIGN_IN) {
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

      if (platformInfo.isIOSApp || platformInfo.isMacOSApp) {
        const res = await authWithSafari({ authUrl });
        if (res) {
          handleOAuthUrl(res.redirectUrl);
        }
      } else if (platformInfo.isAndroidApp) {
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
        (clientEnv.NODE_ENV === 'production' || platformInfo.isMobileApp || USE_APPLE_SIGN_IN)
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
    saveSettings(settings);
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
    const lastRedirectAt = Number.parseInt(localStorage.getItem(lastRedirectAtKey) || '0', 10);
    const now = Date.now();
    localStorage.setItem(lastRedirectAtKey, now.toString());
    if (now - lastRedirectAt > 3000) {
      router.navigate({ to: redirectTo ?? '/library' });
    }
  }, [session?.user, router]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAuthConfig().then(({ providers, signupEnabled: allowSignup }) => {
      if (cancelled) return;
      setEnabledProviders(providers);
      setSignupEnabled(allowSignup);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isMounted) {
    return null;
  }

  // Only render OAuth buttons for providers the server has configured.
  // Unconfigured providers 404 server-side (fail-closed), so showing their
  // buttons would just dead-end the user.
  const renderProviderButtons = (signInWith: (p: OAuthProvider) => void) => (
    <div className='flex w-full flex-col gap-2'>
      {enabledProviders.includes('google') && (
        <ProviderLogin
          provider='google'
          handleSignIn={signInWith}
          Icon={FcGoogle}
          label={_('Sign in with {{provider}}', { provider: 'Google' })}
        />
      )}
      {enabledProviders.includes('apple') && (
        <ProviderLogin
          provider='apple'
          handleSignIn={
            isTauriAppPlatform() && (platformInfo.isIOSApp || USE_APPLE_SIGN_IN)
              ? tauriSignInApple
              : signInWith
          }
          Icon={FaApple}
          label={_('Sign in with {{provider}}', { provider: 'Apple' })}
        />
      )}
      {enabledProviders.includes('github') && (
        <ProviderLogin
          provider='github'
          handleSignIn={signInWith}
          Icon={FaGithub}
          label={_('Sign in with {{provider}}', { provider: 'GitHub' })}
        />
      )}
      {enabledProviders.includes('discord') && (
        <ProviderLogin
          provider='discord'
          handleSignIn={signInWith}
          Icon={FaDiscord}
          label={_('Sign in with {{provider}}', { provider: 'Discord' })}
        />
      )}
    </div>
  );

  const hasProviders = enabledProviders.length > 0;

  const renderEmailForm = () => (
    <form onSubmit={handleEmailSubmit} className='flex w-full flex-col gap-2'>
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
          'eink-bordered bg-base-100 border-base-300 text-base-content rounded-lg border p-2.5 text-sm',
          'focus:ring-primary/40 focus:outline-none focus:ring-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
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
              'eink-bordered bg-base-100 border-base-300 text-base-content rounded-lg border p-2.5 text-sm',
              'focus:ring-primary/40 focus:outline-none focus:ring-2',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          />
        </>
      )}
      <button
        type='submit'
        disabled={loading || !email || (mode !== 'forgot' && !password)}
        className={clsx(
          'btn btn-primary mt-2 h-auto min-h-0 rounded-lg p-2.5 text-sm font-medium',
          'disabled:cursor-not-allowed disabled:opacity-50',
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
      {errorMsg && <div className='text-error text-xs'>{errorMsg}</div>}
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
            {signupEnabled && (
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
            )}
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
              'eink-bordered rounded-lg border p-2.5 text-sm transition-colors duration-150',
              'bg-base-100 border-base-300 hover:bg-base-200 disabled:cursor-not-allowed disabled:opacity-50',
              'focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2',
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
  // The form body is identical across shells; only the OAuth handler and the
  // window chrome differ between Tauri and web.
  const renderAuthBody = (signInWith: (p: OAuthProvider) => void) => (
    <>
      {renderProviderButtons(signInWith)}
      {hasProviders && <hr aria-hidden='true' className='border-base-300 my-5 w-full border-t' />}
      {renderEmailForm()}
    </>
  );

  return isTauriAppPlatform() ? (
    <div
      className={clsx(
        'bg-base-100 full-height inset-0 select-none overflow-hidden',
        platformInfo.hasRoundedWindow && isRoundedWindow && 'window-border rounded-window',
      )}
    >
      <div
        className='h-full w-full overflow-y-auto'
        style={{ paddingTop: `${safeAreaInsets?.top || 0}px` }}
      >
        <AuthLayout
          chrome={
            <div
              ref={headerRef}
              className={clsx(
                'fixed z-30 flex w-full items-center justify-between py-2 pe-6 ps-4',
                platformInfo.hasTrafficLight && 'pt-11',
              )}
            >
              <button
                type='button'
                aria-label={_('Go Back')}
                onClick={handleGoBack}
                className={clsx('btn btn-ghost h-12 min-h-12 w-12 p-0 sm:h-8 sm:min-h-8 sm:w-8')}
              >
                <IoArrowBack className='text-base-content' />
              </button>

              {platformInfo.hasWindowBar && (
                <WindowButtons
                  headerRef={headerRef}
                  showMinimize={!isTrafficLightVisible}
                  showMaximize={!isTrafficLightVisible}
                  showClose={!isTrafficLightVisible}
                  onClose={handleGoBack}
                />
              )}
            </div>
          }
        >
          {renderAuthBody(tauriSignIn)}
        </AuthLayout>
      </div>
    </div>
  ) : (
    <AuthLayout
      chrome={
        <button
          type='button'
          aria-label={_('Go Back')}
          onClick={handleGoBack}
          className='btn btn-ghost fixed start-4 top-4 z-30 h-8 min-h-8 w-8 p-0'
        >
          <IoArrowBack className='text-base-content' />
        </button>
      }
    >
      {renderAuthBody(webSignInSocial)}
    </AuthLayout>
  );
}
