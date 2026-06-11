import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import type { BaseDir } from '@/domain/system';

// Stub FileSystem ops backed by vi.fn() so tests can assert calls + control returns.
const fsMocks = {
  exists: vi.fn(async (_path: string, _base: BaseDir) => false),
  readFile: vi.fn(
    async (_path: string, _base: BaseDir, _mode: 'text' | 'binary'): Promise<string> => {
      throw new Error('File not found');
    },
  ),
  writeFile: vi.fn(async (_path: string, _base: BaseDir, _content: string) => {}),
  createDir: vi.fn(async (_path: string, _base: BaseDir, _recursive?: boolean) => {}),
  removeFile: vi.fn(async (_path: string, _base: BaseDir) => {}),
};

const fsShape: Partial<FileSystemShape> = {
  exists: (path, base) => Effect.promise(() => fsMocks.exists(path, base)),
  readFile: (path, base, mode) => Effect.promise(() => fsMocks.readFile(path, base, mode)),
  writeFile: (path, base, content) =>
    Effect.promise(() => fsMocks.writeFile(path, base, content as string)),
  createDir: (path, base, recursive) =>
    Effect.promise(() => fsMocks.createDir(path, base, recursive)),
  removeFile: (path, base) => Effect.promise(() => fsMocks.removeFile(path, base)),
};

const testRuntime = ManagedRuntime.make(Layer.succeed(FileSystem, fsShape as FileSystemShape));

vi.mock('@/runtime/clientRuntime', () => ({
  getClientRuntime: () => testRuntime,
}));

import {
  loadSubscriptionState,
  saveSubscriptionState,
  deleteSubscriptionState,
  pruneKnownEntryIds,
  emptyState,
} from '@/services/opds/subscriptionState';
import { MAX_KNOWN_ENTRIES, OPDS_SUBSCRIPTIONS_DIR } from '@/services/opds/types';
import type { OPDSSubscriptionState } from '@/services/opds/types';

describe('OPDS subscription state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.exists.mockResolvedValue(false);
    fsMocks.readFile.mockRejectedValue(new Error('File not found'));
    fsMocks.writeFile.mockResolvedValue(undefined);
    fsMocks.createDir.mockResolvedValue(undefined);
    fsMocks.removeFile.mockResolvedValue(undefined);
  });

  describe('emptyState', () => {
    it('creates an empty state with the given catalogId', () => {
      const state = emptyState('cat-1');
      expect(state).toEqual({
        catalogId: 'cat-1',
        lastCheckedAt: 0,
        knownEntryIds: [],
        failedEntries: [],
      });
    });
  });

  describe('loadSubscriptionState', () => {
    it('returns empty state when file does not exist', async () => {
      fsMocks.exists.mockResolvedValue(false);
      const state = await loadSubscriptionState('cat-1');
      expect(state).toEqual(emptyState('cat-1'));
    });

    it('loads and parses existing state file', async () => {
      const saved: OPDSSubscriptionState = {
        catalogId: 'cat-1',
        lastCheckedAt: 1000,
        knownEntryIds: ['urn:a', 'urn:b'],
        failedEntries: [],
      };
      fsMocks.exists.mockResolvedValue(true);
      fsMocks.readFile.mockResolvedValue(JSON.stringify(saved));
      const state = await loadSubscriptionState('cat-1');
      expect(state.knownEntryIds).toEqual(['urn:a', 'urn:b']);
      expect(state.lastCheckedAt).toBe(1000);
    });

    it('returns empty state on corrupted file', async () => {
      fsMocks.exists.mockResolvedValue(true);
      fsMocks.readFile.mockResolvedValue('not json');
      const state = await loadSubscriptionState('cat-1');
      expect(state).toEqual(emptyState('cat-1'));
    });
  });

  describe('saveSubscriptionState', () => {
    it('creates directory and writes state as JSON', async () => {
      const state: OPDSSubscriptionState = {
        catalogId: 'cat-1',
        lastCheckedAt: 1000,
        knownEntryIds: ['urn:a'],
        failedEntries: [],
      };
      await saveSubscriptionState(state);
      expect(fsMocks.createDir).toHaveBeenCalledWith(OPDS_SUBSCRIPTIONS_DIR, 'Data', true);
      expect(fsMocks.writeFile).toHaveBeenCalledWith(
        `${OPDS_SUBSCRIPTIONS_DIR}/cat-1.json`,
        'Data',
        JSON.stringify(state, null, 2),
      );
    });
  });

  describe('deleteSubscriptionState', () => {
    it('deletes the state file', async () => {
      await deleteSubscriptionState('cat-1');
      expect(fsMocks.removeFile).toHaveBeenCalledWith(
        `${OPDS_SUBSCRIPTIONS_DIR}/cat-1.json`,
        'Data',
      );
    });

    it('does not throw if file does not exist', async () => {
      fsMocks.removeFile.mockRejectedValue(new Error('not found'));
      await expect(deleteSubscriptionState('cat-1')).resolves.toBeUndefined();
    });
  });

  describe('pruneKnownEntryIds', () => {
    it('keeps all entries when under limit', () => {
      const ids = ['a', 'b', 'c'];
      expect(pruneKnownEntryIds(ids)).toEqual(['a', 'b', 'c']);
    });

    it('trims oldest entries when over limit', () => {
      const ids = Array.from({ length: MAX_KNOWN_ENTRIES + 100 }, (_, i) => `id-${i}`);
      const pruned = pruneKnownEntryIds(ids);
      expect(pruned.length).toBe(MAX_KNOWN_ENTRIES);
      expect(pruned[pruned.length - 1]).toBe(`id-${MAX_KNOWN_ENTRIES + 99}`);
      expect(pruned[0]).toBe('id-100');
    });
  });
});
