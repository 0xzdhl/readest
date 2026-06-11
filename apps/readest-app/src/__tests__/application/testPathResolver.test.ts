import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { PathResolver } from '@/application/ports/PathResolver';
import { PathState, PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';

const layer = Layer.provideMerge(TestPathResolverLive, PathStateLive);
const run = <A>(program: Effect.Effect<A, unknown, PathResolver | PathState>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

describe('TestPathResolver', () => {
  it('default: prefix is the base name', async () => {
    const p = await run(Effect.flatMap(PathResolver, (r) => r.prefix('Books')));
    expect(p).toBe('Books');
  });

  it('custom root: absolute joins root + base + path', async () => {
    const abs = await run(
      Effect.gen(function* () {
        const state = yield* PathState;
        yield* state.set({ customRootDir: '/root', isPortable: false });
        const r = yield* PathResolver;
        return yield* r.absolute('f.epub', 'Books');
      }),
    );
    expect(abs).toBe('/root/Books/f.epub');
  });
});
