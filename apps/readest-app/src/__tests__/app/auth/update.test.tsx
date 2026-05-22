import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { UpdateEmail } from '@/components/settings/updateEmail';

describe('UpdateEmail (better-auth)', () => {
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
    render(<UpdateEmail />);
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
    render(<UpdateEmail />);
    expect(routerStub.navigate).toHaveBeenCalledWith({ to: '/auth' });
  });
});
