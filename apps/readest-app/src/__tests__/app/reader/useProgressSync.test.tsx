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
    syncConfigs: vi.fn(
      async (
        _configs?: unknown[],
        _bookId?: string,
        _metaHash?: string,
        _op?: 'push' | 'pull' | 'both',
      ) => {},
    ),
    getConfig: vi.fn(() => config),
    setConfig: vi.fn(),
    getBookData: vi.fn(() => ({ book: { metaHash: 'meta1', format: 'EPUB' } })),
    getView: vi.fn(() => null),
    getProgress: vi.fn(() => ({ location: 'epubcfi(/6/4!/4/2)' })),
    setHoveredBookKey: vi.fn(),
    getViewState: vi.fn(() => ({ previewMode: false })),
  };
});

vi.mock('@/hooks/useSync', () => ({
  useSync: () => ({ syncedConfigs: null, syncConfigs: h.syncConfigs }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/utils/serializer', () => ({ serializeConfig: (c: unknown) => JSON.stringify(c) }));
vi.mock('@/libs/document', () => ({ CFI: { compare: () => 0 } }));
vi.mock('@/utils/xcfi', () => ({
  getCFIFromXPointer: vi.fn(async () => ''),
  getXPointerFromCFI: vi.fn(async () => ({ xpointer: '' })),
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
