import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { ChangeRootDirectory } from '@/application/usecases/settings/ChangeRootDirectory';
import { LoadSettings } from '@/application/usecases/settings/LoadSettings';
import { PathState, PathStateLive } from '@/application/ports/PathState';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { SettingsRepositoryLive } from '@/infra/shared/SettingsRepository.layer';

const PathLayer = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Ports = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, PathLayer);
const layer = Layer.provideMerge(SettingsRepositoryLive, Ports);
const run = <A>(p: Effect.Effect<A, unknown, never>) => Effect.runPromise(p);

describe('ChangeRootDirectory', () => {
  it('updates PathState and persists customRootDir + localBooksDir', async () => {
    const out = await run(
      Effect.gen(function* () {
        const { localBooksDir } = yield* ChangeRootDirectory('/picked');
        const cfg = yield* (yield* PathState).get;
        const settings = yield* LoadSettings;
        return { localBooksDir, cfg, settings };
      }).pipe(Effect.provide(layer)),
    );
    expect(out.cfg.customRootDir).toBe('/picked');
    expect(out.settings.customRootDir).toBe('/picked');
    expect(out.settings.localBooksDir).toBe(out.localBooksDir);
  });
});
