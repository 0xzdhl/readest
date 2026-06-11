import { describe, test, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { useTransferStore } from '@/store/transferStore';
import type { TransferItem } from '@/store/transferStore';

// ── Mocks ────────────────────────────────────────────────────────────
// The transferManager module is a singleton, so we need to mock its
// dependencies before importing it.

vi.mock('@/utils/event', () => ({
  eventDispatcher: {
    dispatch: vi.fn(),
  },
}));

// E4 bridge: transferManager no longer takes an appService. Its 6 cloud ops
// now resolve the CloudService port via getClientRuntime().runPromise(...).
// We expose spies (hoisted) and back the runtime with a Layer.succeed(CloudService)
// fake so the orchestration runs and the original "called X" assertions hold.
const cloud = vi.hoisted(() => ({
  uploadBook: vi.fn(),
  downloadBook: vi.fn(),
  deleteBook: vi.fn(),
  uploadReplicaFile: vi.fn(),
  downloadReplicaFile: vi.fn(),
  deleteReplicaBundle: vi.fn(),
}));

vi.mock('@/runtime/clientRuntime', async () => {
  const { Effect, Layer } = await import('effect');
  const { CloudService } = await import('@/application/services/CloudService');
  const FakeCloud = Layer.succeed(CloudService, {
    uploadBook: (...args: unknown[]) => Effect.promise(() => cloud.uploadBook(...args)),
    downloadBook: (...args: unknown[]) => Effect.promise(() => cloud.downloadBook(...args)),
    deleteBook: (...args: unknown[]) => Effect.promise(() => cloud.deleteBook(...args)),
    uploadReplicaFile: (...args: unknown[]) =>
      Effect.promise(() => cloud.uploadReplicaFile(...args)),
    downloadReplicaFile: (...args: unknown[]) =>
      Effect.promise(() => cloud.downloadReplicaFile(...args)),
    deleteReplicaBundle: (...args: unknown[]) =>
      Effect.promise(() => cloud.deleteReplicaBundle(...args)),
  } as never);
  return {
    getClientRuntime: () => ({
      runPromise: (effect: never) =>
        Effect.runPromise(
          Effect.provide(effect, FakeCloud) as unknown as Parameters<typeof Effect.runPromise>[0],
        ),
    }),
    setClientRuntime: vi.fn(),
  };
});

// After the module-level mock declarations, import the SUT
import { transferManager } from '@/services/transferManager';
import { eventDispatcher } from '@/utils/event';
import type { Book } from '@/domain/book';

// ── Helpers ──────────────────────────────────────────────────────────
function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'hash1',
    format: 'EPUB',
    title: 'Test Book',
    author: 'Author',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeTransferItem(overrides: Partial<TransferItem> = {}): TransferItem {
  return {
    id: 't1',
    kind: 'book',
    bookHash: 'hash1',
    bookTitle: 'Test Book',
    type: 'upload',
    status: 'pending',
    progress: 0,
    totalBytes: 0,
    transferredBytes: 0,
    transferSpeed: 0,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    priority: 10,
    isBackground: false,
    ...overrides,
  };
}

// Reset the singleton and store before each test.
// Because TransferManager is a singleton with private isInitialized flag,
// we access the internal state via the exported instance.
const resetTransferManager = () => {
  // Reset internal state via prototype hacking
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only introspection
  const mgr = transferManager as unknown as Record<string, unknown>;
  mgr['isInitialized'] = false;
  mgr['isProcessing'] = false;
  mgr['getLibrary'] = null;
  mgr['updateBook'] = null;
  mgr['_'] = null;
  (mgr['abortControllers'] as Map<string, AbortController>).clear();
  // Re-arm the readyPromise so each test starts with a pending one.
  let resolveReady: () => void = () => {};
  mgr['readyPromise'] = new Promise<void>((res) => {
    resolveReady = res;
  });
  mgr['readyResolve'] = resolveReady;
};

const resetTransferStore = () => {
  useTransferStore.setState({
    transfers: {},
    isQueuePaused: false,
    isTransferQueueOpen: false,
    maxConcurrent: 2,
    activeCount: 0,
  });
};

const translationFn = (key: string, params?: Record<string, string | number>) => {
  if (params) {
    return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)), key);
  }
  return key;
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetTransferStore();
  resetTransferManager();
  vi.clearAllMocks();
  cloud.uploadBook.mockResolvedValue(undefined);
  cloud.downloadBook.mockResolvedValue(undefined);
  cloud.deleteBook.mockResolvedValue(undefined);
  cloud.uploadReplicaFile.mockResolvedValue(undefined);
  cloud.downloadReplicaFile.mockResolvedValue(undefined);
  cloud.deleteReplicaBundle.mockResolvedValue(undefined);
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────
describe('TransferManager', () => {
  // ── Singleton ────────────────────────────────────────────────────
  describe('getInstance / singleton', () => {
    test('always returns the same instance', async () => {
      // The module export is the singleton; importing again should yield the same ref.
      const { transferManager: tm2 } = await import('@/services/transferManager');
      expect(tm2).toBe(transferManager);
    });
  });

  // ── isReady ──────────────────────────────────────────────────────
  describe('isReady', () => {
    test('returns false before initialization', () => {
      expect(transferManager.isReady()).toBe(false);
    });

    test('returns true after initialization', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);
      expect(transferManager.isReady()).toBe(true);
    });
  });

  // ── waitUntilReady ───────────────────────────────────────────────
  describe('waitUntilReady', () => {
    test('does not resolve before initialize', async () => {
      let resolved = false;
      void transferManager.waitUntilReady().then(() => {
        resolved = true;
      });
      // Yield to the microtask queue so any spurious early resolution would land.
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);
    });

    test('resolves once initialize completes', async () => {
      let resolved = false;
      void transferManager.waitUntilReady().then(() => {
        resolved = true;
      });
      await transferManager.initialize(() => [], vi.fn(), translationFn);
      await Promise.resolve();
      expect(resolved).toBe(true);
    });

    test('returns an already-resolved promise after initialize', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);
      // After init this should resolve in the next microtask, not block.
      let resolved = false;
      void transferManager.waitUntilReady().then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(true);
    });
  });

  // ── initialize ───────────────────────────────────────────────────
  describe('initialize', () => {
    test('loads persisted queue from localStorage', async () => {
      const item = makeTransferItem({ id: 'persisted-1', status: 'pending' });
      const data = {
        transfers: { 'persisted-1': item },
        isQueuePaused: true,
      };
      localStorage.setItem('readest_transfer_queue', JSON.stringify(data));

      await transferManager.initialize(() => [], vi.fn(), translationFn);

      const store = useTransferStore.getState();
      expect(store.transfers['persisted-1']).toBeDefined();
      expect(store.isQueuePaused).toBe(true);
    });

    test('is idempotent — second call is a no-op', async () => {
      const getLibrary = () => [] as Book[];
      await transferManager.initialize(getLibrary, vi.fn(), translationFn);

      // A second initialize with different deps must be ignored — the first
      // getLibrary ref should still be in use.
      const getLibrary2 = () => [] as Book[];
      await transferManager.initialize(getLibrary2, vi.fn(), translationFn);

      const mgr = transferManager as unknown as Record<string, unknown>;
      expect(mgr['getLibrary']).toBe(getLibrary);
    });
  });

  // ── queueUpload ──────────────────────────────────────────────────
  describe('queueUpload', () => {
    test('returns null when not initialized', () => {
      const result = transferManager.queueUpload(makeBook());
      expect(result).toBeNull();
    });

    test('queues an upload and returns a transfer id', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id = transferManager.queueUpload(makeBook());
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');

      const transfer = useTransferStore.getState().transfers[id!];
      expect(transfer).toBeDefined();
      expect(transfer!.type).toBe('upload');
      expect(transfer!.bookHash).toBe('hash1');
    });

    test('returns existing id if already queued', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id1 = transferManager.queueUpload(makeBook());
      const id2 = transferManager.queueUpload(makeBook());
      expect(id1).toBe(id2);
    });

    test('respects custom priority', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id = transferManager.queueUpload(makeBook(), 1);
      const transfer = useTransferStore.getState().transfers[id!];
      expect(transfer!.priority).toBe(1);
    });
  });

  // ── queueDownload ────────────────────────────────────────────────
  describe('queueDownload', () => {
    test('returns null when not initialized', () => {
      const result = transferManager.queueDownload(makeBook());
      expect(result).toBeNull();
    });

    test('queues a download and returns a transfer id', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id = transferManager.queueDownload(makeBook());
      expect(id).toBeTruthy();
      const transfer = useTransferStore.getState().transfers[id!];
      expect(transfer!.type).toBe('download');
    });

    test('returns existing id if already queued', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id1 = transferManager.queueDownload(makeBook());
      const id2 = transferManager.queueDownload(makeBook());
      expect(id1).toBe(id2);
    });
  });

  // ── queueDelete ──────────────────────────────────────────────────
  describe('queueDelete', () => {
    test('returns null when not initialized', () => {
      const result = transferManager.queueDelete(makeBook());
      expect(result).toBeNull();
    });

    test('queues a delete and returns a transfer id', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id = transferManager.queueDelete(makeBook());
      expect(id).toBeTruthy();
      const transfer = useTransferStore.getState().transfers[id!];
      expect(transfer!.type).toBe('delete');
    });

    test('supports isBackground flag', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id = transferManager.queueDelete(makeBook(), 10, true);
      const transfer = useTransferStore.getState().transfers[id!];
      expect(transfer!.isBackground).toBe(true);
    });
  });

  // ── queueBatchUploads ────────────────────────────────────────────
  describe('queueBatchUploads', () => {
    test('returns empty array when not initialized', () => {
      const result = transferManager.queueBatchUploads([makeBook()]);
      expect(result).toEqual([]);
    });

    test('queues multiple uploads', async () => {
      const book1 = makeBook({ hash: 'h1', title: 'B1' });
      const book2 = makeBook({ hash: 'h2', title: 'B2' });
      await transferManager.initialize(() => [book1, book2], vi.fn(), translationFn);

      const ids = transferManager.queueBatchUploads([book1, book2]);
      expect(ids).toHaveLength(2);
      ids.forEach((id) => {
        expect(useTransferStore.getState().transfers[id]).toBeDefined();
      });
    });
  });

  // ── cancelTransfer ───────────────────────────────────────────────
  describe('cancelTransfer', () => {
    test('sets status to cancelled', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id = transferManager.queueUpload(makeBook())!;
      transferManager.cancelTransfer(id);

      const transfer = useTransferStore.getState().transfers[id];
      expect(transfer!.status).toBe('cancelled');
    });

    test('aborts an active abort controller', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id = transferManager.queueUpload(makeBook())!;

      // Manually inject an abort controller to simulate active transfer
      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');
      const mgr = transferManager as unknown as Record<string, unknown>;
      (mgr['abortControllers'] as Map<string, AbortController>).set(id, abortController);

      transferManager.cancelTransfer(id);

      expect(abortSpy).toHaveBeenCalled();
    });

    test('persists queue after cancel', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id = transferManager.queueUpload(makeBook())!;
      transferManager.cancelTransfer(id);

      const stored = localStorage.getItem('readest_transfer_queue');
      expect(stored).toBeTruthy();
      const data = JSON.parse(stored!);
      expect(data.transfers[id].status).toBe('cancelled');
    });
  });

  // ── retryTransfer ────────────────────────────────────────────────
  describe('retryTransfer', () => {
    test('resets a failed transfer to pending', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      const id = transferManager.queueUpload(makeBook())!;
      useTransferStore.getState().setTransferStatus(id, 'failed', 'Network error');

      transferManager.retryTransfer(id);

      const transfer = useTransferStore.getState().transfers[id];
      expect(transfer!.status).toBe('pending');
      expect(transfer!.error).toBeUndefined();
    });
  });

  // ── retryAllFailed ───────────────────────────────────────────────
  describe('retryAllFailed', () => {
    test('retries all failed transfers', async () => {
      const book1 = makeBook({ hash: 'h1', title: 'B1' });
      const book2 = makeBook({ hash: 'h2', title: 'B2' });
      await transferManager.initialize(() => [book1, book2], vi.fn(), translationFn);

      const id1 = transferManager.queueUpload(book1)!;
      const id2 = transferManager.queueDownload(book2)!;
      useTransferStore.getState().setTransferStatus(id1, 'failed', 'err1');
      useTransferStore.getState().setTransferStatus(id2, 'failed', 'err2');

      transferManager.retryAllFailed();

      expect(useTransferStore.getState().transfers[id1]!.status).toBe('pending');
      expect(useTransferStore.getState().transfers[id2]!.status).toBe('pending');
    });
  });

  // ── pauseQueue / resumeQueue ─────────────────────────────────────
  describe('pauseQueue / resumeQueue', () => {
    test('pauseQueue pauses the store queue', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);

      transferManager.pauseQueue();
      expect(useTransferStore.getState().isQueuePaused).toBe(true);
    });

    test('resumeQueue resumes the store queue', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);

      transferManager.pauseQueue();
      transferManager.resumeQueue();
      expect(useTransferStore.getState().isQueuePaused).toBe(false);
    });

    test('pauseQueue persists state', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);

      transferManager.pauseQueue();
      const stored = JSON.parse(localStorage.getItem('readest_transfer_queue')!);
      expect(stored.isQueuePaused).toBe(true);
    });
  });

  // ── Queue processing (integration-style) ─────────────────────────
  describe('queue processing', () => {
    test('successful upload calls CloudService.uploadBook and updates book', async () => {
      const book = makeBook({ hash: 'h1', title: 'Test Upload' });
      const updateBook = vi.fn().mockResolvedValue(undefined);

      await transferManager.initialize(() => [book], updateBook, translationFn);

      const id = transferManager.queueUpload(book)!;

      // Let the async queue processing run
      await vi.advanceTimersByTimeAsync(500);

      expect(cloud.uploadBook).toHaveBeenCalled();
      expect(updateBook).toHaveBeenCalled();

      const transfer = useTransferStore.getState().transfers[id];
      expect(transfer!.status).toBe('completed');
    });

    test('successful download calls CloudService.downloadBook and updates book', async () => {
      const book = makeBook({ hash: 'h1', title: 'Test Download' });
      const updateBook = vi.fn().mockResolvedValue(undefined);

      await transferManager.initialize(() => [book], updateBook, translationFn);

      const id = transferManager.queueDownload(book)!;

      await vi.advanceTimersByTimeAsync(500);

      expect(cloud.downloadBook).toHaveBeenCalled();
      expect(updateBook).toHaveBeenCalled();

      const transfer = useTransferStore.getState().transfers[id];
      expect(transfer!.status).toBe('completed');
    });

    test('successful delete calls CloudService.deleteBook', async () => {
      const book = makeBook({ hash: 'h1', title: 'Test Delete' });
      const updateBook = vi.fn().mockResolvedValue(undefined);

      await transferManager.initialize(() => [book], updateBook, translationFn);

      const id = transferManager.queueDelete(book)!;

      await vi.advanceTimersByTimeAsync(500);

      expect(cloud.deleteBook).toHaveBeenCalled();

      const transfer = useTransferStore.getState().transfers[id];
      expect(transfer!.status).toBe('completed');
    });

    test('dispatches toast on success for non-background transfers', async () => {
      const book = makeBook({ hash: 'h1', title: 'Toast Book' });

      await transferManager.initialize(
        () => [book],
        vi.fn().mockResolvedValue(undefined),
        translationFn,
      );

      transferManager.queueUpload(book);
      await vi.advanceTimersByTimeAsync(500);

      expect(eventDispatcher.dispatch).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({ type: 'info' }),
      );
    });

    test('does not dispatch toast for background transfers', async () => {
      const book = makeBook({ hash: 'h1', title: 'BG Book' });

      await transferManager.initialize(
        () => [book],
        vi.fn().mockResolvedValue(undefined),
        translationFn,
      );

      transferManager.queueDelete(book, 10, true);
      await vi.advanceTimersByTimeAsync(500);

      // The toast dispatch should not include an 'info' toast
      const calls = (eventDispatcher.dispatch as Mock).mock.calls;
      const infoToasts = calls.filter(
        (c) => c[0] === 'toast' && (c[1] as Record<string, unknown>)?.['type'] === 'info',
      );
      expect(infoToasts).toHaveLength(0);
    });

    test('failed transfer with retries schedules retry', async () => {
      const book = makeBook({ hash: 'h1', title: 'Retry Book' });
      cloud.uploadBook.mockRejectedValue(new Error('Network fail'));

      await transferManager.initialize(
        () => [book],
        vi.fn().mockResolvedValue(undefined),
        translationFn,
      );

      const id = transferManager.queueUpload(book)!;
      await vi.advanceTimersByTimeAsync(500);

      // After first failure, retryCount should be incremented and status back to pending
      const transfer = useTransferStore.getState().transfers[id];
      expect(transfer!.retryCount).toBeGreaterThanOrEqual(1);
    });

    test('paused queue does not process transfers', async () => {
      const book = makeBook({ hash: 'h1', title: 'Paused Book' });

      await transferManager.initialize(
        () => [book],
        vi.fn().mockResolvedValue(undefined),
        translationFn,
      );

      transferManager.pauseQueue();
      transferManager.queueUpload(book);

      await vi.advanceTimersByTimeAsync(500);

      // The upload should not have been called because queue is paused
      expect(cloud.uploadBook).not.toHaveBeenCalled();
    });

    test('book not found in library dispatches error', async () => {
      const book = makeBook({ hash: 'not-in-lib', title: 'Missing' });

      await transferManager.initialize(
        () => [], // empty library
        vi.fn().mockResolvedValue(undefined),
        translationFn,
      );

      transferManager.queueUpload(book);
      await vi.advanceTimersByTimeAsync(10000);

      // After all retries exhausted, error toast should be dispatched
      expect(eventDispatcher.dispatch).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({ type: 'error' }),
      );
    });
  });

  // ── persistQueue / loadPersistedQueue ────────────────────────────
  describe('persistence', () => {
    test('persistQueue stores transfers to localStorage', async () => {
      await transferManager.initialize(() => [makeBook()], vi.fn(), translationFn);

      transferManager.queueUpload(makeBook());

      const stored = localStorage.getItem('readest_transfer_queue');
      expect(stored).toBeTruthy();
      const data = JSON.parse(stored!);
      expect(Object.keys(data.transfers).length).toBeGreaterThan(0);
    });

    test('handles missing localStorage gracefully', async () => {
      // Simulate localStorage being undefined
      const originalGetItem = localStorage.getItem;
      localStorage.getItem = () => null;

      // Should not throw
      await expect(
        transferManager.initialize(() => [], vi.fn(), translationFn),
      ).resolves.not.toThrow();

      localStorage.getItem = originalGetItem;
    });

    test('handles corrupted localStorage data gracefully', async () => {
      localStorage.setItem('readest_transfer_queue', 'invalid-json{{{');

      // Should not throw
      await expect(
        transferManager.initialize(() => [], vi.fn(), translationFn),
      ).resolves.not.toThrow();
    });
  });

  // ── queueReplicaUpload / queueReplicaDownload / queueReplicaDelete ──
  describe('replica transfer queueing', () => {
    const dictFiles = [
      { logical: 'webster.mdx', lfp: 'd1/webster.mdx', byteSize: 1000 },
      { logical: 'webster.mdd', lfp: 'd1/webster.mdd', byteSize: 4000 },
    ];

    test('queueReplicaUpload returns null when not initialized', () => {
      const id = transferManager.queueReplicaUpload(
        'dictionary',
        'd1',
        'Webster',
        dictFiles,
        'Dictionaries',
      );
      expect(id).toBeNull();
    });

    test('queueReplicaUpload creates a kind="replica" transfer with files + base', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);

      const id = transferManager.queueReplicaUpload(
        'dictionary',
        'd1',
        'Webster',
        dictFiles,
        'Dictionaries',
        { reincarnation: 'epoch-1' },
      );
      expect(id).toBeTruthy();
      const t = useTransferStore.getState().transfers[id!]!;
      expect(t.kind).toBe('replica');
      expect(t.replicaKind).toBe('dictionary');
      expect(t.replicaId).toBe('d1');
      expect(t.replicaFiles).toEqual(dictFiles);
      expect(t.replicaBase).toBe('Dictionaries');
      expect(t.replicaReincarnation).toBe('epoch-1');
      expect(t.totalBytes).toBe(5000);
    });

    test('queueReplicaUpload returns existing id if same (kind, id) is already queued', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);

      const id1 = transferManager.queueReplicaUpload(
        'dictionary',
        'd1',
        'Webster',
        dictFiles,
        'Dictionaries',
      );
      const id2 = transferManager.queueReplicaUpload(
        'dictionary',
        'd1',
        'Webster',
        dictFiles,
        'Dictionaries',
      );
      expect(id1).toBe(id2);
    });

    test('different replicaKinds with same id are distinct queue entries', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);

      const dictId = transferManager.queueReplicaUpload(
        'dictionary',
        'shared-hash',
        'D',
        dictFiles,
        'Dictionaries',
      );
      const fontId = transferManager.queueReplicaUpload(
        'font',
        'shared-hash',
        'F',
        [{ logical: 'roboto.ttf', lfp: 'f/roboto.ttf', byteSize: 200000 }],
        'Fonts',
      );
      expect(dictId).not.toBe(fontId);
    });

    test('queueReplicaDownload creates a download-typed transfer', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);

      const id = transferManager.queueReplicaDownload(
        'dictionary',
        'd1',
        'Webster',
        dictFiles,
        'Dictionaries',
      );
      const t = useTransferStore.getState().transfers[id!]!;
      expect(t.type).toBe('download');
      expect(t.replicaFiles).toEqual(dictFiles);
    });

    test('executing a replica download passes the transfer base to downloadReplicaFile', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);

      transferManager.queueReplicaDownload(
        'dictionary',
        'content-hash-abc',
        'Webster',
        [{ logical: 'webster.mdx', lfp: 'bundle-1/webster.mdx', byteSize: 1000 }],
        'Dictionaries',
      );

      // Drain the queue.
      await vi.runAllTimersAsync();
      await Promise.resolve();
      await Promise.resolve();

      expect(cloud.downloadReplicaFile).toHaveBeenCalledOnce();
      // The replica calls now take a single opts object.
      const opts = cloud.downloadReplicaFile.mock.calls[0]![0] as Record<string, unknown>;
      expect(opts['kind']).toBe('dictionary');
      expect(opts['replicaId']).toBe('content-hash-abc');
      expect(opts['filename']).toBe('webster.mdx');
      expect(opts['lfp']).toBe('bundle-1/webster.mdx');
      expect(opts['base']).toBe('Dictionaries');
    });

    test('queueReplicaDelete creates a delete-typed transfer with filename list', async () => {
      await transferManager.initialize(() => [], vi.fn(), translationFn);

      const id = transferManager.queueReplicaDelete('dictionary', 'd1', 'Webster', [
        'webster.mdx',
        'webster.mdd',
      ]);
      const t = useTransferStore.getState().transfers[id!]!;
      expect(t.type).toBe('delete');
      expect(t.replicaFiles?.map((f) => f.logical)).toEqual(['webster.mdx', 'webster.mdd']);
    });
  });
});
