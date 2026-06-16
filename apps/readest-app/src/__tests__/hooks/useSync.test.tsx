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

beforeEach(() => {
  pullChangesSpy.mockReset();
  settingsState.setSettings.mockClear();
  settingsState.saveSettings.mockClear();
  settingsState.settings.lastSyncedAtBooks = 0;
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
