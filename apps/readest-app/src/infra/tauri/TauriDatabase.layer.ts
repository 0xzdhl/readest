import { Effect, Layer } from 'effect';
import type { DatabaseService } from '@/domain/database';
import { DatabaseError } from '@/application/errors/AppError';
import { Database, type DatabaseShape, type OpenDatabaseInput } from '@/application/ports/Database';
import { PathResolver } from '@/application/ports/PathResolver';

/**
 * Faithful port of the legacy native (Tauri) openDatabase routine
 * into the `DatabaseShape` port.
 *
 * - Resolves the absolute file path via the injected `PathResolver`.
 * - Dynamic-imports `NativeDatabaseService`, `migrate`, and `getMigrations`
 *   from the existing `@/services/database/*` modules — the driver is reused as-is.
 * - Runs schema migration after opening.
 * - Wraps every async step in `Effect.tryPromise` → `DatabaseError`.
 */
export const TauriDatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const resolver = yield* PathResolver;

    const open = ({
      schema,
      path,
      base,
      opts,
    }: OpenDatabaseInput): Effect.Effect<DatabaseService, DatabaseError> =>
      resolver.absolute(path, base).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: 'open:resolveAbsolute', path, cause }),
        ),
        Effect.flatMap((fullPath) =>
          Effect.tryPromise({
            try: async (): Promise<DatabaseService> => {
              const { NativeDatabaseService } =
                await import('@/services/database/nativeDatabaseService');
              const db = await NativeDatabaseService.open(`sqlite:${fullPath}`, opts);
              const { migrate } = await import('@/services/database/migrate');
              const { getMigrations } = await import('@/services/database/migrations');
              await migrate(db, getMigrations(schema));
              return db;
            },
            catch: (cause) => new DatabaseError({ operation: 'open', path: fullPath, cause }),
          }),
        ),
      );

    return { open } satisfies DatabaseShape;
  }),
);
