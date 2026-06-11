import { Effect } from 'effect';
import { Platform } from '@/application/ports/Platform';
import { PathState } from '@/application/ports/PathState';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';
import { MigrationService } from '@/application/services/MigrationService';

export const BootApp = Effect.gen(function* () {
  const platform = yield* Platform;
  const pathState = yield* PathState;
  const settingsRepo = yield* SettingsRepository;
  const migration = yield* MigrationService;

  const info = yield* platform.info;
  const settings = yield* settingsRepo.load;

  if (settings.customRootDir) {
    yield* pathState.update((current) => ({ ...current, customRootDir: settings.customRootDir }));
  }

  // Mirrors the legacy boot migration trigger: `settings.migrationVersion || 0`.
  const lastMigrationVersion = settings.migrationVersion || 0;
  yield* migration.run({ lastMigrationVersion });

  return { platform: info, settings };
});
