import { Effect } from 'effect';
import type { BaseDir } from '@/domain/system';
import { FsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';

const parse = <T>(text: unknown): T | undefined => {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/** Mirror of persistence.safeLoadJSON: main -> .bak (restore) -> default; never fails for absence. */
export const safeLoadJsonE = <T>(
  filename: string,
  base: BaseDir,
  defaultValue: T,
): Effect.Effect<T, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const main = parse<T>(
      yield* fs.readFile(filename, base, 'text').pipe(Effect.orElseSucceed(() => '')),
    );
    if (main !== undefined) return main;
    const bak = parse<T>(
      yield* fs.readFile(`${filename}.bak`, base, 'text').pipe(Effect.orElseSucceed(() => '')),
    );
    if (bak !== undefined) {
      yield* fs
        .writeFile(filename, base, JSON.stringify(bak, null, 2))
        .pipe(Effect.catchAll(() => Effect.void)); // restore is best-effort (legacy logs + continues)
      return bak;
    }
    return defaultValue;
  });

/** Mirror of persistence.safeSaveJSON: write .bak then main. */
export const safeSaveJsonE = (
  filename: string,
  base: BaseDir,
  data: unknown,
): Effect.Effect<void, FsError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const json = JSON.stringify(data);
    yield* fs.writeFile(`${filename}.bak`, base, json);
    yield* fs.writeFile(filename, base, json);
  });
