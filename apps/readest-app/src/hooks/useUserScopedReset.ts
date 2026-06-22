import { useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { migrateIntoNamespace } from '@/application/services/library/userDataMigration';
import { setCurrentUserNamespace, getCurrentUserNamespace } from '@/services/userNamespace';
import { useLibraryStore } from '@/store/libraryStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * Effect-only hook.
 *
 * Whenever the signed-in user id changes (including → null on sign-out):
 *   1. Sets the storage namespace so all subsequent disk I/O is scoped to the
 *      new user.
 *   2. Drops the previous user's in-memory data immediately (privacy: user B
 *      must never see user A's books).
 *   3. Runs the one-time, idempotent namespace migration so any legacy /
 *      anonymous data is moved into the new namespace on disk.
 *   4. Flips `libraryLoaded` to false again AFTER migration completes so
 *      `useLibrary` reloads from the now-populated namespace.
 *
 * While `isLoading` is true (session resolving) the hook does nothing — acting
 * on a transient `null` would churn stores and fire migrations unnecessarily.
 */
export function useUserScopedReset(): void {
  const { user, isLoading } = useAuth();
  const runEffect = useRunEffect();

  // `undefined` = not yet established; `null` = signed out; `string` = user id.
  const lastIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // Wait for the session to resolve before acting.
    if (isLoading) return;

    const id = user?.id ?? null;

    // No change — nothing to do.
    if (lastIdRef.current === id) return;

    lastIdRef.current = id;

    // 1. Establish the new namespace FIRST so all subsequent disk I/O is
    //    scoped to the correct user.
    setCurrentUserNamespace(id);

    // 2. Immediately drop the previous user's in-memory data.
    useBookDataStore.getState().clearAll();
    useLibraryStore.getState().resetForUserSwitch(); // flips libraryLoaded → false

    // 2b. Reset ONLY the global incremental-pull cursors so the switched-in
    //     user does a full pull. These three live in GLOBAL (not per-user)
    //     settings; if left at the previous user's values, B's first
    //     incremental pull reuses A's `since` and MISSES B's older rows. We
    //     mutate just the three cursors in place and persist — every other
    //     setting (device ids, view settings, ai, kosync, etc.) is untouched.
    const settingsStore = useSettingsStore.getState();
    const settings = settingsStore.settings;
    settings.lastSyncedAtBooks = 0;
    settings.lastSyncedAtConfigs = 0;
    settings.lastSyncedAtNotes = 0;
    settingsStore.setSettings(settings);
    void settingsStore.saveSettings(settings);

    // 3. Run the migration asynchronously, then force a second
    //    resetForUserSwitch() so useLibrary (re)loads the migrated data even
    //    if it already raced to load an empty store between steps 2 and 3.
    let cancelled = false;
    void (async () => {
      try {
        await runEffect(migrateIntoNamespace(getCurrentUserNamespace()));
      } catch (err) {
        console.error('user-scoped migration failed', err);
      }
      if (cancelled) return;
      // Force useLibrary to (re)load now that the namespace's data is on disk.
      useLibraryStore.getState().resetForUserSwitch();
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, isLoading, runEffect]);
}
