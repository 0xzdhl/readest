import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

// SyncClient.pullChanges is the network boundary; we stub it so the hook's
// timestamp-advancing logic is exercised in isolation.
const pullChangesSpy = vi.fn<(...args: unknown[]) => Promise<Record<string, unknown[]>>>();

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: { pullChanges: pullChangesSpy } }),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({}),
}));

// Sync category gating is irrelevant here; always enabled.
vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => true,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'test-user' } }),
}));

const settingsState = {
  settings: { version: 1, lastSyncedAtBooks: 0, lastSyncedAtConfigs: 0, lastSyncedAtNotes: 0 },
  setSettings: vi.fn(),
  saveSettings: vi.fn(async () => {}),
};

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: Object.assign(() => settingsState, {
    getState: () => settingsState,
  }),
}));

const bookDataState = {
  config: null as { location?: string } | null,
};
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getConfig: () => bookDataState.config, setConfig: vi.fn() }),
}));

const setIsSyncingSpy = vi.fn<(key: string, syncing: boolean) => void>();
const setSyncErrorSpy = vi.fn<(key: string, error: string | null) => void>();
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({ setIsSyncing: setIsSyncingSpy, setSyncError: setSyncErrorSpy }),
}));

vi.mock('@/utils/nav', () => ({ navigateToLogin: vi.fn() }));

vi.mock('@/utils/transform', () => ({
  transformBookFromDB: (b: unknown) => b,
  transformBookNoteFromDB: (b: unknown) => b,
  transformBookConfigFromDB: (b: unknown) => b,
}));

import { useSync } from '@/hooks/useSync';

beforeEach(() => {
  pullChangesSpy.mockReset();
  settingsState.setSettings.mockClear();
  settingsState.saveSettings.mockClear();
  settingsState.settings.lastSyncedAtBooks = 0;
  setIsSyncingSpy.mockReset();
  bookDataState.config = null;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useSync pullChanges clock-drift on empty initial pull', () => {
  test('does NOT advance lastSyncedAt to a future client time when an initial (since<=1000) pull returns no records', async () => {
    // Empty result for an initial/full pull.
    pullChangesSpy.mockResolvedValue({ books: [] });

    // Client clock runs far ahead of true server time.
    const FUTURE = 5_000_000_000_000; // ~year 2128
    vi.useFakeTimers();
    vi.setSystemTime(FUTURE);

    const { result } = renderHook(() => useSync());

    const since = 500; // initial pull window: since <= 1000
    await act(async () => {
      await result.current.pullChanges(
        'books',
        since,
        () => {},
        () => {},
      );
    });

    // Settings must NOT be stamped with the future client clock — otherwise
    // later incremental pulls would skip other devices' records whose true
    // timestamps are below FUTURE.
    expect(settingsState.settings.lastSyncedAtBooks).not.toBe(FUTURE);
    expect(settingsState.settings.lastSyncedAtBooks).toBeLessThanOrEqual(since);
  });
});

describe('useSync mirrors the aggregate syncing flag to the reader store', () => {
  test('a PULL flips setIsSyncing(true) then setIsSyncing(false)', async () => {
    // A manual "sync now" is pull-dominated. Pulls flip syncingConfigs/Notes/
    // Books, never the push-only `syncing` flag — so the mirrored reader-store
    // flag must follow the AGGREGATE (syncingBooks || syncingConfigs ||
    // syncingNotes), otherwise the reader icon never visibly spins.
    bookDataState.config = { location: 'epubcfi(/6/4!/4/2)' };

    // Resolve the pull on a deferred promise so the in-flight (true) state is
    // observable before completion.
    let resolvePull: ((value: Record<string, unknown[]>) => void) | undefined;
    pullChangesSpy.mockImplementation(
      () =>
        new Promise<Record<string, unknown[]>>((resolve) => {
          resolvePull = resolve;
        }),
    );

    const bookKey = 'hash1-0';
    const { result } = renderHook(() => useSync(bookKey));

    // syncConfigs in 'pull' mode flips the configs flag → the aggregate.
    let pullPromise: Promise<void> | undefined;
    await act(async () => {
      pullPromise = result.current.syncConfigs([], 'hash1', 'meta1', 'pull');
      // allow the setSyncing(true) state update to flush
      await Promise.resolve();
    });

    expect(setIsSyncingSpy).toHaveBeenCalledWith(bookKey, true);

    await act(async () => {
      resolvePull!({ configs: [] });
      await pullPromise;
    });

    expect(setIsSyncingSpy).toHaveBeenCalledWith(bookKey, false);
  });
});
