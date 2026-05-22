import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerStub = { navigate: vi.fn(), history: { back: vi.fn() } };
const resetPasswordMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (cfg: unknown) => cfg,
  useRouter: () => routerStub,
}));
vi.mock('@/auth', () => ({
  authClient: {
    resetPassword: (...a: unknown[]) => resetPasswordMock(...a),
  },
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (k: string) => k,
}));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ isDarkMode: false }),
}));

import { ResetPassword } from '@/components/settings/ResetPassword';

describe('ResetPassword (better-auth)', () => {
  beforeEach(() => {
    resetPasswordMock.mockReset();
    routerStub.navigate.mockReset();
    routerStub.history.back.mockReset();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: new URL('https://app.example.com/auth/recovery?token=R-TOKEN') as unknown as Location,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it('calls authClient.resetPassword with the new password and the URL token', async () => {
    resetPasswordMock.mockResolvedValue({ data: { status: true }, error: null });
    render(<ResetPassword />);
    fireEvent.change(screen.getByLabelText(/New Password/i), {
      target: { value: 'new-pw-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Update password/i }));
    await waitFor(() => {
      expect(resetPasswordMock).toHaveBeenCalledTimes(1);
    });
    const args = resetPasswordMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['newPassword']).toBe('new-pw-1234');
    expect(args['token']).toBe('R-TOKEN');
  });
});
