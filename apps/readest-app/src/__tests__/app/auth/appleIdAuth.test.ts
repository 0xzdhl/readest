import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub the Tauri bridges before importing the module under test. Apple
// sign-in on iOS goes through the native sign-in-with-apple plugin;
// on macOS it dispatches a deferred start and resolves when the native
// host fires the `apple-sign-in-complete` event.
const invokeMock = vi.fn();
const listenMock = vi.fn();
const osTypeMock = vi.fn<() => string>();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listenMock(...a) }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => osTypeMock() }));

import { getAppleIdAuth } from '@/app/auth/utils/appleIdAuth';

describe('getAppleIdAuth (better-auth-native bridge)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    osTypeMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('on iOS, returns identityToken + nonce so the caller can pipe them to authClient.signIn.social({ idToken })', async () => {
    osTypeMock.mockReturnValue('ios');
    invokeMock.mockResolvedValue({
      userIdentifier: 'apple-u',
      givenName: null,
      familyName: null,
      email: null,
      authorizationCode: 'AUTH',
      identityToken: 'ID-TOKEN',
      state: 'st',
      nonce: 'N1',
    });

    const res = await getAppleIdAuth({ scope: ['email', 'fullName'], nonce: 'N1' });

    expect(invokeMock).toHaveBeenCalledWith(
      'plugin:sign-in-with-apple|get_apple_id_credential',
      { payload: { scope: ['email', 'fullName'], nonce: 'N1' } },
    );
    // Both fields are what the caller forwards into
    // `authClient.signIn.social({ provider: 'apple', idToken: { token, nonce } })`.
    expect(res.identityToken).toBe('ID-TOKEN');
    expect(res.nonce).toBe('N1');
  });

  it('throws on unsupported platforms', async () => {
    osTypeMock.mockReturnValue('linux');
    await expect(getAppleIdAuth({ scope: [] })).rejects.toThrow(/Unsupported platform/);
  });
});
