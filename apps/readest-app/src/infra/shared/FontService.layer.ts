import { Effect, Layer } from 'effect';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { FontService, type FontServiceShape } from '@/application/services/FontService';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as FontSvc from '@/services/fontService';

export const FontServiceLive = Layer.effect(
  FontService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const err = (operation: string) => (cause: unknown) => new AssetError({ operation, cause });
    return {
      importFont: (file) =>
        Effect.tryPromise({ try: () => FontSvc.importFont(fs, file), catch: err('importFont') }),
      deleteFont: (font) =>
        Effect.tryPromise({ try: () => FontSvc.deleteFont(fs, font), catch: err('deleteFont') }),
    } satisfies FontServiceShape;
  }),
);
