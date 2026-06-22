/**
 * Defense-in-depth test: the useSync transform effect must drop wire rows
 * (DBBook / DBBookConfig / DBBookNote) whose `user_id` is present AND not the
 * current authenticated user. Rows with a null/undefined user_id (legacy/local)
 * are kept. This guards against a server / RLS-bypass leak surfacing another
 * user's records into the local domain state.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const pullChangesSpy = vi.fn<(...args: unknown[]) => Promise<Record<string, unknown[]>>>();

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: { pullChanges: pullChangesSpy } }),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({}),
}));

vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => true,
}));

// Auth — caller is user 'me'.
const useAuthMock = vi.fn<() => { user: { id: string } | null }>(() => ({ user: { id: 'me' } }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
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

// Identity transforms so the wire row's fields survive for assertion.
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
  useAuthMock.mockReturnValue({ user: { id: 'me' } });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useSync transform effect — cross-user wire-row filter', () => {
  test('drops a config row with a foreign user_id, keeps the caller’s row', async () => {
    // Two wire rows, SAME book_hash, different user_id. Only the caller's
    // ('me') row may become a syncedConfig.
    pullChangesSpy.mockResolvedValue({
      configs: [
        { user_id: 'other', book_hash: 'h1', location: 'epubcfi(/OTHER)' },
        { user_id: 'me', book_hash: 'h1', location: 'epubcfi(/MINE)' },
      ],
    });

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await result.current.pullChanges(
        'configs',
        5000,
        () => {},
        () => {},
      );
    });

    await waitFor(() => {
      expect(result.current.syncedConfigs).not.toBeNull();
    });

    const configs = result.current.syncedConfigs as unknown as Array<{
      user_id?: string;
      location?: string;
    }>;
    expect(configs).toHaveLength(1);
    expect(configs[0]!.user_id).toBe('me');
    expect(configs[0]!.location).toBe('epubcfi(/MINE)');
  });

  test('keeps a config row with no user_id (legacy/local)', async () => {
    pullChangesSpy.mockResolvedValue({
      configs: [{ book_hash: 'h2', location: 'epubcfi(/LEGACY)' }],
    });

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await result.current.pullChanges(
        'configs',
        5000,
        () => {},
        () => {},
      );
    });

    await waitFor(() => {
      expect(result.current.syncedConfigs).not.toBeNull();
    });

    const configs = result.current.syncedConfigs as unknown as Array<{ location?: string }>;
    expect(configs).toHaveLength(1);
    expect(configs[0]!.location).toBe('epubcfi(/LEGACY)');
  });

  test('drops foreign-user book rows', async () => {
    pullChangesSpy.mockResolvedValue({
      books: [
        { user_id: 'other', book_hash: 'b1' },
        { user_id: 'me', book_hash: 'b2' },
      ],
    });

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await result.current.pullChanges(
        'books',
        5000,
        () => {},
        () => {},
      );
    });

    await waitFor(() => {
      expect(result.current.syncedBooks).not.toBeNull();
    });

    const books = result.current.syncedBooks as unknown as Array<{ user_id?: string }>;
    expect(books).toHaveLength(1);
    expect(books.every((b) => b.user_id === 'me')).toBe(true);
  });

  test('drops foreign-user note rows', async () => {
    pullChangesSpy.mockResolvedValue({
      notes: [
        { user_id: 'other', book_hash: 'n1', id: 'x' },
        { user_id: 'me', book_hash: 'n2', id: 'y' },
      ],
    });

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await result.current.pullChanges(
        'notes',
        5000,
        () => {},
        () => {},
      );
    });

    await waitFor(() => {
      expect(result.current.syncedNotes).not.toBeNull();
    });

    const notes = result.current.syncedNotes as unknown as Array<{ user_id?: string }>;
    expect(notes).toHaveLength(1);
    expect(notes.every((n) => n.user_id === 'me')).toBe(true);
  });
});
