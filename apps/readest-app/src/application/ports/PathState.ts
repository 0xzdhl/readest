import { Context, Effect, Layer, Ref } from 'effect';

export type PathConfig = {
  readonly customRootDir?: string;
  readonly execDir?: string;
  readonly isPortable: boolean;
};

export interface PathStateShape {
  readonly get: Effect.Effect<PathConfig>;
  readonly set: (config: PathConfig) => Effect.Effect<void>;
  readonly update: (f: (config: PathConfig) => PathConfig) => Effect.Effect<void>;
}

export class PathState extends Context.Tag('app/PathState')<PathState, PathStateShape>() {}

export const PathStateLive = Layer.effect(
  PathState,
  Effect.gen(function* () {
    const ref = yield* Ref.make<PathConfig>({ isPortable: false });
    return {
      get: Ref.get(ref),
      set: (config) => Ref.set(ref, config),
      update: (f) => Ref.update(ref, f),
    } satisfies PathStateShape;
  }),
);
