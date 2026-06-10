import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { DictionaryService } from '@/application/services/DictionaryService';
import { DictionaryServiceLive } from '@/infra/shared/DictionaryService.layer';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { AssetError, FsError } from '@/application/errors/AppError';
import type { ImportedDictionary } from '@/domain/dictionaries';

const baseResolver = Layer.provideMerge(TestPathResolverLive, PathStateLive);

const makeFs = (over: Record<string, unknown> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    exists: () => Effect.succeed(false),
    removeDir: () => Effect.void,
    ...over,
  } as unknown as typeof FileSystem.Service);

const mkLayer = (fs: Layer.Layer<FileSystem>) =>
  Layer.provide(DictionaryServiceLive, Layer.merge(fs, baseResolver));
const run = <A>(p: Effect.Effect<A, unknown, DictionaryService>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(mkLayer(fs))) as Effect.Effect<A, unknown, never>);

describe('DictionaryService (live over stub FileSystem)', () => {
  it('importDictionaries with no files returns an empty result', async () => {
    const result = await run(
      Effect.flatMap(DictionaryService, (s) => s.importDictionaries([])),
      makeFs(),
    );
    expect(result.imported).toEqual([]);
    expect(result.replacements).toEqual([]);
    expect(result.orphanFiles).toEqual([]);
  });

  it('deleteDictionary removes the bundle dir when it exists', async () => {
    const removeDir = vi.fn(() => Effect.void);
    const dict = { id: '1', bundleDir: 'b1' } as ImportedDictionary;
    await run(
      Effect.flatMap(DictionaryService, (s) => s.deleteDictionary(dict)),
      makeFs({ exists: () => Effect.succeed(true), removeDir }),
    );
    expect(removeDir).toHaveBeenCalledWith('b1', 'Dictionaries', true);
  });

  it('deleteDictionary skips removeDir when the bundle dir is absent', async () => {
    const removeDir = vi.fn(() => Effect.void);
    const dict = { id: '1', bundleDir: 'b1' } as ImportedDictionary;
    await run(
      Effect.flatMap(DictionaryService, (s) => s.deleteDictionary(dict)),
      makeFs({ exists: () => Effect.succeed(false), removeDir }),
    );
    expect(removeDir).not.toHaveBeenCalled();
  });

  it('maps a failure to AssetError', async () => {
    const dict = { id: '1', bundleDir: 'b1' } as ImportedDictionary;
    const err = (await run(
      Effect.flatMap(DictionaryService, (s) => s.deleteDictionary(dict)).pipe(Effect.flip),
      makeFs({
        exists: () => Effect.fail(new FsError({ operation: 'exists', path: 'b1', cause: 'boom' })),
      }),
    )) as AssetError;
    expect(err).toBeInstanceOf(AssetError);
    expect(err.operation).toBe('deleteDictionary');
  });
});
