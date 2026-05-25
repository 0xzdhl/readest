import posthog from 'posthog-js';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { authClient } from '@/auth';
import type { Session } from '@/auth/server';

/**
 * better-auth's React client (`authClient.useSession()`) returns:
 *
 *   { data: { user, session } | null, isPending, error, refetch }
 *
 * The `data.user` already carries our `additionalFields`
 * (`plan`, `storageUsageBytes`, `storagePurchasedBytes`) in camelCase,
 * thanks to `inferAdditionalFields<typeof auth>` on the client. This
 * context is now a thin pass-through over that hook — there's no separate
 * `token` field and no localStorage mirroring of the user object. Web uses
 * browser cookies directly; native uses the same Better Auth session model
 * but replays the session cookie through the native auth transport helper.
 */
export type AuthUser = NonNullable<Session>['user'];
export type AuthSession = NonNullable<Session>['session'];

export interface AuthContextValue {
  user: AuthUser | null;
  session: AuthSession | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const { data, isPending, refetch } = authClient.useSession();

  // posthog identification — `useSession` re-fires often (every focus /
  // visibility change can re-fetch); guard with a ref so we only identify
  // on user-id transitions, not every render.
  const lastIdentifiedRef = useRef<string | null>(null);
  useEffect(() => {
    const id = data?.user?.id ?? null;
    if (id === lastIdentifiedRef.current) return;
    if (id) {
      posthog.identify(id);
    } else if (lastIdentifiedRef.current) {
      // Transition from signed-in → signed-out. Reset rather than leave
      // the previous user's distinct id associated with subsequent
      // anonymous events.
      posthog.reset();
    }
    lastIdentifiedRef.current = id;
  }, [data?.user?.id]);

  const signOut = useCallback(async () => {
    try {
      await authClient.signOut();
    } finally {
      refetch();
    }
  }, [refetch]);

  const refresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: data?.user ?? null,
      session: data?.session ?? null,
      isLoading: isPending,
      signOut,
      refresh,
    }),
    [data, isPending, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
