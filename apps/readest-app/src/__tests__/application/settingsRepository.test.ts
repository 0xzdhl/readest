import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';
import { SettingsRepositoryLive } from '@/infra/shared/SettingsRepository.layer';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Deps = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, Base);
const layer = Layer.provide(SettingsRepositoryLive, Deps);
const run = <A>(p: Effect.Effect<A, unknown, SettingsRepository>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('SettingsRepository (live, over test ports)', () => {
  it('load returns defaulted settings when no file exists', async () => {
    const settings = await run(Effect.flatMap(SettingsRepository, (r) => r.load));
    expect(settings.version).toBeGreaterThan(0);
    expect(settings.globalViewSettings).toBeDefined();
    expect(settings.localBooksDir).toBeDefined();
  });

  it('save then load round-trips a custom field', async () => {
    const loaded = await run(
      Effect.gen(function* () {
        const repo = yield* SettingsRepository;
        const s = yield* repo.load;
        yield* repo.save({ ...s, customRootDir: '/picked' });
        return yield* repo.load;
      }),
    );
    expect(loaded.customRootDir).toBe('/picked');
  });
});
