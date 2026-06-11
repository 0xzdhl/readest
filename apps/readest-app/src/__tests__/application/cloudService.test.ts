import { Effect, Layer } from 'effect';
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { CloudService } from '@/application/services/CloudService';
import { CloudServiceLive } from '@/infra/shared/CloudService.layer';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { CloudError } from '@/application/errors/AppError';
import type { Book } from '@/domain/book';

// The pure cloudService fns call these network primitives — stub them so the
// layer test exercises only the fs/resolveFilePath wiring + error mapping.
vi.mock('@/libs/storage', () => ({
  uploadFile: vi.fn(async () => 'https://cdn/x'),
  uploadReplicaFile: vi.fn(async () => undefined),
  downloadFile: vi.fn(async () => ({})),
  deleteFile: vi.fn(() => undefined),
  createProgressHandler: () => () => {},
  batchGetDownloadUrls: vi.fn(async () => []),
}));
import * as storage from '@/libs/storage';

const baseResolver = Layer.provideMerge(TestPathResolverLive, PathStateLive);

const makeFs = (over: Partial<FileSystemShape> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    exists: () => Effect.succeed(false),
    removeFile: () => Effect.void,
    createDir: () => Effect.void,
    writeFile: () => Effect.void,
    openFile: (path: string) =>
      Effect.succeed(new File([new Uint8Array(8)], path.split('/').pop() ?? 'f')),
    ...over,
  } as unknown as FileSystemShape);

const mkLayer = (fs: Layer.Layer<FileSystem>) =>
  Layer.provide(CloudServiceLive, Layer.merge(fs, baseResolver));
const run = <A>(p: Effect.Effect<A, unknown, CloudService>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(mkLayer(fs))) as Effect.Effect<A, unknown, never>);

const book = { hash: 'h1', title: 'T', uploadedAt: Date.now() } as unknown as Book;

describe('CloudService (live over stub FileSystem, storage mocked)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploadBook throws CloudError when no local files exist', async () => {
    const err = (await run(
      Effect.flatMap(CloudService, (c) => c.uploadBook(book)).pipe(Effect.flip),
      makeFs({ exists: () => Effect.succeed(false) }),
    )) as CloudError;
    expect(err).toBeInstanceOf(CloudError);
    expect(err.operation).toBe('uploadBook');
  });

  it('deleteBook (local) removes the local book file', async () => {
    const removeFile = vi.fn(() => Effect.void);
    await run(
      Effect.flatMap(CloudService, (c) => c.deleteBook(book, 'local')),
      makeFs({ exists: () => Effect.succeed(true), removeFile }),
    );
    expect(removeFile).toHaveBeenCalled();
  });

  it('downloadReplicaFile resolves dst before downloading', async () => {
    await run(
      Effect.flatMap(CloudService, (c) =>
        c.downloadReplicaFile({
          kind: 'dictionary',
          replicaId: 'r1',
          filename: 'd.zip',
          lfp: 'r1/d.zip',
          base: 'Dictionaries',
        }),
      ),
      makeFs(),
    );
    expect(storage.downloadFile).toHaveBeenCalledTimes(1);
    const arg = (storage.downloadFile as unknown as Mock).mock.calls[0]![0];
    expect(typeof arg.dst).toBe('string');
    expect(arg.dst).toContain('r1/d.zip'); // resolveFilePath prefixed it
  });

  it('maps a storage rejection to CloudError', async () => {
    (storage.batchGetDownloadUrls as unknown as Mock).mockRejectedValueOnce(new Error('boom'));
    const err = (await run(
      Effect.flatMap(CloudService, (c) => c.downloadBookCovers([book])).pipe(Effect.flip),
      makeFs(),
    )) as CloudError;
    expect(err).toBeInstanceOf(CloudError);
    expect(err.operation).toBe('downloadBookCovers');
  });
});
