import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { FileSystem } from '@/application/ports/FileSystem';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';
import { safeLoadJsonE, safeSaveJsonE } from '@/application/services/settings/json';

const run = <A, E>(p: Effect.Effect<A, E, FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(TestFileSystemLive)) as Effect.Effect<A, E, never>);

describe('settings JSON helpers (FileSystem port)', () => {
  it('save then load round-trips', async () => {
    const out = await run(
      Effect.gen(function* () {
        yield* safeSaveJsonE('f.json', 'Settings', { a: 1 });
        return yield* safeLoadJsonE<{ a: number }>('f.json', 'Settings', { a: 0 });
      }),
    );
    expect(out).toEqual({ a: 1 });
  });

  it('load returns default when absent', async () => {
    const out = await run(safeLoadJsonE<{ a: number }>('missing.json', 'Settings', { a: 42 }));
    expect(out).toEqual({ a: 42 });
  });
});
