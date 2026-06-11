import { Effect, Layer } from 'effect';
import { MigrationError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import {
  MigrationService,
  type MigrationServiceShape,
} from '@/application/services/MigrationService';
import { getLibraryBackupFilename, getLibraryFilename } from '@/utils/book';

const CURRENT_MIGRATION_VERSION = 20251124;

export const MigrationServiceLive = Layer.effect(
  MigrationService,
  Effect.gen(function* () {
    const fs = yield* FileSystem;

    // Faithful port of the legacy migrate20251124 routine: rename the legacy backup
    // library file (`library_backup.json`) to `${library.json}.bak`. The legacy
    // implementation logs and swallows errors, so fold any failure to void.
    const migrate20251124 = Effect.gen(function* () {
      const oldBackupFilename = getLibraryBackupFilename();
      const newBackupFilename = `${getLibraryFilename()}.bak`;
      const present = yield* fs.exists(oldBackupFilename, 'Books');
      if (!present) return;
      const content = yield* fs.readFile(oldBackupFilename, 'Books', 'text');
      yield* fs.writeFile(newBackupFilename, 'Books', content);
      yield* fs.removeFile(oldBackupFilename, 'Books');
    }).pipe(Effect.catchAll(() => Effect.void));

    const run = (input: { lastMigrationVersion: number }) =>
      Effect.gen(function* () {
        if (input.lastMigrationVersion < 20251124) {
          yield* migrate20251124;
        }
        return CURRENT_MIGRATION_VERSION;
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.fail(
            new MigrationError({
              operation: 'run',
              fromVersion: input.lastMigrationVersion,
              cause,
            }),
          ),
        ),
      );

    return { run, currentVersion: CURRENT_MIGRATION_VERSION } satisfies MigrationServiceShape;
  }),
);
