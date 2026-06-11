import { Effect, Layer } from 'effect';
import type { DatabaseService } from '@/domain/database';
import { DatabaseError } from '@/application/errors/AppError';
import { Database, type DatabaseShape, type OpenDatabaseInput } from '@/application/ports/Database';
import { PathResolver } from '@/application/ports/PathResolver';

/**
 * Faithful port of the legacy web openDatabase routine
 * into the `DatabaseShape` port.
 *
 * - Resolves the absolute "path" via the injected `PathResolver` (same as
 *   `resolveFilePath` in the legacy service).
 * - Flattens path separators to a single OPFS-safe segment:
 *   OPFS `getFileHandle` rejects names containing path separators, and the
 *   Turso WASM connector passes the whole string as a single OPFS handle
 *   name without traversing directories. Flatten to a safe single segment.
 * - Dynamic-imports `WebDatabaseService`, `migrate`, and `getMigrations`
 *   from the existing `@/services/database/*` modules — the driver is reused as-is.
 * - Runs schema migration after opening.
 * - Wraps every async step in `Effect.tryPromise` → `DatabaseError`.
 */
export const WebDatabaseLive = Layer.effect(
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
        Effect.flatMap((fullPath) => {
          // OPFS `getFileHandle` rejects names containing path separators, and the
          // Turso WASM connector passes the whole string as a single OPFS handle
          // name without traversing directories. Flatten to a safe single segment.
          const opfsName = fullPath.replace(/[/\\]+/g, '_').replace(/^_+/, '');

          return Effect.tryPromise({
            try: async (): Promise<DatabaseService> => {
              const { WebDatabaseService } = await import('@/services/database/webDatabaseService');
              const db = await WebDatabaseService.open(opfsName, opts);
              const { migrate } = await import('@/services/database/migrate');
              const { getMigrations } = await import('@/services/database/migrations');
              await migrate(db, getMigrations(schema));
              return db;
            },
            catch: (cause) => new DatabaseError({ operation: 'open', path: opfsName, cause }),
          });
        }),
      );

    return { open } satisfies DatabaseShape;
  }),
);
