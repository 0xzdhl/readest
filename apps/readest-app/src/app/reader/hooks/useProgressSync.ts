import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useSync } from '@/hooks/useSync';
import { type BookConfig, FIXED_LAYOUT_FORMATS } from '@/domain/book';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { serializeConfig } from '@/utils/serializer';
import { CFI } from '@/libs/document';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import { DEFAULT_BOOK_SEARCH_CONFIG, SYNC_PROGRESS_INTERVAL_SEC } from '@/services/constants';
import { getXPointerFromCFI, resolveRemoteProgressCFI } from '@/utils/xcfi';

export const useProgressSync = (bookKey: string) => {
  const _ = useTranslation();
  const { getConfig, setConfig, getBookData } = useBookDataStore();
  const { getView, getProgress, setHoveredBookKey } = useReaderStore();
  const { settings } = useSettingsStore();
  const { syncedConfigs, syncConfigs } = useSync(bookKey);
  const { user } = useAuth();
  const progress = getProgress(bookKey);

  const configPulled = useRef(false);
  const hasPulledConfigOnce = useRef(false);

  const pushConfig = async (bookKey: string, config: BookConfig | null) => {
    const book = getBookData(bookKey)?.book;
    if (!config || !book || !user) return;
    const bookHash = bookKey.split('-')[0]!;
    const metaHash = book.metaHash;
    const newConfig = { ...config, bookHash, metaHash };
    const compressedConfig = JSON.parse(
      serializeConfig(newConfig, settings.globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG),
    );
    delete compressedConfig.booknotes;
    await syncConfigs([compressedConfig], bookHash, metaHash, 'push');
  };

  const pullConfig = async (bookKey: string) => {
    const book = getBookData(bookKey)?.book;
    if (!user || !book) return;
    const bookHash = bookKey.split('-')[0]!;
    const metaHash = book.metaHash;
    await syncConfigs([], bookHash, metaHash, 'pull');
  };

  // Push the latest local position straight to the cloud without depending on a
  // live foliate view. Used on close, where the view is already torn down: the
  // view is only needed to refresh the xpointer (best-effort, done in
  // `syncConfig` while reading), never to push the config itself.
  const pushCurrentProgress = async (bookKey: string) => {
    const config = getConfig(bookKey);
    const book = getBookData(bookKey)?.book;
    if (config && book && config.progress && config.progress[0] > 0) {
      await pushConfig(bookKey, config);
    }
  };

  const syncConfig = async () => {
    if (!configPulled.current) {
      pullConfig(bookKey);
    } else {
      // Skip pushes while previewing a deep-link target — the position in
      // memory reflects the annotation, not what the user is actually reading.
      if (useReaderStore.getState().getViewState(bookKey)?.previewMode) return;
      const config = getConfig(bookKey);
      const view = getView(bookKey);
      const book = getBookData(bookKey)?.book;
      if (config && view && book && config.progress && config.progress[0] > 0) {
        try {
          const contents = view.renderer.getContents();
          const primaryIndex = view.renderer.primaryIndex;
          const content = contents.find((x) => x.index === primaryIndex) ?? contents[0];
          if (content && !FIXED_LAYOUT_FORMATS.has(book.format)) {
            const { doc, index } = content;
            const xpointerResult = await getXPointerFromCFI(config.location!, doc, index || 0);
            config.xpointer = xpointerResult.xpointer;
          }
        } catch (error) {
          console.warn('Failed to convert CFI to XPointer', error);
        }
        pushConfig(bookKey, config);
      }
    }
  };

  const handleSyncBookProgress = async (event: CustomEvent) => {
    const { bookKey: syncBookKey } = event.detail;
    if (syncBookKey !== bookKey) return;
    // Drop any pending debounced auto-push first: once the book is closing the
    // view is torn down, so that timer would either never fire or fire stale.
    // Push the final position now so the last page reached before closing
    // reaches the cloud — mirrors useKOSync's `pushProgress.flush()` on close.
    // Then pull to reconcile any newer remote progress (this path also backs
    // the manual "sync now" menu action, which benefits from pushing first).
    handleAutoSync.cancel();
    await pushCurrentProgress(bookKey);
    configPulled.current = false;
    await pullConfig(bookKey);
  };

  // Push the final position to the cloud when the book is closed, then pull.
  useEffect(() => {
    eventDispatcher.on('sync-book-progress', handleSyncBookProgress);
    return () => {
      eventDispatcher.off('sync-book-progress', handleSyncBookProgress);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleAutoSync = useCallback(
    debounce(() => {
      syncConfig();
    }, SYNC_PROGRESS_INTERVAL_SEC * 1000),
    [],
  );

  // Push: auto-push progress when progress changes with a debounce
  useEffect(() => {
    if (!progress?.location || !user) return;
    handleAutoSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.location]);

  // Pull: pull progress once when the book is opened
  useEffect(() => {
    if (!progress || hasPulledConfigOnce.current) return;
    hasPulledConfigOnce.current = true;
    pullConfig(bookKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);

  const applyRemoteProgress = async (syncedConfigs: BookConfig[]) => {
    const config = getConfig(bookKey);
    const book = getBookData(bookKey)?.book;
    if (!syncedConfigs || syncedConfigs.length === 0 || !config || !book) return;

    const bookHash = bookKey.split('-')[0]!;
    const metaHash = book.metaHash;
    const syncedConfig = syncedConfigs.filter(
      (c) => c.bookHash === bookHash || c.metaHash === metaHash,
    )[0];
    if (syncedConfig) {
      const configCFI = config?.location;
      const bookData = getBookData(bookKey);
      const view = getView(bookKey);
      const contents = view?.renderer.getContents();
      const primaryIndex = view?.renderer.primaryIndex;
      const content = contents?.find((x) => x.index === primaryIndex) ?? contents?.[0];
      // Refine the remote position with its XPointer when possible, but never let
      // a conversion failure abort the apply — fall back to the location CFI so
      // the synced position still lands (and is not later clobbered by a re-push).
      const remoteCFILocation = await resolveRemoteProgressCFI(
        syncedConfig.location,
        syncedConfig.xpointer,
        content?.doc,
        content?.index,
        bookData?.bookDoc ?? undefined,
      );
      const filteredSyncedConfig = Object.fromEntries(
        Object.entries(syncedConfig).filter(([_, value]) => value !== null && value !== undefined),
      );
      // Last-write-wins on the reading position: the most recently written
      // config wins by updatedAt, even when its position is EARLIER in the book
      // (a deliberate backward seek / re-read). The position fields
      // (location/progress/xpointer) follow the same updatedAt winner as the
      // rest of the config. The previous CFI "never move backwards" veto
      // discarded a newer-but-earlier remote, then re-pushed the stale,
      // further-ahead local position — so the furthest-read position always won
      // and a deliberate backward sync oscillated (Bug 4).
      const remoteWins = syncedConfig.updatedAt >= config.updatedAt;
      if (!remoteWins) {
        // Local position is at least as new; never let an older remote move it.
        // xpointer travels with location/progress so the three never diverge.
        delete filteredSyncedConfig.location;
        delete filteredSyncedConfig.progress;
        delete filteredSyncedConfig.xpointer;
      }
      setConfig(
        bookKey,
        remoteWins ? { ...config, ...filteredSyncedConfig } : { ...filteredSyncedConfig, ...config },
      );
      // View nudge only (does NOT change what was persisted above): when the
      // adopted remote position is strictly AHEAD in the book, move the live
      // view forward and hint. Never yank the view backward mid-read — the
      // config already holds the LWW winner, so the next open lands correctly.
      if (remoteWins && remoteCFILocation && configCFI) {
        if (CFI.compare(configCFI, remoteCFILocation) < 0) {
          // While previewing a deep-link target, do NOT yank the view to the
          // remote position — the user came here to look at a specific
          // annotation. The local config still gets updated above; the next
          // open will resolve to the synced position normally.
          const isPreview = useReaderStore.getState().getViewState(bookKey)?.previewMode;
          if (view && !isPreview) {
            view.goTo(remoteCFILocation);
            setHoveredBookKey(null);
            eventDispatcher.dispatch('hint', {
              bookKey,
              message: _('Reading Progress Synced'),
            });
          }
        }
      }
    }
  };

  // Pull: proccess the pulled progress
  useEffect(() => {
    if (!configPulled.current && syncedConfigs) {
      configPulled.current = true;
      applyRemoteProgress(syncedConfigs).catch((error) => {
        console.error('Failed to apply remote progress', error);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedConfigs]);
};
