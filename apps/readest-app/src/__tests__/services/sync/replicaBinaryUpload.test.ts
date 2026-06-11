import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Effect, Layer } from 'effect';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';

vi.mock('@/services/transferManager', () => ({
  transferManager: {
    isReady: vi.fn(),
    queueReplicaUpload: vi.fn(),
  },
}));

// Bridge mock: instead of injecting a fake AppService, queueReplicaBinaryUpload
// now resolves byte sizes through the FileSystem port via the client runtime.
// We back `runPromise` with a real Effect run over a stub FileSystem layer whose
// `openFile` returns the per-path size (and an optional close spy) from `h`.
const h = vi.hoisted(() => ({
  sizes: {} as Record<string, number>,
  close: undefined as undefined | (() => void),
}));

const makeOpenFile: FileSystemShape['openFile'] = (path) =>
  Effect.sync(() => {
    const size = h.sizes[path] ?? 0;
    const file = { size, name: path } as Record<string, unknown>;
    if (h.close) file.close = h.close;
    return file as unknown as File;
  });

vi.mock('@/runtime/clientRuntime', () => ({
  getClientRuntime: () => ({
    runPromise: <A, E>(effect: Effect.Effect<A, E, FileSystem>) => {
      const StubFs = Layer.succeed(FileSystem, {
        openFile: makeOpenFile,
      } as unknown as FileSystemShape);
      return Effect.runPromise(Effect.provide(effect, StubFs));
    },
  }),
}));

import { transferManager } from '@/services/transferManager';
import { queueDictionaryBinaryUpload } from '@/services/sync/replicaBinaryUpload';
import { clearReplicaAdapters, registerReplicaAdapter } from '@/services/sync/replicaRegistry';
import { dictionaryAdapter } from '@/services/sync/adapters/dictionary';
import type { ImportedDictionary } from '@/domain/dictionaries';

const mockIsReady = transferManager.isReady as ReturnType<typeof vi.fn>;
const mockQueueReplicaUpload = transferManager.queueReplicaUpload as ReturnType<typeof vi.fn>;

const setFileSizes = (sizes: Record<string, number>) => {
  h.sizes = sizes;
};

const baseDict = (overrides: Partial<ImportedDictionary> = {}): ImportedDictionary => ({
  id: 'bundle-id',
  contentId: 'content-hash-abc',
  kind: 'mdict',
  name: 'Webster',
  bundleDir: 'bundle-dir',
  files: { mdx: 'webster.mdx', mdd: ['webster.mdd'] },
  addedAt: 0,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.sizes = {};
  h.close = undefined;
  clearReplicaAdapters();
  registerReplicaAdapter(dictionaryAdapter);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearReplicaAdapters();
});

describe('queueDictionaryBinaryUpload', () => {
  test('no-ops when contentId is missing (legacy bundle)', async () => {
    mockIsReady.mockReturnValue(true);
    setFileSizes({});
    const result = await queueDictionaryBinaryUpload(baseDict({ contentId: undefined }));
    expect(result).toBe(null);
    expect(mockQueueReplicaUpload).not.toHaveBeenCalled();
  });

  test('no-ops when TransferManager is not initialized', async () => {
    mockIsReady.mockReturnValue(false);
    setFileSizes({});
    const result = await queueDictionaryBinaryUpload(baseDict());
    expect(result).toBe(null);
    expect(mockQueueReplicaUpload).not.toHaveBeenCalled();
  });

  test('queues upload with file sizes resolved via fs', async () => {
    mockIsReady.mockReturnValue(true);
    mockQueueReplicaUpload.mockReturnValue('transfer-id-1');
    setFileSizes({
      'bundle-dir/webster.mdx': 1_000_000,
      'bundle-dir/webster.mdd': 5_000_000,
    });

    const result = await queueDictionaryBinaryUpload(baseDict());

    expect(result).toBe('transfer-id-1');
    expect(mockQueueReplicaUpload).toHaveBeenCalledOnce();
    const [kind, contentId, displayTitle, files, base, opts] =
      mockQueueReplicaUpload.mock.calls[0]!;
    expect(kind).toBe('dictionary');
    expect(contentId).toBe('content-hash-abc');
    expect(displayTitle).toBe('Webster');
    expect(files).toEqual([
      { logical: 'webster.mdx', lfp: 'bundle-dir/webster.mdx', byteSize: 1_000_000 },
      { logical: 'webster.mdd', lfp: 'bundle-dir/webster.mdd', byteSize: 5_000_000 },
    ]);
    expect(base).toBe('Dictionaries');
    expect(opts).toEqual({ reincarnation: undefined });
  });

  test('passes reincarnation token through to the replica transfer', async () => {
    mockIsReady.mockReturnValue(true);
    mockQueueReplicaUpload.mockReturnValue('transfer-id-1');
    setFileSizes({
      'bundle-dir/webster.mdx': 1_000_000,
      'bundle-dir/webster.mdd': 5_000_000,
    });

    await queueDictionaryBinaryUpload(baseDict({ reincarnation: 'epoch-1' }));

    expect(mockQueueReplicaUpload.mock.calls[0]![5]).toEqual({ reincarnation: 'epoch-1' });
  });

  test('returns null when bundle has no enumerable files', async () => {
    mockIsReady.mockReturnValue(true);
    setFileSizes({});
    const result = await queueDictionaryBinaryUpload(baseDict({ kind: 'mdict', files: {} }));
    expect(result).toBe(null);
    expect(mockQueueReplicaUpload).not.toHaveBeenCalled();
  });

  test('handles stardict bundle with all four files', async () => {
    mockIsReady.mockReturnValue(true);
    mockQueueReplicaUpload.mockReturnValue('t-2');
    const dict = baseDict({
      kind: 'stardict',
      files: {
        ifo: 'cmu.ifo',
        idx: 'cmu.idx',
        dict: 'cmu.dict.dz',
        syn: 'cmu.syn',
        idxOffsets: 'cmu.idx.offsets',
      },
    });
    setFileSizes({
      'bundle-dir/cmu.ifo': 100,
      'bundle-dir/cmu.idx': 200,
      'bundle-dir/cmu.dict.dz': 300,
      'bundle-dir/cmu.syn': 400,
    });

    await queueDictionaryBinaryUpload(dict);

    const files = mockQueueReplicaUpload.mock.calls[0]![3];
    expect(files.map((f: { logical: string }) => f.logical)).toEqual([
      'cmu.ifo',
      'cmu.idx',
      'cmu.dict.dz',
      'cmu.syn',
    ]);
  });

  test('closes opened files (matches getBookFileSize pattern)', async () => {
    mockIsReady.mockReturnValue(true);
    mockQueueReplicaUpload.mockReturnValue('t-3');
    const close = vi.fn();
    h.close = close;
    setFileSizes({});
    await queueDictionaryBinaryUpload(baseDict());
    expect(close).toHaveBeenCalled();
  });
});
