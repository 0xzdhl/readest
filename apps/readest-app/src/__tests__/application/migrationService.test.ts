import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { MigrationService } from '@/application/services/MigrationService';
import { MigrationServiceLive } from '@/infra/shared/MigrationService.layer';
import { FileSystem } from '@/application/ports/FileSystem';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { getLibraryBackupFilename, getLibraryFilename } from '@/utils/book';

const layer = Layer.provideMerge(MigrationServiceLive, TestFileSystemLive);
const run = <A>(p: Effect.Effect<A, unknown, MigrationService | FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('MigrationService', () => {
  it('migrate20251124 renames the legacy backup library file', async () => {
    const result = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        // seed legacy backup file under the real getLibraryBackupFilename()
        yield* fs.writeFile(getLibraryBackupFilename(), 'Books', 'DATA');
        const m = yield* MigrationService;
        const version = yield* m.run({ lastMigrationVersion: 0 });
        const renamedExists = yield* fs.exists(`${getLibraryFilename()}.bak`, 'Books');
        const oldExists = yield* fs.exists(getLibraryBackupFilename(), 'Books');
        return { version, renamedExists, oldExists };
      }),
    );
    expect(result.renamedExists).toBe(true);
    expect(result.oldExists).toBe(false);
    expect(result.version).toBe(20251124);
  });

  it('run is a no-op when already at the current version', async () => {
    const result = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        yield* fs.writeFile(getLibraryBackupFilename(), 'Books', 'DATA');
        const m = yield* MigrationService;
        const version = yield* m.run({ lastMigrationVersion: 20251124 });
        // legacy backup file untouched because migration is gated
        const oldStillExists = yield* fs.exists(getLibraryBackupFilename(), 'Books');
        return { version, oldStillExists };
      }),
    );
    expect(result.version).toBe(20251124);
    expect(result.oldStillExists).toBe(true);
  });
});
