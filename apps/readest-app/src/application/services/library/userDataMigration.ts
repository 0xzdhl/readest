import { Effect } from 'effect';
import type { Book } from '@/domain/book';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { LOCAL_NAMESPACE } from '@/services/userNamespace';
import { getLibraryFilename } from '@/utils/book';

/**
 * One-time, idempotent migration that moves pre-existing (legacy or anonymous)
 * per-user JSON metadata into a target user's namespace directory.
 *
 * Priority:
 *   1. No-op if `users/<targetNs>/library.json` already exists.
 *   2. Migrate LEGACY: canonical `Books/library.json` + per-book config.json files.
 *   3. Migrate ANONYMOUS: `users/local/library.json` → `users/<targetNs>/...`
 *      (only when targetNs !== LOCAL_NAMESPACE).
 *   4. No sources found → no-op.
 *
 * Book binaries (epub/cover.png/nav.json) are SHARED and are never moved.
 */
export const migrateIntoNamespace = (
  targetNs: string,
): Effect.Effect<void, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const destLibraryPath = `users/${targetNs}/library.json`;

    // Gate: already migrated — no-op
    const alreadyMigrated = yield* fs.exists(destLibraryPath, 'Books');
    if (alreadyMigrated) return;

    // Determine source in priority order
    const legacyLibPath = getLibraryFilename(); // 'library.json'
    const hasLegacy = yield* fs.exists(legacyLibPath, 'Books');

    const hasLocal =
      !hasLegacy &&
      targetNs !== LOCAL_NAMESPACE &&
      (yield* fs.exists(`users/${LOCAL_NAMESPACE}/library.json`, 'Books'));

    if (!hasLegacy && !hasLocal) return;

    // Resolve source paths
    const srcLibraryPath = hasLegacy ? legacyLibPath : `users/${LOCAL_NAMESPACE}/library.json`;
    const srcConfigPrefix = hasLegacy ? '' : `users/${LOCAL_NAMESPACE}/`;

    // Read + parse the library
    const raw = yield* fs
      .readFile(srcLibraryPath, 'Books', 'text')
      .pipe(Effect.mapError((cause) => new BookError({ operation: 'migrateNamespace', cause })));

    if (typeof raw !== 'string') {
      return yield* Effect.fail(
        new BookError({
          operation: 'migrateNamespace',
          cause: 'library.json was not text',
        }),
      );
    }

    let books: Book[];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return yield* Effect.fail(
          new BookError({
            operation: 'migrateNamespace',
            cause: 'library.json did not contain an array',
          }),
        );
      }
      books = parsed as Book[];
    } catch (cause) {
      return yield* Effect.fail(new BookError({ operation: 'migrateNamespace', cause }));
    }

    // Ensure target dir exists
    yield* fs
      .createDir(`users/${targetNs}`, 'Books', true)
      .pipe(Effect.mapError((cause) => new BookError({ operation: 'migrateNamespace', cause })));

    // Write library to destination
    yield* fs
      .writeFile(destLibraryPath, 'Books', raw)
      .pipe(Effect.mapError((cause) => new BookError({ operation: 'migrateNamespace', cause })));

    // Remove source library (gate step — allow propagation as BookError)
    yield* fs
      .removeFile(srcLibraryPath, 'Books')
      .pipe(Effect.mapError((cause) => new BookError({ operation: 'migrateNamespace', cause })));

    // Migrate each book's config.json (best-effort per book)
    for (const book of books) {
      if (!book.hash) continue;
      const srcConfig = `${srcConfigPrefix}${book.hash}/config.json`;
      const destConfig = `users/${targetNs}/${book.hash}/config.json`;

      yield* Effect.gen(function* () {
        const configExists = yield* fs.exists(srcConfig, 'Books');
        if (!configExists) return;

        const configRaw = yield* fs.readFile(srcConfig, 'Books', 'text');
        yield* fs.createDir(`users/${targetNs}/${book.hash}`, 'Books', true);
        yield* fs.writeFile(destConfig, 'Books', configRaw);
        yield* fs.removeFile(srcConfig, 'Books');
      }).pipe(
        // A single book's config failure must not abort the whole migration
        Effect.catchAll((_err) => Effect.void),
      );
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof BookError ? cause : new BookError({ operation: 'migrateNamespace', cause }),
    ),
  );
