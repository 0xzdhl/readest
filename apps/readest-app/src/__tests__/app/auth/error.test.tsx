import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const routerStub = { navigate: vi.fn() };

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (cfg: unknown) => cfg,
  useRouter: () => routerStub,
}));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => undefined }));

import { AuthErrorPage } from '@/app/auth/error';

describe('AuthErrorPage (better-auth)', () => {
  beforeEach(() => {
    routerStub.navigate.mockReset();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: new URL(
        'https://app.example.com/auth/error?error=oauth_invalid_grant&error_description=Bad+code',
      ) as unknown as Location,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it('renders the error_description from the URL when present', () => {
    render(<AuthErrorPage />);
    expect(screen.getByText(/Bad code/)).toBeTruthy();
  });

  it('falls back to a generic message when no error params are present', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: new URL('https://app.example.com/auth/error') as unknown as Location,
    });
    render(<AuthErrorPage />);
    expect(screen.getByText(/redirected to the login page/i)).toBeTruthy();
  });

  it('exposes a "Go to Login" button that navigates to /auth', () => {
    render(<AuthErrorPage />);
    const btn = screen.getByRole('button', { name: /Go to Login/i });
    btn.click();
    expect(routerStub.navigate).toHaveBeenCalledWith({ to: '/auth' });
  });
});
