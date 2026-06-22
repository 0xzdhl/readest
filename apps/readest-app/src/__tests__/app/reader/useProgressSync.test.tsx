import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventDispatcher } from '@/utils/event';

// Shared mock surface for the hook's dependencies. The book is "open" with a
// real reading position (progress[0] > 0) but its foliate view is already gone
// (getView → null), exactly the state during/after a book close.
const h = vi.hoisted(() => {
  const config = {
    location: 'epubcfi(/6/4!/4/2)',
    progress: [5, 100] as [number, number],
    updatedAt: 1000,
  };
  return {
    config,
    // Drive the pulled remote configs and CFI ordering per-test. `syncedConfigs`
    // feeds the `useSync` mock; `cfiCompare` backs the `CFI.compare` mock so a
    // test can express "remote position is earlier than local".
    syncedConfigs: null as unknown[] | null,
    cfiCompare: ((_a: string, _b: string) => 0) as (a: string, b: string) => number,
    getCFIFromXPointer: vi.fn(async (..._args: unknown[]) => ''),
    syncConfigs: vi.fn(
      async (
        _configs?: unknown[],
        _bookId?: string,
        _metaHash?: string,
        _op?: 'push' | 'pull' | 'both',
      ) => {},
    ),
    syncBooks: vi.fn(async (_books?: unknown[], _op?: 'push' | 'pull' | 'both') => {}),
    getConfig: vi.fn(() => config),
    setConfig: vi.fn(),
    getBookData: vi.fn(
      (): { book: { metaHash: string; format: string }; bookDoc?: { sections: unknown[] } } => ({
        book: { metaHash: 'meta1', format: 'EPUB' },
      }),
    ),
    getView: vi.fn(() => null),
    getProgress: vi.fn(() => ({ location: 'epubcfi(/6/4!/4/2)' })),
    setHoveredBookKey: vi.fn(),
    getViewState: vi.fn(() => ({ previewMode: false })),
  };
});

vi.mock('@/hooks/useSync', () => ({
  useSync: () => ({
    syncedConfigs: h.syncedConfigs,
    syncConfigs: h.syncConfigs,
    syncBooks: h.syncBooks,
  }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/utils/serializer', () => ({ serializeConfig: (c: unknown) => JSON.stringify(c) }));
vi.mock('@/libs/document', () => ({
  CFI: { compare: (a: string, b: string) => h.cfiCompare(a, b) },
}));
vi.mock('@/utils/xcfi', () => ({
  getCFIFromXPointer: h.getCFIFromXPointer,
  getXPointerFromCFI: vi.fn(async () => ({ xpointer: '' })),
  // Faithful stand-in for the real helper: refine the position via its XPointer
  // when present, but swallow conversion failures and fall back to the location
  // CFI. The real implementation is unit-tested in utils/xcfi.spec.ts.
  resolveRemoteProgressCFI: async (
    location: string | undefined,
    xpointer: string | undefined,
    doc: unknown,
    index: number | undefined,
    bookDoc: unknown,
  ) => {
    let remote = location;
    if (xpointer && bookDoc) {
      try {
        const candidate = await h.getCFIFromXPointer(xpointer, doc, index, bookDoc);
        if (!remote || h.cfiCompare(remote, candidate as string) < 0) remote = candidate as string;
      } catch {
        // fall back to the location CFI
      }
    }
    return remote;
  },
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: h.getConfig,
    setConfig: h.setConfig,
    getBookData: h.getBookData,
  }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: { globalViewSettings: {} } }),
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: Object.assign(() => ({}), {
    getState: () => ({
      library: [{ hash: 'hash1', progress: [95, 100] as [number, number], updatedAt: 2000 }],
    }),
  }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: Object.assign(
    () => ({
      getView: h.getView,
      getProgress: h.getProgress,
      setHoveredBookKey: h.setHoveredBookKey,
    }),
    { getState: () => ({ getViewState: h.getViewState }) },
  ),
}));

import { useProgressSync } from '@/app/reader/hooks/useProgressSync';

describe('useProgressSync — closing a book', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.syncedConfigs = null;
    h.cfiCompare = () => 0;
  });

  it('pushes the final reading position to the cloud when the book is closed', async () => {
    renderHook(() => useProgressSync('hash1-0'));
    // Ignore the mount-time pull; we only care about the close behaviour.
    h.syncConfigs.mockClear();

    await act(async () => {
      await eventDispatcher.dispatch('sync-book-progress', { bookKey: 'hash1-0' });
    });

    const pushes = h.syncConfigs.mock.calls.filter((call) => call[3] === 'push');
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    // One config pushed, carrying the current book hash.
    expect(pushes[0]![0]).toHaveLength(1);
    expect(pushes[0]![1]).toBe('hash1');
  });

  it('pushes the live book row to the books table alongside the config push', async () => {
    // Regression: while device B reads, device A's library grid renders the
    // progress badge from the `books` table — which the reader never pushed.
    // The reader pushed only `book_configs`, so A stayed stale until B closed
    // the book (library page's useBooksSync). The reader must now also push the
    // current book row so mid-reading progress reaches another device's library.
    renderHook(() => useProgressSync('hash1-0'));
    h.syncConfigs.mockClear();
    h.syncBooks.mockClear();

    await act(async () => {
      await eventDispatcher.dispatch('sync-book-progress', { bookKey: 'hash1-0' });
    });

    const bookPushes = h.syncBooks.mock.calls.filter((call) => call[1] === 'push');
    expect(bookPushes.length).toBeGreaterThanOrEqual(1);
    const pushedBooks = bookPushes[0]![0] as Array<{ hash: string }>;
    expect(pushedBooks.some((b) => b.hash === 'hash1')).toBe(true);
  });

  it('still pulls to reconcile remote progress after pushing on close', async () => {
    renderHook(() => useProgressSync('hash1-0'));
    h.syncConfigs.mockClear();

    await act(async () => {
      await eventDispatcher.dispatch('sync-book-progress', { bookKey: 'hash1-0' });
    });

    const ops = h.syncConfigs.mock.calls.map((call) => call[3]);
    expect(ops).toContain('push');
    expect(ops).toContain('pull');
    // Push must precede pull so the local position is uploaded before
    // reconciling against the server.
    expect(ops.indexOf('push')).toBeLessThan(ops.indexOf('pull'));
  });
});

