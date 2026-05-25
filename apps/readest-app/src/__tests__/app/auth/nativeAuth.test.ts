import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn();
const osTypeMock = vi.fn<() => string>();
const storeTokenMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listenMock(...a) }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => osTypeMock() }));
vi.mock('@/auth', () => ({
  storeSessionToken: (...a: unknown[]) => storeTokenMock(...a),
}));

import {
  authWithSafari,
  authWithCustomTab,
  extractSessionTokenFromCallback,
  storeSessionTokenFromCallback,
} from '@/app/auth/utils/nativeAuth';

describe('nativeAuth helpers (native callback token bridge)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    osTypeMock.mockReset();
    storeTokenMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractSessionTokenFromCallback', () => {
    it('reads `token` from the better-auth callback query string', () => {
      const url = 'readest://auth-callback?token=ABC123&redirect=%2Flibrary';
      expect(extractSessionTokenFromCallback(url)).toBe('ABC123');
    });
    it('falls back to hash fragment', () => {
      const url = 'readest://auth-callback#token=XYZ&type=signin';
      expect(extractSessionTokenFromCallback(url)).toBe('XYZ');
    });
    it('returns null when no token is present', () => {
      expect(extractSessionTokenFromCallback('readest://auth-callback')).toBeNull();
      expect(extractSessionTokenFromCallback('not-a-url')).toBeNull();
    });
  });

  describe('storeSessionTokenFromCallback', () => {
    it('stores the callback token for the native auth client', () => {
      const token = storeSessionTokenFromCallback('readest://auth-callback?token=ABC123');
      expect(token).toBe('ABC123');
      expect(storeTokenMock).toHaveBeenCalledWith('ABC123');
    });
  });

  describe('authWithCustomTab', () => {
    it('invokes the native plugin with the auth URL', async () => {
      invokeMock.mockResolvedValue({ redirectUrl: 'readest://auth-callback?token=T' });
      const res = await authWithCustomTab({ authUrl: 'https://app.example.com/auth' });
      expect(invokeMock).toHaveBeenCalledWith('plugin:native-bridge|auth_with_custom_tab', {
        payload: { authUrl: 'https://app.example.com/auth' },
      });
      expect(res.redirectUrl).toBe('readest://auth-callback?token=T');
    });
  });

  describe('authWithSafari', () => {
    it('on iOS, invokes the safari plugin', async () => {
      osTypeMock.mockReturnValue('ios');
      invokeMock.mockResolvedValue({ redirectUrl: 'readest://auth-callback?token=T' });
      const res = await authWithSafari({ authUrl: 'https://app.example.com/auth' });
      expect(invokeMock).toHaveBeenCalledWith('plugin:native-bridge|auth_with_safari', {
        payload: { authUrl: 'https://app.example.com/auth' },
      });
      expect(res.redirectUrl).toBe('readest://auth-callback?token=T');
    });

    it('rejects on unsupported OS', async () => {
      osTypeMock.mockReturnValue('linux');
      await expect(authWithSafari({ authUrl: 'x' })).rejects.toThrow(/Unsupported OS type/);
    });
  });
});
