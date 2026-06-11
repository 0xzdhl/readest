import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async () => {
  const { WebPathResolverLive } = await import('@/infra/web/WebPathResolver.layer');
  const { PathResolver } = await import('@/application/ports/PathResolver');
  const run = <A>(p: Effect.Effect<A, unknown, never>) => Effect.runPromise(p);
  return { PathResolver, layer: WebPathResolverLive, run };
};

describe('WebPathResolver', () => {
  afterEach(() => vi.resetModules());

  it('Books absolute = LOCAL_BOOKS_SUBDIR + path (flat relative)', async () => {
    const { PathResolver, layer, run } = await load();
    const abs = await run(
      Effect.flatMap(PathResolver, (r) => r.absolute('x.epub', 'Books')).pipe(
        Effect.provide(layer),
      ),
    );
    // LOCAL_BOOKS_SUBDIR === 'Readest/Books' in this repo.
    expect(abs).toBe('Readest/Books/x.epub');
  });

  it('Books prefix = LOCAL_BOOKS_SUBDIR (trailing slash stripped, empty basePrefix)', async () => {
    const { PathResolver, layer, run } = await load();
    const p = await run(
      Effect.flatMap(PathResolver, (r) => r.prefix('Books')).pipe(Effect.provide(layer)),
    );
    expect(p).toBe('Readest/Books');
  });

  it('resolve returns ResolvedPath with baseDir=0 and category subdir fp', async () => {
    const { PathResolver, layer, run } = await load();
    const resolved = await run(
      Effect.flatMap(PathResolver, (r) => r.resolve('x.json', 'Data')).pipe(Effect.provide(layer)),
    );
    expect(resolved.baseDir).toBe(0);
    expect(resolved.base).toBe('Data');
    expect(resolved.fp).toBe('Readest/x.json');
  });

  it('None category maps to the bare path', async () => {
    const { PathResolver, layer, run } = await load();
    const abs = await run(
      Effect.flatMap(PathResolver, (r) => r.absolute('a/b.txt', 'None')).pipe(
        Effect.provide(layer),
      ),
    );
    expect(abs).toBe('a/b.txt');
  });
});
