import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { FileSystem } from '@/application/ports/FileSystem';
import { TestFileSystemLive } from '@/__tests__/support/TestFileSystem.layer';

const run = <A>(program: Effect.Effect<A, unknown, FileSystem>): Promise<A> =>
  Effect.runPromise(
    program.pipe(Effect.provide(TestFileSystemLive)) as Effect.Effect<A, unknown, never>,
  );

describe('TestFileSystem (in-memory)', () => {
  it('writes then reads text back', async () => {
    const out = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        yield* fs.writeFile('a.txt', 'Books', 'hello');
        return yield* fs.readFile('a.txt', 'Books', 'text');
      }),
    );
    expect(out).toBe('hello');
  });

  it('exists reflects writes and removes', async () => {
    const [before, afterWrite, afterRemove] = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const b = yield* fs.exists('x.txt', 'Books');
        yield* fs.writeFile('x.txt', 'Books', 'v');
        const w = yield* fs.exists('x.txt', 'Books');
        yield* fs.removeFile('x.txt', 'Books');
        const r = yield* fs.exists('x.txt', 'Books');
        return [b, w, r] as const;
      }),
    );
    expect([before, afterWrite, afterRemove]).toEqual([false, true, false]);
  });

  it('copyFile duplicates content; readDir lists by prefix', async () => {
    const items = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        yield* fs.writeFile('dir/a.txt', 'Books', 'A');
        yield* fs.copyFile('dir/a.txt', 'Books', 'dir/b.txt', 'Books');
        return yield* fs.readDir('dir', 'Books');
      }),
    );
    expect(items.map((i) => i.path).sort()).toEqual(['dir/a.txt', 'dir/b.txt']);
  });
});
