import { Effect, Layer } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import {
  SettingsRepository,
  type SettingsRepositoryShape,
} from '@/application/repositories/SettingsRepository';
import { getDefaultViewSettings } from '@/application/services/settings/viewSettings';
import {
  loadSystemSettings,
  saveSystemSettings,
} from '@/application/services/settings/systemSettings';

export const SettingsRepositoryLive = Layer.effect(
  SettingsRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const info = yield* (yield* Platform).info;

    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem | PathResolver>) =>
      e.pipe(
        Effect.provideService(FileSystem, fsPort),
        Effect.provideService(PathResolver, resolver),
      );

    const ctx = {
      isMobile: info.isMobile,
      isEink: info.isEink,
      isAppDataSandbox: info.isAppDataSandbox,
    };

    return {
      load: provide(loadSystemSettings(ctx)),
      save: (s: SystemSettings) => provide(saveSystemSettings(s)),
      getDefaultViewSettings: Effect.sync(() =>
        getDefaultViewSettings({ isMobile: info.isMobile, isEink: info.isEink }),
      ),
    } satisfies SettingsRepositoryShape;
  }),
);
