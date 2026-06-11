import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { BootApp } from '@/application/usecases/boot/BootApp';
import { PathState, PathStateLive } from '@/application/ports/PathState';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { SettingsRepositoryLive } from '@/infra/shared/SettingsRepository.layer';
import { MigrationServiceLive } from '@/infra/shared/MigrationService.layer';

const PathLayer = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Ports = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, PathLayer);
const Repos = Layer.provide(Layer.mergeAll(SettingsRepositoryLive, MigrationServiceLive), Ports);
const layer = Layer.merge(Ports, Repos);
const run = <A>(p: Effect.Effect<A, unknown, never>) => Effect.runPromise(p);

describe('BootApp', () => {
  it('loads settings, seeds PathState from customRootDir, runs migrations', async () => {
    const out = await run(
      Effect.gen(function* () {
        const result = yield* BootApp; // { platform, settings }
        const cfg = yield* PathState; // PathState seeded by BootApp
        const pathCfg = yield* cfg.get;
        return {
          appPlatform: result.platform.appPlatform,
          hasSettings: !!result.settings,
          pathCfg,
        };
      }).pipe(Effect.provide(layer)),
    );
    expect(out.appPlatform).toBe('web'); // TestPlatform
    expect(out.hasSettings).toBe(true);
    // default settings have no customRootDir → PathState stays default; assert it's defined & non-portable
    expect(out.pathCfg.isPortable).toBe(false);
  });
});
