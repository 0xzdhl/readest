import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useSyncContext } from '@/context/SyncContext';
import type { SyncData, SyncOp, SyncResult, SyncType } from '@/libs/sync';
import { isSyncCategoryEnabled } from '@/services/sync/syncCategories';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { transformBookConfigFromDB } from '@/utils/transform';
import { transformBookNoteFromDB } from '@/utils/transform';
import { transformBookFromDB } from '@/utils/transform';
import type { DBBook, DBBookConfig, DBBookNote } from '@/types/records';
import type { Book, BookConfig, BookDataRecord, BookNote } from '@/domain/book';
import { navigateToLogin } from '@/utils/nav';
import { useReaderStore } from '@/store/readerStore';
import { useAuth } from '@/context/AuthContext';

/**
 * Defense-in-depth wire-row filter. The server pull/push already scope by
 * `eq(userId)`, but the DB may run as a superuser (local) or with RLS that can
 * be bypassed; never let another user's record reach the local domain state.
 * Rows with no `user_id` (legacy/local) are always kept; only a present,
 * foreign `user_id` is dropped.
 */
const keepOwnUserRow = <T extends { user_id?: string | null }>(
  rows: T[] | null | undefined,
  userId: string | null | undefined,
): T[] | undefined => {
  if (!rows) return undefined;
  if (!userId) return rows;
  return rows.filter((row) => !row.user_id || row.user_id === userId);
};

const transformsFromDB = {
  books: transformBookFromDB,
  notes: transformBookNoteFromDB,
  configs: transformBookConfigFromDB,
};

const computeMaxTimestamp = (records: BookDataRecord[]): number => {
  let maxTime = 0;
  for (const rec of records) {
    if (rec.updated_at) {
      const updatedTime = new Date(rec.updated_at).getTime();
      maxTime = Math.max(maxTime, updatedTime);
    }
    if (rec.deleted_at) {
      const deletedTime = new Date(rec.deleted_at).getTime();
      maxTime = Math.max(maxTime, deletedTime);
    }
  }
  return maxTime;
};

