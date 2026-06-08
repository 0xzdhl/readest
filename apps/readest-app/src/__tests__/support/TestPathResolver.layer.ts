import { Effect, Layer } from 'effect';
import type { BaseDir, ResolvedPath } from '@/domain/system';
import { PathResolver, type PathResolverShape } from '@/application/ports/PathResolver';
import { PathState } from '@/application/ports/PathState';

export const TestPathResolverLive = Layer.effect(
  PathResolver,
  Effect.gen(function* () {
    const state = yield* PathState;

    const prefix = (base: BaseDir) =>
      state.get.pipe(
        Effect.map((cfg) => (cfg.customRootDir ? `${cfg.customRootDir}/${base}` : `${base}`)),
      );

    const absolute = (path: string, base: BaseDir) =>
      prefix(base).pipe(Effect.map((p) => (path ? `${p}/${path}` : p)));

    const resolve = (path: string, base: BaseDir) =>
      prefix(base).pipe(
        Effect.map(
          (p): ResolvedPath => ({
            baseDir: 0,
            basePrefix: () => Promise.resolve(p),
            fp: path,
            base,
          }),
        ),
      );

    return { resolve, prefix, absolute } satisfies PathResolverShape;
  }),
);
