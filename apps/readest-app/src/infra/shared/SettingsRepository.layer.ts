import { Effect, Layer } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import { SettingsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import {
  SettingsRepository,
  type SettingsRepositoryShape,
} from '@/application/repositories/SettingsRepository';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import {
  getDefaultViewSettings,
  loadSettings as legacyLoadSettings,
  saveSettings as legacySaveSettings,
} from '@/services/settingsService';

export const SettingsRepositoryLive = Layer.effect(
  SettingsRepository,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const platform = yield* Platform;
    const info = yield* platform.info;

    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const ctx = {
      fs,
      isMobile: info.isMobile,
      isEink: info.isEink,
      isAppDataSandbox: info.isAppDataSandbox,
    };

    return {
      load: Effect.tryPromise({
        try: () => legacyLoadSettings(ctx),
        catch: (cause) => new SettingsError({ operation: 'load', cause }),
      }),
      save: (settings: SystemSettings) =>
        Effect.tryPromise({
          try: () => legacySaveSettings(fs, settings),
          catch: (cause) => new SettingsError({ operation: 'save', cause }),
        }),
      getDefaultViewSettings: Effect.sync(() => getDefaultViewSettings(ctx)),
    } satisfies SettingsRepositoryShape;
  }),
);
