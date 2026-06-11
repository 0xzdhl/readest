import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { PathState, PathStateLive, type PathConfig } from '@/application/ports/PathState';

const run = <A>(program: Effect.Effect<A, never, PathState>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(PathStateLive)));

describe('PathStateLive', () => {
  it('defaults to a non-portable empty config', async () => {
    const cfg = await run(Effect.flatMap(PathState, (s) => s.get));
    expect(cfg).toEqual<PathConfig>({ isPortable: false });
  });

  it('set replaces the whole config', async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.set({ customRootDir: '/root', isPortable: true });
        return yield* s.get;
      }),
    );
    expect(cfg).toEqual({ customRootDir: '/root', isPortable: true });
  });

  it('update mutates via a function', async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.update((c) => ({ ...c, customRootDir: '/changed' }));
        return yield* s.get;
      }),
    );
    expect(cfg.customRootDir).toBe('/changed');
    expect(cfg.isPortable).toBe(false);
  });
});
