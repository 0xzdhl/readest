/**
 * Regression test for the pullLibrary namespace guard.
 *
 * getNewBooks / handleAutoSync / pushLibrary all early-return when
 * `loadedNamespace !== getCurrentUserNamespace()` (the mid-account-switch
 * window). pullLibrary historically lacked this guard, so a half-completed
 * switch could merge the wrong user's rows. This test asserts:
 *
 *   - pullLibrary does NOT call syncBooks when the loaded namespace and the
 *     current user namespace disagree.
 *   - pullLibrary DOES proceed (calls syncBooks) once they match — including
 *     the legitimate FIRST pull on a fresh login.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const syncBooksMock = vi.fn(async () => 0);

vi.mock('@/hooks/useSync', () => ({
  useSync: () => ({
    useSyncInited: true,
    syncedBooks: null,
    syncBooks: syncBooksMock,
    lastSyncedAtBooks: 0,
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-B' } }),
}));

const runEffectMock = vi.fn(async () => undefined);
vi.mock('@/context/EffectRuntimeProvider', () => ({
  useRunEffect: () => runEffectMock,
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

vi.mock('@/application/repositories/LibraryRepository', () => ({ LibraryRepository: {} }));
vi.mock('@/application/services/CoverService', () => ({ CoverService: {} }));
vi.mock('@/application/services/CloudService', () => ({ CloudService: {} }));

const eventDispatchMock = vi.fn();
vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: (...args: unknown[]) => eventDispatchMock(...args) },
}));

// Library store — `loadedNamespace` is the variable under test.
const libraryStoreState = {
  library: [] as unknown[],
  isSyncing: false,
  libraryLoaded: true,
  loadedNamespace: 'user-B' as string | null,
  setLibrary: vi.fn(),
  setIsSyncing: vi.fn(),
  setSyncProgress: vi.fn(),
};

vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: Object.assign(() => libraryStoreState, {
    getState: () => libraryStoreState,
  }),
}));

// Namespace pointer — set per test.
const getCurrentUserNamespaceMock = vi.fn<() => string>(() => 'user-B');
vi.mock('@/services/userNamespace', () => ({
  getCurrentUserNamespace: () => getCurrentUserNamespaceMock(),
}));

import { useBooksSync } from '@/app/library/hooks/useBooksSync';

beforeEach(() => {
  syncBooksMock.mockClear();
  libraryStoreState.library = [];
  libraryStoreState.libraryLoaded = true;
  libraryStoreState.loadedNamespace = 'user-B';
  getCurrentUserNamespaceMock.mockReturnValue('user-B');
});

afterEach(() => {
  cleanup();
});

describe('useBooksSync.pullLibrary namespace guard', () => {
  test('does NOT call syncBooks when loadedNamespace !== current namespace (mid-switch)', async () => {
    // Library is still stamped as user-A while the namespace pointer has moved
    // to user-B — the dangerous half-switched window.
    libraryStoreState.loadedNamespace = 'user-A';
    getCurrentUserNamespaceMock.mockReturnValue('user-B');

    const { result } = renderHook(() => useBooksSync());
    // Flush the mount-effect auto-pull so its isPullingRef guard clears before
    // we exercise pullLibrary directly.
    await act(async () => {
      await Promise.resolve();
    });
    syncBooksMock.mockClear();

    await act(async () => {
      await result.current.pullLibrary();
    });

    expect(syncBooksMock).not.toHaveBeenCalled();
  });

  test('DOES call syncBooks when loadedNamespace === current namespace (fresh login first pull)', async () => {
    libraryStoreState.loadedNamespace = 'user-B';
    getCurrentUserNamespaceMock.mockReturnValue('user-B');

    const { result } = renderHook(() => useBooksSync());
    // Flush the mount-effect auto-pull so its isPullingRef guard clears before
    // we exercise pullLibrary directly.
    await act(async () => {
      await Promise.resolve();
    });
    syncBooksMock.mockClear();

    await act(async () => {
      await result.current.pullLibrary();
    });

    expect(syncBooksMock).toHaveBeenCalled();
  });
});
