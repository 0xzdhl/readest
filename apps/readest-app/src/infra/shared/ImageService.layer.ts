import { Effect, Layer } from 'effect';
import { FileSystem } from '@/application/ports/FileSystem';
import { ImageService, type ImageServiceShape } from '@/application/services/ImageService';
import { importImage, deleteImage } from '@/application/services/images/imageAssets';

export const ImageServiceLive = Layer.effect(
  ImageService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem>) =>
      e.pipe(Effect.provideService(FileSystem, fsPort));
    return {
      importImage: (file) => provide(importImage(file)),
      deleteImage: (texture) => provide(deleteImage(texture)),
    } satisfies ImageServiceShape;
  }),
);
