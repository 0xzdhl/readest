import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { BookRepository } from '@/application/repositories/BookRepository';
import { BookRepositoryLive } from '@/infra/shared/BookRepository.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const layer = Layer.provide(BookRepositoryLive, Layer.merge(TestFileSystemLive, Base));
const run = <A>(p: Effect.Effect<A, unknown, BookRepository>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('BookRepository (live over test ports)', () => {
  it('isAvailable is false for a book with no local file', async () => {
    const ok = await run(
      Effect.flatMap(BookRepository, (r) =>
        r.isAvailable({ hash: 'nope', format: 'EPUB', title: 'Nope' } as never),
      ),
    );
    expect(ok).toBe(false);
  });

  it('loadNav returns null when no nav file exists', async () => {
    const nav = await run(
      Effect.flatMap(BookRepository, (r) =>
        r.loadNav({ hash: 'nope', format: 'EPUB', title: 'Nope' } as never),
      ),
    );
    expect(nav).toBeNull();
  });
});
