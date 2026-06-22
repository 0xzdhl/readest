/**
 * TDD test for useUserScopedReset.
 *
 * Verifies that when the signed-in user id changes:
 *  1. setCurrentUserNamespace is called with the new id.
 *  2. The library store is reset (libraryLoaded === false).
 *  3. migrateIntoNamespace is called with the new namespace.
 *  4. While isLoading, nothing fires.
 *  5. Re-render with the SAME id does not re-trigger.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Effect } from 'effect';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any `import` of the modules they
// replace, because Vitest hoists vi.mock() calls.
// ---------------------------------------------------------------------------

const setCurrentUserNamespaceSpy = vi.fn<(userId: string | null) => void>();
const getCurrentUserNamespaceMock = vi.fn<() => string>(() => 'local');

vi.mock('@/services/userNamespace', () => ({
  setCurrentUserNamespace: (id: string | null) => setCurrentUserNamespaceSpy(id),
  getCurrentUserNamespace: () => getCurrentUserNamespaceMock(),
  LOCAL_NAMESPACE: 'local',
}));

// Auth mock — controlled by each test via `useAuthMock`.
const useAuthMock = vi.fn<() => { user: { id: string } | null; isLoading: boolean }>();

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

// runEffect mock — resolves immediately.
const runEffectMock = vi.fn<(program: unknown) => Promise<void>>(async () => undefined);
vi.mock('@/context/EffectRuntimeProvider', () => ({
  useRunEffect: () => runEffectMock,
}));

// Migration mock — returns a sentinel Effect.
const migrateIntoNamespaceMock = vi.fn<(ns: string) => Effect.Effect<void>>((ns) =>
  Effect.succeed(undefined as void).pipe(Effect.tap(() => Effect.succeed(ns))),
);
vi.mock('@/application/services/library/userDataMigration', () => ({
  migrateIntoNamespace: (ns: string) => migrateIntoNamespaceMock(ns),
}));

// Library store — track resetForUserSwitch calls.
const libraryStoreState = {
  library: [] as unknown[],
  libraryLoaded: true,
  loadedNamespace: null as string | null,
};

const resetForUserSwitchSpy = vi.fn<() => void>(() => {
  libraryStoreState.libraryLoaded = false;
  libraryStoreState.loadedNamespace = null;
  libraryStoreState.library = [];
});

vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: Object.assign(() => libraryStoreState, {
    getState: () => ({ ...libraryStoreState, resetForUserSwitch: resetForUserSwitchSpy }),
  }),
}));

// BookData store — track clearAll calls.
const clearAllSpy = vi.fn<() => void>();

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: Object.assign(() => ({}), {
    getState: () => ({ clearAll: clearAllSpy }),
  }),
}));

// Settings store — track cursor resets and assert non-cursor settings survive.
type SettingsShape = {
  version: number;
  lastSyncedAtBooks: number;
  lastSyncedAtConfigs: number;
  lastSyncedAtNotes: number;
  deviceId: string;
  someOtherSetting: string;
  [key: string]: unknown;
};

const settingsStoreState = {
  settings: {} as SettingsShape,
  setSettings: vi.fn<(s: SettingsShape) => void>((s) => {
    settingsStoreState.settings = s;
  }),
  saveSettings: vi.fn<(s: SettingsShape) => Promise<void>>(async () => {}),
};

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: Object.assign(() => settingsStoreState, {
    getState: () => settingsStoreState,
  }),
}));

// ---------------------------------------------------------------------------
// Import the hook AFTER mocks are registered.
// ---------------------------------------------------------------------------
import { useUserScopedReset } from '@/hooks/useUserScopedReset';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState() {
  libraryStoreState.libraryLoaded = true;
  libraryStoreState.loadedNamespace = null;
  libraryStoreState.library = [];
  setCurrentUserNamespaceSpy.mockClear();
  runEffectMock.mockClear();
  migrateIntoNamespaceMock.mockClear();
  resetForUserSwitchSpy.mockClear();
  clearAllSpy.mockClear();
  getCurrentUserNamespaceMock.mockReturnValue('local');
  // Seed settings with non-zero cursors AND unrelated settings that must survive.
  settingsStoreState.settings = {
    version: 7,
    lastSyncedAtBooks: 111,
    lastSyncedAtConfigs: 222,
    lastSyncedAtNotes: 333,
    deviceId: 'device-xyz',
    someOtherSetting: 'keep-me',
  };
  settingsStoreState.setSettings.mockClear();
  settingsStoreState.saveSettings.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('useUserScopedReset', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test('does nothing while isLoading is true', async () => {
    useAuthMock.mockReturnValue({ user: null, isLoading: true });

    renderHook(() => useUserScopedReset());

    await act(async () => {
      await Promise.resolve();
    });

    expect(setCurrentUserNamespaceSpy).not.toHaveBeenCalled();
    expect(resetForUserSwitchSpy).not.toHaveBeenCalled();
    expect(migrateIntoNamespaceMock).not.toHaveBeenCalled();
  });

  test('re-render with same id does not re-trigger reset', async () => {
    useAuthMock.mockReturnValue({ user: { id: 'A' }, isLoading: false });
    getCurrentUserNamespaceMock.mockReturnValue('A');

    const { rerender } = renderHook(() => useUserScopedReset());

    await act(async () => {
      await Promise.resolve();
    });

    setCurrentUserNamespaceSpy.mockClear();
    resetForUserSwitchSpy.mockClear();
    migrateIntoNamespaceMock.mockClear();

    // Re-render with the same user id
    useAuthMock.mockReturnValue({ user: { id: 'A' }, isLoading: false });
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    // Should NOT have fired again
    expect(setCurrentUserNamespaceSpy).not.toHaveBeenCalled();
    expect(resetForUserSwitchSpy).not.toHaveBeenCalled();
    expect(migrateIntoNamespaceMock).not.toHaveBeenCalled();
  });

  test('flipping user id A->B triggers namespace switch, store reset, and migration', async () => {
    // Start as user A
    useAuthMock.mockReturnValue({ user: { id: 'A' }, isLoading: false });
    getCurrentUserNamespaceMock.mockReturnValue('A');

    const { rerender } = renderHook(() => useUserScopedReset());

    await act(async () => {
      await Promise.resolve();
    });

    // Now switch to user B
    setCurrentUserNamespaceSpy.mockClear();
    resetForUserSwitchSpy.mockClear();
    migrateIntoNamespaceMock.mockClear();
    clearAllSpy.mockClear();
    getCurrentUserNamespaceMock.mockReturnValue('B');

    useAuthMock.mockReturnValue({ user: { id: 'B' }, isLoading: false });
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    // 1. Namespace set to 'B'
    expect(setCurrentUserNamespaceSpy).toHaveBeenCalledWith('B');

    // 2. In-memory data cleared
    expect(clearAllSpy).toHaveBeenCalled();
    expect(resetForUserSwitchSpy).toHaveBeenCalled();
    expect(libraryStoreState.libraryLoaded).toBe(false);

    // 3. Migration ran for the new namespace
    expect(migrateIntoNamespaceMock).toHaveBeenCalledWith('B');
  });

  test('signing out (id->null) sets namespace to null and resets stores', async () => {
    // Start as user A
    useAuthMock.mockReturnValue({ user: { id: 'A' }, isLoading: false });
    getCurrentUserNamespaceMock.mockReturnValue('A');

    const { rerender } = renderHook(() => useUserScopedReset());

    await act(async () => {
      await Promise.resolve();
    });

    setCurrentUserNamespaceSpy.mockClear();
    resetForUserSwitchSpy.mockClear();
    migrateIntoNamespaceMock.mockClear();
    clearAllSpy.mockClear();
    getCurrentUserNamespaceMock.mockReturnValue('local');

    // Sign out
    useAuthMock.mockReturnValue({ user: null, isLoading: false });
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    expect(setCurrentUserNamespaceSpy).toHaveBeenCalledWith(null);
    expect(clearAllSpy).toHaveBeenCalled();
    expect(resetForUserSwitchSpy).toHaveBeenCalled();
    expect(migrateIntoNamespaceMock).toHaveBeenCalledWith('local');
  });

  test('A->B switch resets ONLY the sync cursors to 0, preserving other settings', async () => {
    useAuthMock.mockReturnValue({ user: { id: 'A' }, isLoading: false });
    getCurrentUserNamespaceMock.mockReturnValue('A');

    const { rerender } = renderHook(() => useUserScopedReset());

    await act(async () => {
      await Promise.resolve();
    });

    settingsStoreState.setSettings.mockClear();
    settingsStoreState.saveSettings.mockClear();
    getCurrentUserNamespaceMock.mockReturnValue('B');

    useAuthMock.mockReturnValue({ user: { id: 'B' }, isLoading: false });
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    // The three pull cursors are reset so user B does a full pull.
    expect(settingsStoreState.settings.lastSyncedAtBooks).toBe(0);
    expect(settingsStoreState.settings.lastSyncedAtConfigs).toBe(0);
    expect(settingsStoreState.settings.lastSyncedAtNotes).toBe(0);

    // Non-cursor settings must NOT be clobbered.
    expect(settingsStoreState.settings.version).toBe(7);
    expect(settingsStoreState.settings.deviceId).toBe('device-xyz');
    expect(settingsStoreState.settings.someOtherSetting).toBe('keep-me');

    // The reset must be persisted.
    expect(settingsStoreState.saveSettings).toHaveBeenCalled();
  });

  test('signing out (A->null) also resets the sync cursors to 0', async () => {
    useAuthMock.mockReturnValue({ user: { id: 'A' }, isLoading: false });
    getCurrentUserNamespaceMock.mockReturnValue('A');

    const { rerender } = renderHook(() => useUserScopedReset());

    await act(async () => {
      await Promise.resolve();
    });

    settingsStoreState.setSettings.mockClear();
    settingsStoreState.saveSettings.mockClear();
    getCurrentUserNamespaceMock.mockReturnValue('local');

    useAuthMock.mockReturnValue({ user: null, isLoading: false });
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    expect(settingsStoreState.settings.lastSyncedAtBooks).toBe(0);
    expect(settingsStoreState.settings.lastSyncedAtConfigs).toBe(0);
    expect(settingsStoreState.settings.lastSyncedAtNotes).toBe(0);
    expect(settingsStoreState.settings.deviceId).toBe('device-xyz');
  });
});
