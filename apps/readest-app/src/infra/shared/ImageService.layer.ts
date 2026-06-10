import { Effect, Layer } from 'effect';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { ImageService, type ImageServiceShape } from '@/application/services/ImageService';
import { makeLegacyFsAdapter } from './fsPortAdapter';
import * as ImageSvc from '@/services/imageService';

export const ImageServiceLive = Layer.effect(
  ImageService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const err = (operation: string) => (cause: unknown) => new AssetError({ operation, cause });
    return {
      importImage: (file) =>
        Effect.tryPromise({ try: () => ImageSvc.importImage(fs, file), catch: err('importImage') }),
      deleteImage: (texture) =>
        Effect.tryPromise({
          try: () => ImageSvc.deleteImage(fs, texture),
          catch: err('deleteImage'),
        }),
    } satisfies ImageServiceShape;
  }),
);
