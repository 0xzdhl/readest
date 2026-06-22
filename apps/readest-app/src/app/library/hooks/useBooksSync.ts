import { useCallback, useEffect, useRef } from 'react';
import { Effect } from 'effect';
import type { Book } from '@/domain/book';
import { useSync } from '@/hooks/useSync';
import { useAuth } from '@/context/AuthContext';
import { useRunEffect } from '@/context/EffectRuntimeProvider';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { CoverService } from '@/application/services/CoverService';
import { CloudService } from '@/application/services/CloudService';
import { useLibraryStore } from '@/store/libraryStore';
import { useTranslation } from '@/hooks/useTranslation';
import { SYNC_BOOKS_INTERVAL_SEC } from '@/services/constants';
import { throttle } from '@/utils/throttle';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import { getCurrentUserNamespace } from '@/services/userNamespace';

/**
 * Merge a synced (server) book onto the local copy that shares its hash.
 *
 * The base field merge mirrors the server's last-write-wins orientation: when
 * the synced row is at least as new (`matchingBook.updatedAt >= oldBook.updatedAt`)
 * the server fields win, otherwise the local fields win.
 *
 * The `deletedAt` (tombstone) field is then resolved SEPARATELY with the same
 * LWW rule the server applies in `lwwSetWhere` (src/app/api/sync.ts): a delete
 * only wins when it is a GENUINELY NEWER delete. This prevents a stale or
 * cross-user-contaminated tombstone — whose `updatedAt` is not newer than the
 * local book — from silently hiding a present, uploaded book (which
 * `visibleLibrary.filter(!deletedAt)` would then drop, making it "disappear"
 * on refresh until a clean pull re-merged it without the tombstone).
 *
 * Pure and exported for unit testing. The caller is responsible for stamping
 * `syncedAt`.
 */
export const mergeSyncedBook = (oldBook: Book, matchingBook: Book): Book => {
  const serverIsNewer = matchingBook.updatedAt >= oldBook.updatedAt;
  const merged: Book = serverIsNewer
    ? { ...oldBook, ...matchingBook }
    : { ...matchingBook, ...oldBook };

  // Resolve the tombstone independently with last-write-wins on deletedAt.
  const localDeletedAt = oldBook.deletedAt ?? null;
  const syncedDeletedAt = matchingBook.deletedAt ?? null;

  if (syncedDeletedAt != null) {
    // The synced row carries a tombstone. It may only DROP the local book when
    // it is a genuinely newer delete (matchingBook at least as new AND its
    // deletedAt strictly newer than any local delete). A stale or
    // cross-user-contaminated tombstone whose updatedAt is not newer than the
    // local book must NOT hide a present book.
    const syncedDeleteWins =
      serverIsNewer && syncedDeletedAt > (localDeletedAt ?? 0);
    merged.deletedAt = syncedDeleteWins ? syncedDeletedAt : localDeletedAt;
  } else if (serverIsNewer) {
    // The synced row is the LWW winner and is LIVE (no tombstone): adopt its
    // live state, which clears any older local delete (e.g. a re-uploaded book).
    merged.deletedAt = null;
  } else {
    // Local is the LWW winner: keep the local book's own deletedAt.
    merged.deletedAt = localDeletedAt;
  }

  return merged;
};

/**
 * Reconcile the sync-processed library against the LIVE store state read at
 * apply time, so a concurrent write that happened during `updateLibrary`'s
 * awaits (cover downloads, etc.) can never be lost.
 *
 * `processed` is the array `updateLibrary` built from the (possibly stale)
 * `liveLibrary` snapshot it captured at the start. `liveAtApply` is
 * `useLibraryStore.getState().library` re-read immediately before committing.
 *
 * Guarantee: every book present in `liveAtApply` survives. For a shared hash
 * the `processed` (already sync-merged) version wins; any book that exists
 * live but is absent from `processed` (e.g. a book imported / uploaded
 * concurrently) is appended rather than dropped. This is what stops a
 * just-uploaded book from transiently DISAPPEARING when a sync apply commits a
 * stale snapshot over it.
 *
 * Pure and exported for unit testing.
 */
