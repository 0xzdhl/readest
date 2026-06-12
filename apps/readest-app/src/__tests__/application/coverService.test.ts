import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { CoverService } from '@/application/services/CoverService';
import { CoverServiceLive } from '@/infra/shared/CoverService.layer';
import { FileSystem } from '@/application/ports/FileSystem';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Deps = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, Base);
const layer = Layer.provide(CoverServiceLive, Deps);
const run = <A>(p: Effect.Effect<A, unknown, CoverService>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('CoverService (live over test ports)', () => {
  it('getCoverImageUrl returns a sync string derived from the book', async () => {
    const url = await run(
      Effect.map(CoverService, (c) => c.getCoverImageUrl({ hash: 'abc' } as never)),
    );
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(0);
  });

  it('generateCoverImageUrl returns a string (web -> blob url)', async () => {
    // generateCoverImageUrl on web calls getBlobUrl which requires the file to
    // exist in the store.  Seed it then call generateCoverImageUrl in one Effect
    // chain so both use the same FileSystem instance within the same layer build.
    const seedAndGet = Effect.flatMap(FileSystem, (fs) =>
      fs
        .writeFile('Books/abc/cover.png', 'None', new ArrayBuffer(8))
        .pipe(
          Effect.flatMap(() =>
            Effect.flatMap(CoverService, (c) => c.generateCoverImageUrl({ hash: 'abc' } as never)),
          ),
        ),
    );
    const seedLayer = Layer.merge(layer, Deps);
    const url = await Effect.runPromise(
      seedAndGet.pipe(Effect.provide(seedLayer)) as Effect.Effect<string, unknown, never>,
    );
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(0);
  });
});