describe('useProgressSync — applying remote progress', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.syncedConfigs = null;
    h.cfiCompare = () => 0;
    h.getBookData.mockReturnValue({ book: { metaHash: 'meta1', format: 'EPUB' } });
    h.getCFIFromXPointer.mockResolvedValue('');
  });

  it('adopts a newer-but-earlier remote position (timestamp last-write-wins)', async () => {
    // Local is further ahead in the book (CFI .../4/4) than the remote
    // (.../4/2), but the remote row was written more recently (updatedAt 2000 >
    // 1000). Under last-write-wins the newer remote position must win even
    // though it is EARLIER in the book — a deliberate backward seek must sync
    // (Bug 4). The old CFI "never regress" veto kept local /4/4 and then
    // re-pushed it, defeating the user's intent.
    h.config.location = 'epubcfi(/6/4!/4/4)';
    h.config.progress = [50, 100];
    h.config.updatedAt = 1000;

    const remote = {
      bookHash: 'hash1',
      metaHash: 'meta1',
      location: 'epubcfi(/6/4!/4/2)',
      progress: [5, 100] as [number, number],
      updatedAt: 2000,
      lastModified: 2000,
    };
    h.syncedConfigs = [remote];

    // CFI.compare(a, b): negative when a is before b. Local (/4/4) is AFTER
    // remote (/4/2), so local-vs-remote is positive (remote is behind local).
    h.cfiCompare = (a: string) => (a === 'epubcfi(/6/4!/4/4)' ? 1 : -1);

    await act(async () => {
      renderHook(() => useProgressSync('hash1-0'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.setConfig).toHaveBeenCalled();
    const written = h.setConfig.mock.calls.at(-1)![1] as {
      location: string;
      progress: [number, number];
    };
    // The newer remote position wins, even though it is earlier in the book.
    expect(written.location).toBe('epubcfi(/6/4!/4/2)');
    expect(written.progress).toEqual([5, 100]);
  });

  it('adopts the remote location/progress when the remote is ahead', async () => {
    // Remote is further ahead (/4/8) than local (/4/4); it should win the
    // position regardless of updatedAt ordering.
    h.config.location = 'epubcfi(/6/4!/4/4)';
    h.config.progress = [50, 100];
    h.config.updatedAt = 1000;

    const remote = {
      bookHash: 'hash1',
      metaHash: 'meta1',
      location: 'epubcfi(/6/4!/4/8)',
      progress: [80, 100] as [number, number],
      updatedAt: 2000,
    };
    h.syncedConfigs = [remote];

    // Local (/4/4) is BEFORE remote (/4/8): local-vs-remote negative.
    h.cfiCompare = (a: string) => (a === 'epubcfi(/6/4!/4/4)' ? -1 : 1);

    await act(async () => {
      renderHook(() => useProgressSync('hash1-0'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.setConfig).toHaveBeenCalled();
    const written = h.setConfig.mock.calls.at(-1)![1] as {
      location: string;
      progress: [number, number];
    };
    expect(written.location).toBe('epubcfi(/6/4!/4/8)');
    expect(written.progress).toEqual([80, 100]);
  });

  it('still applies the remote location when the remote XPointer fails to convert', async () => {
    // Regression: the remote is ahead and carries an XPointer that throws while
    // converting on this device (its DOM structure differs). The failure must
    // NOT abort the apply and discard the valid location CFI — otherwise the
    // synced position is lost and later clobbered by a re-push.
    h.config.location = 'epubcfi(/6/4!/4/4)';
    h.config.progress = [50, 100];
    h.config.updatedAt = 1000;
    h.getBookData.mockReturnValue({
      book: { metaHash: 'meta1', format: 'EPUB' },
      bookDoc: { sections: [] },
    });
    h.getCFIFromXPointer.mockRejectedValue(new Error('Element index 0 out of bounds for tag div'));

    const remote = {
      bookHash: 'hash1',
      metaHash: 'meta1',
      location: 'epubcfi(/6/4!/4/8)',
      xpointer: '/body/DocFragment[4]/body/div[1]',
      progress: [80, 100] as [number, number],
      updatedAt: 2000,
    };
    h.syncedConfigs = [remote];
    // Local (/4/4) is BEFORE remote (/4/8): the remote location is ahead.
    h.cfiCompare = (a: string) => (a === 'epubcfi(/6/4!/4/4)' ? -1 : 1);

    await act(async () => {
      renderHook(() => useProgressSync('hash1-0'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.setConfig).toHaveBeenCalled();
    const written = h.setConfig.mock.calls.at(-1)![1] as {
      location: string;
      progress: [number, number];
    };
    expect(written.location).toBe('epubcfi(/6/4!/4/8)');
    expect(written.progress).toEqual([80, 100]);
  });
});
