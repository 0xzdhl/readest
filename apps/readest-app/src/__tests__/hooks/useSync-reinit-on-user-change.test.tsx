/**
 * Regression test: useSync must re-initialise its in-memory `lastSyncedAt*`
 * cursors when the authenticated user id changes.
 *
 * Previously the init effect set `lastSyncedAtInited` once and never re-ran, so
 * after an A->B account switch the in-memory cursors stayed at A's values even
 * though the global settings cursors had been reset to 0 — and B's first pull
 * reused A's `since`. The init must re-run on user-id change, re-reading the
 * (now reset) settings cursors, WITHOUT breaking the 3-day look-back logic.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: { pullChanges: vi.fn() } }),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({}),
}));

vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => true,
}));

const useAuthMock = vi.fn<() => { user: { id: string } | null }>(() => ({ user: { id: 'A' } }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

const settingsState = {
  settings: {
    version: 1,
    lastSyncedAtBooks: 0,
    lastSyncedAtConfigs: 0,
    lastSyncedAtNotes: 0,
  } as Record<string, number>,
  setSettings: vi.fn(),
  saveSettings: vi.fn(async () => {}),
};

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: Object.assign(() => settingsState, {
    getState: () => settingsState,
  }),
}));

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getConfig: () => null, setConfig: vi.fn() }),
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({ setIsSyncing: vi.fn() }),
}));

vi.mock('@/utils/nav', () => ({ navigateToLogin: vi.fn() }));

vi.mock('@/utils/transform', () => ({
  transformBookFromDB: (b: unknown) => b,
  transformBookNoteFromDB: (b: unknown) => b,
  transformBookConfigFromDB: (b: unknown) => b,
}));

import { useSync } from '@/hooks/useSync';

const ONE_DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  useAuthMock.mockReturnValue({ user: { id: 'A' } });
  settingsState.settings.lastSyncedAtBooks = 0;
  settingsState.settings.lastSyncedAtConfigs = 0;
  settingsState.settings.lastSyncedAtNotes = 0;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useSync re-init on user-id change', () => {
  test('re-initialises cursors when the user id changes (A -> B)', async () => {
    // User A has a RECENT cursor (within the 3-day look-back window) so the
    // init seeds lastSyncedAtBooks = cursor - ONE_DAY (a non-zero value).
    const now = Date.now();
    const recentCursor = now - 1000;
    settingsState.settings.lastSyncedAtBooks = recentCursor;

    const { result, rerender } = renderHook(() => useSync());

    await waitFor(() => {
      expect(result.current.useSyncInited).toBe(true);
    });

    // A's in-memory cursor is the recent value minus the look-back day.
    expect(result.current.lastSyncedAtBooks).toBe(recentCursor - ONE_DAY);

    // Simulate the account-switch cursor reset: settings cursors zeroed AND a
    // new user id.
    settingsState.settings.lastSyncedAtBooks = 0;
    useAuthMock.mockReturnValue({ user: { id: 'B' } });

    await act(async () => {
      rerender();
      await Promise.resolve();
    });

    await waitFor(() => {
      // B must do a full pull: the cursor re-inits to 0, NOT A's stale value.
      expect(result.current.lastSyncedAtBooks).toBe(0);
    });
  });

  test('does not re-init on a re-render with the SAME user id', async () => {
    const now = Date.now();
    const recentCursor = now - 1000;
    settingsState.settings.lastSyncedAtBooks = recentCursor;

    const { result, rerender } = renderHook(() => useSync());

    await waitFor(() => {
      expect(result.current.useSyncInited).toBe(true);
    });

    const initial = result.current.lastSyncedAtBooks;

    // Settings cursor changes underneath but the user id is the SAME — the
    // existing one-shot init must NOT re-run (no spurious re-init).
    settingsState.settings.lastSyncedAtBooks = 999_999;

    await act(async () => {
      rerender();
      await Promise.resolve();
    });

    expect(result.current.lastSyncedAtBooks).toBe(initial);
  });
});
