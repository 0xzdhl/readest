import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const routerStub = { navigate: vi.fn() };
const storeTokenMock = vi.fn();
const useSessionMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (cfg: unknown) => cfg,
  useRouter: () => routerStub,
}));
vi.mock('@/auth', () => ({
  authClient: { useSession: () => useSessionMock() },
  storeToken: (...a: unknown[]) => storeTokenMock(...a),
}));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
}));

import { AuthCallback } from "@/components/AuthCallback";

describe('AuthCallback (better-auth)', () => {
  beforeEach(() => {
    routerStub.navigate.mockReset();
    storeTokenMock.mockReset();
    useSessionMock.mockReset();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: new URL('https://app.example.com/auth/callback') as unknown as Location,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it('navigates to /auth/error when the URL carries an error param', async () => {
    useSessionMock.mockReturnValue({ data: null, isPending: false });
    Object.defineProperty(window, 'location', {
      writable: true,
      value: new URL(
        'https://app.example.com/auth/callback?error=access_denied&error_description=denied',
      ) as unknown as Location,
    });
    render(<AuthCallback />);
    await waitFor(() => {
      expect(routerStub.navigate).toHaveBeenCalledWith({ to: '/auth/error' });
    });
  });

  it('once the better-auth session resolves, navigates to next (default /library)', async () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: 'u1' }, session: { id: 's1' } },
      isPending: false,
    });
    render(<AuthCallback />);
    await waitFor(() => {
      expect(routerStub.navigate).toHaveBeenCalledWith({ to: '/library' });
    });
  });

  it('respects the ?next= query parameter on the callback URL', async () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: 'u1' }, session: { id: 's1' } },
      isPending: false,
    });
    Object.defineProperty(window, 'location', {
      writable: true,
      value: new URL(
        'https://app.example.com/auth/callback?next=/reader',
      ) as unknown as Location,
    });
    render(<AuthCallback />);
    await waitFor(() => {
      expect(routerStub.navigate).toHaveBeenCalledWith({ to: '/reader' });
    });
  });
});
