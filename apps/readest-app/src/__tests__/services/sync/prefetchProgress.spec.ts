import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookConfig } from '@/domain/book';

// Control the mocked SyncClient.pullChanges and the sync-enabled gate per test.
const h = vi.hoisted(() => ({
  pullChanges: vi.fn(),
  syncEnabled: true,
}));

vi.mock('@/libs/sync', () => ({
  SyncClient: class {
    pullChanges = h.pullChanges;
  },
}));
vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => h.syncEnabled,
}));

import {
  mergeRemoteOpenPosition,
  prefetchBookProgress,
  takePrefetchedProgress,
} from '@/services/sync/prefetchProgress';

const makeBook = (hash: string, metaHash = 'meta') =>
  ({ hash, metaHash }) as unknown as Parameters<typeof prefetchBookProgress>[0];

const dbConfigRow = (hash: string, location: string, userId?: string) => ({
  user_id: userId,
  book_hash: hash,
  meta_hash: 'meta',
  location,
  progress: '[5,100]',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
});

afterEach(() => {
  vi.clearAllMocks();
  h.syncEnabled = true;
});

describe('mergeRemoteOpenPosition', () => {
  const base = { bookHash: 'h', metaHash: 'meta', updatedAt: 1000 } as BookConfig;

  it('adopts the remote position when the remote is strictly ahead', () => {
    const local = {
      ...base,
      location: 'epubcfi(/6/4!/4/2)',
      progress: [5, 100] as [number, number],
    };
    const remote = {
      ...base,
      location: 'epubcfi(/6/4!/4/8)',
      progress: [80, 100] as [number, number],
      updatedAt: 2000,
    };
    const merged = mergeRemoteOpenPosition(local, remote);
    expect(merged.location).toBe('epubcfi(/6/4!/4/8)');
    expect(merged.progress).toEqual([80, 100]);
  });

  it('keeps the local position when the remote is behind (even if newer)', () => {
    const local = {
      ...base,
      location: 'epubcfi(/6/4!/4/8)',
      progress: [80, 100] as [number, number],
    };
    const remote = {
      ...base,
      location: 'epubcfi(/6/4!/4/2)',
      progress: [5, 100] as [number, number],
      updatedAt: 9999,
    };
    const merged = mergeRemoteOpenPosition(local, remote);
    expect(merged.location).toBe('epubcfi(/6/4!/4/8)');
    expect(merged.progress).toEqual([80, 100]);
  });

  it('keeps the local position when positions are equal', () => {
    const local = {
      ...base,
      location: 'epubcfi(/6/4!/4/4)',
      progress: [50, 100] as [number, number],
    };
    const remote = {
      ...base,
      location: 'epubcfi(/6/4!/4/4)',
      progress: [50, 100] as [number, number],
    };
    expect(mergeRemoteOpenPosition(local, remote).location).toBe('epubcfi(/6/4!/4/4)');
  });

  it('adopts the remote position when the local config has no location', () => {
    const local = { ...base };
    const remote = {
      ...base,
      location: 'epubcfi(/6/4!/4/2)',
      progress: [5, 100] as [number, number],
    };
    const merged = mergeRemoteOpenPosition(local, remote);
    expect(merged.location).toBe('epubcfi(/6/4!/4/2)');
    expect(merged.progress).toEqual([5, 100]);
  });

  it('keeps the local config when the remote has no location', () => {
    const local = {
      ...base,
      location: 'epubcfi(/6/4!/4/4)',
      progress: [50, 100] as [number, number],
    };
    const remote = { ...base, xpointer: '/body/DocFragment[2]/body/div' };
    expect(mergeRemoteOpenPosition(local, remote).location).toBe('epubcfi(/6/4!/4/4)');
  });

  it('keeps the local config when CFI comparison fails (malformed remote CFI)', () => {
    const local = {
      ...base,
      location: 'epubcfi(/6/4!/4/2)',
      progress: [5, 100] as [number, number],
    };
    const remote = {
      ...base,
      location: 'not-a-valid-cfi',
      progress: [9, 100] as [number, number],
    };
    expect(() => mergeRemoteOpenPosition(local, remote)).not.toThrow();
    expect(mergeRemoteOpenPosition(local, remote).location).toBe('epubcfi(/6/4!/4/2)');
  });

  it('does not mutate the local config', () => {
    const local = { ...base, location: 'epubcfi(/6/4!/4/2)' };
    const remote = { ...base, location: 'epubcfi(/6/4!/4/8)' };
    mergeRemoteOpenPosition(local, remote);
    expect(local.location).toBe('epubcfi(/6/4!/4/2)');
  });
});

