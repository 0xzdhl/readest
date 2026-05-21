import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Stub the platform-routed better-auth client. `useSession()` is the entire
// surface AuthContext reads from after Phase 7; everything else (login /
// logout / refresh) is driven through `authClient.signOut()` and the
// hook's `refetch`.
const useSessionMock = vi.fn();
const signOutMock = vi.fn<(arg?: unknown) => Promise<undefined>>(async () => undefined);
vi.mock('@/auth', () => ({
  authClient: {
    useSession: () => useSessionMock(),
    signOut: (arg?: unknown) => signOutMock(arg),
  },
}));

vi.mock('posthog-js', () => ({
  default: { identify: vi.fn(), reset: vi.fn() },
}));

import { AuthProvider, useAuth } from '@/context/AuthContext';

const stableSession = (
  user: { id: string; email: string } | null,
) =>
  user
    ? { user, session: { id: 'sess-1', token: 'tk', userId: user.id } }
    : null;

describe('AuthContext (better-auth)', () => {
  beforeEach(() => {
    useSessionMock.mockReset();
    signOutMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  test('exposes user + session derived from authClient.useSession()', () => {
    useSessionMock.mockReturnValue({
      data: stableSession({ id: 'u1', email: 'a@b' }),
      isPending: false,
      refetch: vi.fn(),
    });
    let captured: ReturnType<typeof useAuth> | null = null;
    function Probe() {
      captured = useAuth();
      return null;
    }
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(captured).not.toBeNull();
    const v = captured!;
    expect(v.user?.id).toBe('u1');
    expect(v.user?.email).toBe('a@b');
    expect(v.session?.id).toBe('sess-1');
    expect(v.isLoading).toBe(false);
  });

  test('isLoading reflects useSession isPending', () => {
    useSessionMock.mockReturnValue({
      data: null,
      isPending: true,
      refetch: vi.fn(),
    });
    let captured: ReturnType<typeof useAuth> | null = null;
    function Probe() {
      captured = useAuth();
      return null;
    }
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(captured!.isLoading).toBe(true);
    expect(captured!.user).toBeNull();
    expect(captured!.session).toBeNull();
  });

  test('signOut calls authClient.signOut and triggers refetch', async () => {
    const refetch = vi.fn();
    useSessionMock.mockReturnValue({
      data: stableSession({ id: 'u1', email: 'a@b' }),
      isPending: false,
      refetch,
    });
    let captured: ReturnType<typeof useAuth> | null = null;
    function Probe() {
      captured = useAuth();
      return null;
    }
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {
      await captured!.signOut();
    });
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('memoised context value: signOut/refresh callbacks stable across re-renders', () => {
    useSessionMock.mockReturnValue({
      data: stableSession({ id: 'u1', email: 'a@b' }),
      isPending: false,
      refetch: vi.fn(),
    });

    const captured: ReturnType<typeof useAuth>[] = [];
    function Probe() {
      captured.push(useAuth());
      return null;
    }
    function Wrapper({ tick }: { tick: number }) {
      return (
        <AuthProvider>
          <span data-tick={tick} />
          <Probe />
        </AuthProvider>
      );
    }
    const { rerender } = render(<Wrapper tick={0} />);
    act(() => {
      rerender(<Wrapper tick={1} />);
    });
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const last = captured[captured.length - 1]!;
    const prev = captured[captured.length - 2]!;
    expect(last.signOut).toBe(prev.signOut);
    expect(last.refresh).toBe(prev.refresh);
  });

  test('useAuth throws outside provider', () => {
    function Probe() {
      useAuth();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useAuth must be used within AuthProvider/);
    spy.mockRestore();
  });
});
