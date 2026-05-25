import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mocks set BEFORE the SUT import so vi.mock hoists them. We keep the
// mock surface minimal — only the modules `AuthPage` actually touches at
// module-load and during the magic-link / email / social-signin paths.

const signInEmailMock = vi.fn();
const signUpEmailMock = vi.fn();
const signInSocialMock = vi.fn();
const signInMagicLinkMock = vi.fn();
const requestPasswordResetMock = vi.fn();

const useSessionMock = vi.fn(() => ({ data: null, isPending: false }));
vi.mock('@/auth', () => ({
  authClient: {
    useSession: () => useSessionMock(),
    signIn: {
      email: (...a: unknown[]) => signInEmailMock(...a),
      social: (...a: unknown[]) => signInSocialMock(...a),
      magicLink: (...a: unknown[]) => signInMagicLinkMock(...a),
    },
    signUp: { email: (...a: unknown[]) => signUpEmailMock(...a) },
    requestPasswordReset: (...a: unknown[]) => requestPasswordResetMock(...a),
  },
}));

const isTauriMock = vi.fn(() => false);
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => isTauriMock(),
  isWebAppPlatform: () => !isTauriMock(),
  getBaseUrl: () => 'https://example.com',
}));

vi.mock('@/utils/publicEnv', () => ({
  readPublicEnv: () => '',
  readPublicFlag: () => false,
}));

const routerStub = {
  navigate: vi.fn(),
  history: { back: vi.fn() },
};
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (cfg: unknown) => cfg,
  useRouter: () => routerStub,
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, opts?: Record<string, string>) =>
    !opts ? key : key.replace(/{{(\w+)}}/g, (_, k) => String(opts[k] ?? '')),
}));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => undefined }));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: {},
    appService: {
      isMobileApp: false,
      isIOSApp: false,
      isAndroidApp: false,
      isMacOSApp: false,
      hasRoundedWindow: false,
      hasTrafficLight: false,
      hasWindowBar: false,
    },
  }),
}));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ isDarkMode: false, safeAreaInsets: undefined, isRoundedWindow: false }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: { keepLogin: true },
    setSettings: vi.fn(),
    saveSettings: vi.fn(),
  }),
}));
vi.mock('@/store/trafficLightStore', () => ({
  useTrafficLightStore: () => ({ isTrafficLightVisible: false }),
}));
vi.mock('@/components/WindowButtons', () => ({ default: () => null }));

// Tauri-only deps are mocked to no-ops; the platform helper short-circuits
// the effect that would actually use them, but we still need stubs so the
// import graph resolves under jsdom.
vi.mock('@tauri-apps/plugin-deep-link', () => ({ onOpenUrl: vi.fn() }));
vi.mock('@fabianlars/tauri-plugin-oauth', () => ({
  start: vi.fn(),
  cancel: vi.fn(),
  onUrl: vi.fn(),
  onInvalidUrl: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: vi.fn() }),
}));
vi.mock('@/app/auth/utils/appleIdAuth', () => ({ getAppleIdAuth: vi.fn() }));
vi.mock('@/app/auth/utils/nativeAuth', () => ({
  authWithSafari: vi.fn(),
  authWithCustomTab: vi.fn(),
  extractSessionTokenFromCallback: vi.fn(),
  storeSessionTokenFromCallback: vi.fn(),
}));

import { AuthComponent } from '@/components/Auth';

describe('AuthComponent (better-auth)', () => {
  beforeEach(() => {
    signInEmailMock.mockReset();
    signUpEmailMock.mockReset();
    signInSocialMock.mockReset();
    signInMagicLinkMock.mockReset();
    requestPasswordResetMock.mockReset();
    routerStub.navigate.mockReset();
    routerStub.history.back.mockReset();
    isTauriMock.mockReturnValue(false);
  });
  afterEach(() => {
    cleanup();
  });

  it('on web, shows the magic-link button', () => {
    isTauriMock.mockReturnValue(false);
    render(<AuthComponent />);
    // Button text differs by mode, but the magic-link CTA should be
    // present somewhere in the document regardless.
    expect(screen.queryByRole('button', { name: /Magic Link/i })).not.toBeNull();
  });

  it('on Tauri, hides the magic-link button (web-only feature)', () => {
    isTauriMock.mockReturnValue(true);
    render(<AuthComponent />);
    expect(screen.queryByRole('button', { name: /Magic Link/i })).toBeNull();
  });

  it('calls authClient.signIn.email when the email form is submitted in sign-in mode', async () => {
    isTauriMock.mockReturnValue(false);
    signInEmailMock.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    render(<AuthComponent />);
    fireEvent.change(screen.getByLabelText(/Email address/i), {
      target: { value: 'a@b.com' },
    });
    fireEvent.change(screen.getByLabelText(/Your Password/i), {
      target: { value: 'secret-pw' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Sign in$/i }));
    await waitFor(() => {
      expect(signInEmailMock).toHaveBeenCalledTimes(1);
    });
    const args = signInEmailMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['email']).toBe('a@b.com');
    expect(args['password']).toBe('secret-pw');
  });

  it('calls authClient.signIn.social with provider=google when the Google button is clicked', async () => {
    isTauriMock.mockReturnValue(false);
    signInSocialMock.mockResolvedValue({ data: {}, error: null });
    render(<AuthComponent />);
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    await waitFor(() => {
      expect(signInSocialMock).toHaveBeenCalled();
    });
    const args = signInSocialMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['provider']).toBe('google');
  });
});