describe('prefetch cache', () => {
  it('stashes a pulled config that takePrefetchedProgress returns', async () => {
    h.pullChanges.mockResolvedValue({
      books: null,
      notes: null,
      configs: [dbConfigRow('h-ok', 'epubcfi(/6/4!/4/8)')],
    });
    prefetchBookProgress(makeBook('h-ok'));
    const cfg = await takePrefetchedProgress('h-ok');
    expect(cfg?.bookHash).toBe('h-ok');
    expect(cfg?.location).toBe('epubcfi(/6/4!/4/8)');
  });

  it('is one-shot: a second take returns null', async () => {
    h.pullChanges.mockResolvedValue({
      books: null,
      notes: null,
      configs: [dbConfigRow('h-once', 'epubcfi(/6/4!/4/8)')],
    });
    prefetchBookProgress(makeBook('h-once'));
    await takePrefetchedProgress('h-once');
    expect(await takePrefetchedProgress('h-once')).toBeNull();
  });

  it('returns null when there is no prefetch for the hash', async () => {
    expect(await takePrefetchedProgress('h-missing')).toBeNull();
  });

  it('resolves to null when the pull throws (offline / not authenticated)', async () => {
    h.pullChanges.mockRejectedValue(new Error('Not authenticated'));
    prefetchBookProgress(makeBook('h-throw'));
    expect(await takePrefetchedProgress('h-throw')).toBeNull();
  });

  it('is a no-op when progress sync is disabled', async () => {
    h.syncEnabled = false;
    prefetchBookProgress(makeBook('h-disabled'));
    expect(h.pullChanges).not.toHaveBeenCalled();
    expect(await takePrefetchedProgress('h-disabled')).toBeNull();
  });

  it('returns null when the pull does not resolve before the timeout', async () => {
    h.pullChanges.mockReturnValue(new Promise(() => {}));
    prefetchBookProgress(makeBook('h-slow'));
    expect(await takePrefetchedProgress('h-slow', 50)).toBeNull();
  });

  it('pulls only once for repeated prefetch calls on the same book', async () => {
    h.pullChanges.mockResolvedValue({
      books: null,
      notes: null,
      configs: [dbConfigRow('h-dedupe', 'epubcfi(/6/4!/4/8)')],
    });
    prefetchBookProgress(makeBook('h-dedupe'));
    prefetchBookProgress(makeBook('h-dedupe'));
    expect(h.pullChanges).toHaveBeenCalledTimes(1);
    await takePrefetchedProgress('h-dedupe');
  });

  it('drops a config row that belongs to another user (cross-user guard)', async () => {
    // Two rows for the SAME book hash but different owners. Only the caller's
    // (userId='me') row may be adopted; the foreign row (userId='other') must
    // never leak into the open position.
    h.pullChanges.mockResolvedValue({
      books: null,
      notes: null,
      configs: [
        dbConfigRow('h-multi', 'epubcfi(/6/4!/4/OTHER)', 'other'),
        dbConfigRow('h-multi', 'epubcfi(/6/4!/4/MINE)', 'me'),
      ],
    });
    prefetchBookProgress(makeBook('h-multi'), 'me');
    const cfg = await takePrefetchedProgress('h-multi');
    expect(cfg?.location).toBe('epubcfi(/6/4!/4/MINE)');
  });

  it('returns null when the only matching row belongs to another user', async () => {
    h.pullChanges.mockResolvedValue({
      books: null,
      notes: null,
      configs: [dbConfigRow('h-foreign', 'epubcfi(/6/4!/4/OTHER)', 'other')],
    });
    prefetchBookProgress(makeBook('h-foreign'), 'me');
    expect(await takePrefetchedProgress('h-foreign')).toBeNull();
  });

  it('keeps a row with no user_id (legacy/local) even when a userId is given', async () => {
    h.pullChanges.mockResolvedValue({
      books: null,
      notes: null,
      configs: [dbConfigRow('h-legacy', 'epubcfi(/6/4!/4/LEGACY)', undefined)],
    });
    prefetchBookProgress(makeBook('h-legacy'), 'me');
    const cfg = await takePrefetchedProgress('h-legacy');
    expect(cfg?.location).toBe('epubcfi(/6/4!/4/LEGACY)');
  });
});