export const reconcileSyncedLibrary = (processed: Book[], liveAtApply: Book[]): Book[] => {
  const processedHashes = new Set(processed.map((book) => book.hash));
  const liveOnly = liveAtApply.filter((book) => !processedHashes.has(book.hash));
  // Processed books first (preserves the sync-ordered merge), then any live
  // book the stale snapshot missed.
  return [...processed, ...liveOnly];
};

export const useBooksSync = () => {
  const _ = useTranslation();
  const { user } = useAuth();
  const runEffect = useRunEffect();
  const { library, isSyncing, libraryLoaded } = useLibraryStore();
  const { setLibrary, setIsSyncing, setSyncProgress } = useLibraryStore();
  const { useSyncInited, syncedBooks, syncBooks, lastSyncedAtBooks } = useSync();
  const isPullingRef = useRef(false);

  const getNewBooks = useCallback(() => {
    if (!user) return {};
    const st = useLibraryStore.getState();
    if (!st.libraryLoaded || st.loadedNamespace !== getCurrentUserNamespace()) return {};
    const library = st.library;
    const newBooks = library.filter(
      (book) =>
        !book.syncedAt ||
        lastSyncedAtBooks < book.updatedAt ||
        lastSyncedAtBooks < (book.deletedAt ?? 0),
    );
    return {
      books: newBooks,
      lastSyncedAt: lastSyncedAtBooks,
    };
  }, [user, lastSyncedAtBooks]);

  const pullLibrary = useCallback(
    async (fullRefresh = false, verbose = false) => {
      if (!user) return;
      if (isPullingRef.current) return;
      try {
        isPullingRef.current = true;
        const library = useLibraryStore.getState().library;
        const since = (libraryLoaded && library.length === 0) || fullRefresh ? 0 : undefined;
        const syncedBooksCount = await syncBooks([], 'pull', since);
        if (verbose) {
          eventDispatcher.dispatch('toast', {
            type: 'info',
            message: _('{{count}} book(s) synced', { count: syncedBooksCount }),
          });
        }
      } finally {
        isPullingRef.current = false;
      }
    },
    [_, user, libraryLoaded, syncBooks],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleAutoSync = useCallback(
    throttle(
      async () => {
        if (isPullingRef.current) return;
        const _st = useLibraryStore.getState();
        if (!_st.libraryLoaded || _st.loadedNamespace !== getCurrentUserNamespace()) return;
        const newBooks = getNewBooks();
        if (!newBooks.lastSyncedAt) return;
        isPullingRef.current = true;
        try {
          await syncBooks(newBooks.books, 'both');
        } finally {
          isPullingRef.current = false;
        }
      },
      SYNC_BOOKS_INTERVAL_SEC * 1000,
      { emitLast: true },
    ),
    [syncBooks],
  );

  useEffect(() => {
    if (!user) return;
    if (isPullingRef.current) return;
    handleAutoSync();
  }, [user, library, handleAutoSync]);

  const pushLibrary = useCallback(async () => {
    if (!user) return;
    const st = useLibraryStore.getState();
    if (!st.libraryLoaded || st.loadedNamespace !== getCurrentUserNamespace()) return;
    const newBooks = getNewBooks();
    if (newBooks.lastSyncedAt) {
      await syncBooks(newBooks?.books, 'push');
    }
  }, [user, syncBooks, getNewBooks]);

  useEffect(() => {
    if (!user || !useSyncInited || !libraryLoaded) return;
    pullLibrary();
  }, [user, useSyncInited, libraryLoaded, pullLibrary]);

  const updateLibrary = useCallback(async () => {
    if (!syncedBooks?.length) return;

    // Process old books first so that when we update the library the order is preserved
    syncedBooks.sort((a, b) => a.updatedAt - b.updatedAt);
    const bookHashesInSynced = new Set(syncedBooks.map((book) => book.hash));
    const liveLibrary = useLibraryStore.getState().library;
    const oldBooks = liveLibrary.filter((book) => bookHashesInSynced.has(book.hash));
    const oldBooksNeedsDownload = oldBooks.filter((book) => {
      return !book.deletedAt && book.uploadedAt && !book.coverDownloadedAt;
    });

    const processOldBook = async (oldBook: Book) => {
      const matchingBook = syncedBooks.find((newBook) => newBook.hash === oldBook.hash);
      if (matchingBook) {
        if (!matchingBook.deletedAt && matchingBook.uploadedAt && !oldBook.coverDownloadedAt) {
          oldBook.coverImageUrl = await runEffect(
            Effect.flatMap(CoverService, (c) => c.generateCoverImageUrl(oldBook)),
          );
        }
        const mergedBook = mergeSyncedBook(oldBook, matchingBook);
        mergedBook.syncedAt = Date.now();
        return mergedBook;
      }
      return oldBook;
    };

    const oldBooksBatchSize = 100;
    for (let i = 0; i < oldBooksNeedsDownload.length; i += oldBooksBatchSize) {
      const batch = oldBooksNeedsDownload.slice(i, i + oldBooksBatchSize);
      await runEffect(Effect.flatMap(CloudService, (c) => c.downloadBookCovers(batch)));
    }

    // Reconcile against the LIVE store read at apply time (not the possibly
    // stale `liveLibrary` snapshot captured before the cover-download awaits):
    // a book imported/uploaded concurrently during those awaits must not be
    // dropped by committing the stale set. See reconcileSyncedLibrary.
    const updatedLibrary = reconcileSyncedLibrary(
      await Promise.all(liveLibrary.map(processOldBook)),
      useLibraryStore.getState().library,
    );
    setLibrary(updatedLibrary);
    void runEffect(Effect.flatMap(LibraryRepository, (r) => r.save(updatedLibrary)));

    const bookHashesInLibrary = new Set(updatedLibrary.map((book) => book.hash));
    const newBooks = syncedBooks.filter(
      (newBook) =>
        !bookHashesInLibrary.has(newBook.hash) && newBook.uploadedAt && !newBook.deletedAt,
    );

    const processNewBook = async (newBook: Book) => {
      newBook.coverImageUrl = await runEffect(
        Effect.flatMap(CoverService, (c) => c.generateCoverImageUrl(newBook)),
      );
      newBook.syncedAt = Date.now();
      updatedLibrary.push(newBook);
    };

    if (newBooks.length > 0) {
      setIsSyncing(true);
    }
    try {
      const batchSize = 10;
      for (let i = 0; i < newBooks.length; i += batchSize) {
        const batch = newBooks.slice(i, i + batchSize);
        await runEffect(Effect.flatMap(CloudService, (c) => c.downloadBookCovers(batch)));
        await Promise.all(batch.map(processNewBook));
        const progress = Math.min((i + batchSize) / newBooks.length, 1);
        setSyncProgress(progress);
        // Reconcile against live state at apply time so a concurrent write
        // during the download/process awaits is preserved, not clobbered.
        const committed = reconcileSyncedLibrary(
          updatedLibrary,
          useLibraryStore.getState().library,
        );
        setLibrary(committed);
        void runEffect(Effect.flatMap(LibraryRepository, (r) => r.save(committed)));
      }
    } catch (err) {
      console.error('Error updating new books:', err);
    } finally {
      if (newBooks.length > 0) {
        setIsSyncing(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedBooks]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedUpdateLibrary = useCallback(
    debounce(() => updateLibrary(), 10000),
    [updateLibrary],
  );

  useEffect(() => {
    // Defer processing synced books until the library has been loaded from
    // disk. Otherwise updateLibrary runs against an empty `library`
    // closure, treats every synced book as new, and the resulting
    // `setLibrary([only sync books])` can race with initLibrary's
    // `setLibrary([disk books])` — the empty-merged save can land on disk
    // afterwards and overwrite the loaded snapshot. The synced books stay
    // queued in `syncedBooks` state; this effect re-fires when
    // libraryLoaded flips to true and processes them then.
    if (!libraryLoaded) return;
    if (isSyncing) {
      debouncedUpdateLibrary();
    } else {
      updateLibrary();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedBooks, updateLibrary, debouncedUpdateLibrary, libraryLoaded]);

  return { pullLibrary, pushLibrary };
};
