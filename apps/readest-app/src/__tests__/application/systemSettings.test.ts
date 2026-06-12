import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathStateLive } from '@/application/ports/PathState';
import { PathResolver } from '@/application/ports/PathResolver';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import {
  loadSystemSettings,
  saveSystemSettings,
} from '@/application/services/settings/systemSettings';

const layer = Layer.merge(
  TestFileSystemLive,
  Layer.provideMerge(TestPathResolverLive, PathStateLive),
);
const run = <A, E>(p: Effect.Effect<A, E, FileSystem | PathResolver>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);
const info = { isMobile: false, isEink: false, isAppDataSandbox: false };

describe('loadSystemSettings / saveSystemSettings', () => {
  it('load with no file returns defaulted settings', async () => {
    const s = await run(loadSystemSettings(info));
    expect(s.version).toBeGreaterThan(0);
    expect(s.globalViewSettings).toBeDefined();
    expect(s.localBooksDir).toBeDefined();
  });

  it('save then load round-trips a custom field', async () => {
    const loaded = await run(
      Effect.gen(function* () {
        const s = yield* loadSystemSettings(info);
        yield* saveSystemSettings({ ...s, customRootDir: '/picked' });
        return yield* loadSystemSettings(info);
      }),
    );
    expect(loaded.customRootDir).toBe('/picked');
  });
});
