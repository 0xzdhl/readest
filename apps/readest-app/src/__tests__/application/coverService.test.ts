import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { CoverService } from '@/application/services/CoverService';
import { CoverServiceLive } from '@/infra/shared/CoverService.layer';
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
});
