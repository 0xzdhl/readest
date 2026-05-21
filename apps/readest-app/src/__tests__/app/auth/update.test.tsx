import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

const routerStub = { navigate: vi.fn(), history: { back: vi.fn() } };
const changeEmailMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (cfg: unknown) => cfg,
  useRouter: () => routerStub,
}));
vi.mock('@/auth', () => ({
  authClient: {
    changeEmail: (...a: unknown[]) => changeEmailMock(...a),
  },
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (k: string) => k,
}));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ isDarkMode: false }),
}));

import { UpdateEmailPage } from '@/app/auth/update';

describe('UpdateEmailPage (better-auth)', () => {
  beforeEach(() => {
    changeEmailMock.mockReset();
    routerStub.navigate.mockReset();
    useAuthMock.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it('calls authClient.changeEmail with the new email', async () => {
    useAuthMock.mockReturnValue({ user: { id: 'u1', email: 'old@x.com' } });
    changeEmailMock.mockResolvedValue({ data: { status: true }, error: null });
    render(<UpdateEmailPage />);
    fireEvent.change(screen.getByLabelText(/New Email/i), {
      target: { value: 'new@x.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Update email/i }));
    await waitFor(() => {
      expect(changeEmailMock).toHaveBeenCalledTimes(1);
    });
    const args = changeEmailMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['newEmail']).toBe('new@x.com');
  });

  it('redirects to /auth when no user is signed in', () => {
    useAuthMock.mockReturnValue({ user: null });
    render(<UpdateEmailPage />);
    expect(routerStub.navigate).toHaveBeenCalledWith({ to: '/auth' });
  });
});
