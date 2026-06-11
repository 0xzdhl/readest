import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { LibraryRepositoryLive } from '@/infra/shared/LibraryRepository.layer';
import { CoverServiceLive } from '@/infra/shared/CoverService.layer';
import { TestPlatformLive } from '@/__tests__/support/TestPlatform.layer';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { PathStateLive } from '@/application/ports/PathState';

const Base = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const Ports = Layer.mergeAll(TestPlatformLive, TestFileSystemLive, Base);
const Cover = Layer.provide(CoverServiceLive, Ports);
const layer = Layer.provide(LibraryRepositoryLive, Layer.merge(Ports, Cover));
const run = <A>(p: Effect.Effect<A, unknown, LibraryRepository>) =>
  Effect.runPromise(p.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('LibraryRepository (live over test ports)', () => {
  it('load returns [] when no library.json exists', async () => {
    const books = await run(Effect.flatMap(LibraryRepository, (r) => r.load));
    expect(Array.isArray(books)).toBe(true);
    expect(books).toEqual([]);
  });
});
