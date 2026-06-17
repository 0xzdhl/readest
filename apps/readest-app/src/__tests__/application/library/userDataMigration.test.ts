import { Effect, Layer } from 'effect';
import { describe, expect, it, beforeEach } from 'vitest';
import { FileSystem } from '@/application/ports/FileSystem';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';
import { migrateIntoNamespace } from '@/application/services/library/userDataMigration';
import type { Book } from '@/domain/book';

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const layer = Layer.mergeAll(TestFileSystemLive, Base);

const run = <A>(p: Effect.Effect<A, unknown, FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

const seedBook = (hash: string): Book =>
  ({
    hash,
    format: 'EPUB',
    title: 'Test Book',
    author: 'Author',
    createdAt: 0,
    updatedAt: 0,
  }) as Book;

describe('migrateIntoNamespace', () => {
  beforeEach(() => {
    // Each test gets a fresh TestFileSystemLive (new layer instance)
  });

  it('migrates legacy canonical library.json + config.json to target namespace, leaves binaries', async () => {
    const bookHash = 'h1';
    const books: Book[] = [seedBook(bookHash)];
    const binaryContent = 'BINARY_DATA';

    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        // Seed legacy canonical library.json
        yield* fs.writeFile('library.json', 'Books', JSON.stringify(books));
        // Seed legacy config
        yield* fs.writeFile(`${bookHash}/config.json`, 'Books', JSON.stringify({ updatedAt: 1 }));
        // Seed a binary (cover.png) — must NOT be moved
        yield* fs.writeFile(`${bookHash}/cover.png`, 'Books', binaryContent);

        yield* migrateIntoNamespace('user-A');

        // Assert destination exists
        const destLibExists = yield* fs.exists('users/user-A/library.json', 'Books');
        expect(destLibExists).toBe(true);

        const destConfigExists = yield* fs.exists('users/user-A/h1/config.json', 'Books');
        expect(destConfigExists).toBe(true);

        // Assert source legacy files are gone
        const srcLibExists = yield* fs.exists('library.json', 'Books');
        expect(srcLibExists).toBe(false);

        const srcConfigExists = yield* fs.exists('h1/config.json', 'Books');
        expect(srcConfigExists).toBe(false);

        // Binary must be UNTOUCHED
        const binaryExists = yield* fs.exists('h1/cover.png', 'Books');
        expect(binaryExists).toBe(true);
      }),
    );
  });

  it('is a no-op when users/<targetNs>/library.json already exists', async () => {
    const books: Book[] = [seedBook('h2')];
    const existingContent = JSON.stringify([seedBook('already-there')]);

    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        // Seed the destination already present
        yield* fs.writeFile('users/user-A/library.json', 'Books', existingContent);
        // Also seed the legacy source — should not be touched
        yield* fs.writeFile('library.json', 'Books', JSON.stringify(books));
        yield* fs.writeFile('h2/config.json', 'Books', JSON.stringify({ updatedAt: 2 }));

        yield* migrateIntoNamespace('user-A');

        // Destination is untouched (still has original content)
        const destLib = yield* fs.readFile('users/user-A/library.json', 'Books', 'text');
        expect(destLib).toBe(existingContent);

        // Source must still exist (no-op)
        const srcLibExists = yield* fs.exists('library.json', 'Books');
        expect(srcLibExists).toBe(true);
      }),
    );
  });

  it('adopts users/local/* when no canonical library.json and targetNs is not local', async () => {
    const bookHash = 'h3';
    const books: Book[] = [seedBook(bookHash)];

    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        // Seed local namespace files only (no canonical library.json)
        yield* fs.writeFile('users/local/library.json', 'Books', JSON.stringify(books));
        yield* fs.writeFile(
          `users/local/${bookHash}/config.json`,
          'Books',
          JSON.stringify({ updatedAt: 3 }),
        );

        yield* migrateIntoNamespace('user-B');

        // Destination exists
        const destLibExists = yield* fs.exists('users/user-B/library.json', 'Books');
        expect(destLibExists).toBe(true);

        const destConfigExists = yield* fs.exists(`users/user-B/${bookHash}/config.json`, 'Books');
        expect(destConfigExists).toBe(true);

        // Source removed
        const srcLibExists = yield* fs.exists('users/local/library.json', 'Books');
        expect(srcLibExists).toBe(false);

        const srcConfigExists = yield* fs.exists(`users/local/${bookHash}/config.json`, 'Books');
        expect(srcConfigExists).toBe(false);
      }),
    );
  });

  it('is a no-op when no sources exist', async () => {
    await expect(run(migrateIntoNamespace('user-C'))).resolves.toBeUndefined();
  });
});