export const countSyncedRecords = (
  type: SyncType,
  records: ReadonlyArray<{ deleted_at?: string | number | null; uploaded_at?: string | null }> | null,
): number =>
  records?.filter((rec) => !rec.deleted_at && (type !== 'books' || rec.uploaded_at != null)).length ??
  0;

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
export function useSync(bookKey?: string) {
  const router = useRouter();
  const { user } = useAuth();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const { getConfig, setConfig } = useBookDataStore();
  const { setIsSyncing, setSyncError: mirrorSyncError } = useReaderStore();
  const config = bookKey ? getConfig(bookKey) : null;

  const [syncingBooks, setSyncingBooks] = useState(false);
  const [syncingConfigs, setSyncingConfigs] = useState(false);
  const [syncingNotes, setSyncingNotes] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAtBooks, setLastSyncedAtBooks] = useState<number>(0);
  const [lastSyncedAtConfigs, setLastSyncedAtConfigs] = useState<number>(0);
  const [lastSyncedAtNotes, setLastSyncedAtNotes] = useState<number>(0);
  const [lastSyncedAtInited, setLastSyncedAtInited] = useState(false);
  // Tracks which authenticated user id the in-memory cursors were initialised
  // for. When the user changes (account switch / sign-out), the init effect
  // must re-run so the cursors are re-read from the (per-switch reset) settings
  // — otherwise the switched-in user would reuse the previous user's `since`.
  const initedForUserRef = useRef<string | null | undefined>(undefined);

  const [syncing, setSyncing] = useState(false);
  // null means unsynced, empty array means synced no changes
  const [syncResult, setSyncResult] = useState<SyncResult>({
    books: null,
    configs: null,
    notes: null,
  });
  const [syncedBooks, setSyncedBooks] = useState<Book[] | null>(null);
  const [syncedConfigs, setSyncedConfigs] = useState<BookConfig[] | null>(null);
  const [syncedNotes, setSyncedNotes] = useState<BookNote[] | null>(null);

  const { syncClient } = useSyncContext();

  // Mirror the AGGREGATE in-flight state to the reader store so the sync icon
  // spins for ANY operation. A manual "sync now" is pull-dominated, and pulls
  // flip only syncingBooks/Configs/Notes — never the push-only `syncing` flag.
  // Watching just `syncing` therefore left the mirrored flag (and the icon)
  // dormant during a manual sync.
  const isSyncingAggregate = syncingBooks || syncingConfigs || syncingNotes;
  useEffect(() => {
    if (!bookKey) return;
    setIsSyncing(bookKey, isSyncingAggregate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey, isSyncingAggregate]);

  // Mirror the last sync error so the reader's sync menu item (which subscribes
  // to the reader store) can present a "Sync failed" state without holding its
  // own useSync instance.
  useEffect(() => {
    if (!bookKey) return;
    mirrorSyncError(bookKey, syncError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey, syncError]);

  useEffect(() => {
    if (!settings.version) return;
    if (bookKey && !config?.location) return;
    const userId = user?.id ?? null;
    // Init once per user. Re-run the full init (re-reading the settings cursors
    // and applying the same 3-day/one-day look-back logic) whenever the
    // authenticated user id changes, but NOT on ordinary re-renders for the
    // same user.
    if (lastSyncedAtInited && initedForUserRef.current === userId) return;
    initedForUserRef.current = userId;

    const lastSyncedBooksAt = settings.lastSyncedAtBooks ?? 0;
    const lastSyncedConfigsAt = config?.lastSyncedAtConfig ?? settings.lastSyncedAtConfigs ?? 0;
    const lastSyncedNotesAt = config?.lastSyncedAtNotes ?? settings.lastSyncedAtNotes ?? 0;
    const now = Date.now();
    setLastSyncedAtBooks(
      now - lastSyncedBooksAt > 3 * ONE_DAY_IN_MS ? 0 : lastSyncedBooksAt - ONE_DAY_IN_MS,
    );
    setLastSyncedAtConfigs(
      now - lastSyncedConfigsAt > 3 * ONE_DAY_IN_MS ? 0 : lastSyncedConfigsAt - ONE_DAY_IN_MS,
    );
    setLastSyncedAtNotes(
      now - lastSyncedNotesAt > 3 * ONE_DAY_IN_MS ? 0 : lastSyncedNotesAt - ONE_DAY_IN_MS,
    );
    setLastSyncedAtInited(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey, settings, config, user?.id]);

  // bookId is for configs and notes only, if bookId is provided, only pull changes for that book
  // and update the lastSyncedAt for that book in the book config
  const pullChanges = async (
    type: SyncType,
    since: number,
    setLastSyncedAt: React.Dispatch<React.SetStateAction<number>>,
    setSyncing: React.Dispatch<React.SetStateAction<boolean>>,
    bookId?: string,
    metaHash?: string,
  ) => {
    setSyncing(true);
    setSyncError(null);

    try {
      const result = await syncClient.pullChanges(since, type, bookId, metaHash);
      setSyncResult({ ...syncResult, [type]: result[type] });
      const records = result[type];
      if (since > 1000 && !records?.length) return 0;
      // On an empty result we must NOT advance to the local client clock:
      // a fast/skewed client would push lastSyncedAt into the future and cause
      // later incremental pulls to skip other devices' records whose true
      // timestamps fall below that future value. Stay conservative by keeping
      // the queried `since` (for an initial pull this means re-running the full
      // pull until real records arrive — correctness over efficiency on empty
      // accounts). Only real record timestamps ever move the cursor forward.
      const maxTime = records?.length ? computeMaxTimestamp(records) : since;
      setLastSyncedAt(maxTime);

      // due to closures in React hooks the settings might be stale
      // we need to fetch the latest settings from store
      const settings = useSettingsStore.getState().settings;
      switch (type) {
        case 'books':
          settings.lastSyncedAtBooks = maxTime;
          setSettings(settings);
          break;
        case 'configs':
          if (!bookId) {
            settings.lastSyncedAtConfigs = maxTime;
            setSettings(settings);
          } else if (bookKey) {
            setConfig(bookKey, { lastSyncedAtConfig: maxTime });
          }
          break;
        case 'notes':
          if (!bookId) {
            settings.lastSyncedAtNotes = maxTime;
            setSettings(settings);
          } else if (bookKey) {
            setConfig(bookKey, { lastSyncedAtNotes: maxTime });
          }
          break;
      }
      return countSyncedRecords(type, records);
    } catch (err: unknown) {
      console.error(err);
      if (err instanceof Error) {
        if (err.message.includes('Not authenticated') && settings.keepLogin) {
          settings.keepLogin = false;
          setSettings(settings);
          navigateToLogin(router);
        }
        setSyncError(err.message || `Error pulling ${type}`);
      } else {
        setSyncError(`Error pulling ${type}`);
      }
      return 0;
    } finally {
      setSyncing(false);
      saveSettings(settings);
    }
  };

  const pushChanges = async (payload: SyncData): Promise<boolean> => {
    setSyncing(true);
    setSyncError(null);

    try {
      const result = await syncClient.pushChanges(payload);
      setSyncResult(result);
      return true;
    } catch (err: unknown) {
      console.error(err);
      if (err instanceof Error) {
        setSyncError(err.message || 'Error pushing changes');
      } else {
        setSyncError('Error pushing changes');
      }
      return false;
    } finally {
      setSyncing(false);
    }
  };

  const syncBooks = useCallback(
    async (books?: Book[], op: SyncOp = 'both', since?: number) => {
      if (!lastSyncedAtInited) return;
      if (!isSyncCategoryEnabled('book')) return;
      if ((op === 'push' || op === 'both') && books?.length) {
        await pushChanges({ books });
      }
      if (op === 'pull' || op === 'both') {
        return await pullChanges(
          'books',
          since ?? lastSyncedAtBooks + 1,
          setLastSyncedAtBooks,
          setSyncingBooks,
        );
      }
      return;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastSyncedAtInited, lastSyncedAtBooks],
  );

  const syncConfigs = useCallback(
    async (bookConfigs?: BookConfig[], bookId?: string, metaHash?: string, op: SyncOp = 'both') => {
      if (!bookId && !lastSyncedAtInited) return;
      if (!isSyncCategoryEnabled('progress')) return;
      if ((op === 'push' || op === 'both') && bookConfigs?.length) {
        const pushed = await pushChanges({ configs: bookConfigs });
        if (pushed && bookId && bookKey) {
          setConfig(bookKey, { lastPushedAtConfig: Date.now() });
        }
      }
      if (op === 'pull' || op === 'both') {
        await pullChanges(
          'configs',
          lastSyncedAtConfigs,
          setLastSyncedAtConfigs,
          setSyncingConfigs,
          bookId,
          metaHash,
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastSyncedAtInited, lastSyncedAtConfigs],
  );

  const syncNotes = useCallback(
    async (bookNotes?: BookNote[], bookId?: string, metaHash?: string, op: SyncOp = 'both') => {
      if (!lastSyncedAtInited) return;
      if (!isSyncCategoryEnabled('note')) return;
      if ((op === 'push' || op === 'both') && bookNotes?.length) {
        const pushed = await pushChanges({ notes: bookNotes });
        if (pushed && bookId && bookKey) {
          setConfig(bookKey, { lastPushedAtNotes: Date.now() });
        }
      }
      if (op === 'pull' || op === 'both') {
        await pullChanges(
          'notes',
          lastSyncedAtNotes,
          setLastSyncedAtNotes,
          setSyncingNotes,
          bookId,
          metaHash,
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastSyncedAtInited, lastSyncedAtNotes],
  );

  useEffect(() => {
    if (!syncing && syncResult) {
      const { books: dbBooks, configs: dbBookConfigs, notes: dbBookNotes } = syncResult;
      const userId = user?.id;
      // Defense-in-depth: drop any wire row owned by a different user before it
      // is transformed into domain state. Null-user_id rows are kept.
      const ownBooks = keepOwnUserRow(dbBooks as unknown as DBBook[] | null, userId);
      const ownConfigs = keepOwnUserRow(dbBookConfigs as unknown as DBBookConfig[] | null, userId);
      const ownNotes = keepOwnUserRow(dbBookNotes as unknown as DBBookNote[] | null, userId);
      const books = ownBooks?.map((dbBook) => transformsFromDB['books'](dbBook));
      const configs = ownConfigs?.map((dbBookConfig) => transformsFromDB['configs'](dbBookConfig));
      const notes = ownNotes?.map((dbBookNote) => transformsFromDB['notes'](dbBookNote));
      if (books) setSyncedBooks(books);
      if (configs) setSyncedConfigs(configs);
      if (notes) setSyncedNotes(notes);
    }
  }, [syncResult, syncing, user?.id]);

  return {
    syncing: syncingBooks || syncingConfigs || syncingNotes,
    syncError,
    syncResult,
    syncedBooks,
    syncedConfigs,
    syncedNotes,
    lastSyncedAtBooks,
    lastSyncedAtNotes,
    lastSyncedAtConfigs,
    useSyncInited: lastSyncedAtInited,
    pullChanges,
    pushChanges,
    syncBooks,
    syncConfigs,
    syncNotes,
  };
}
