import { Effect, Layer } from 'effect';
import { FileSystem } from '@/application/ports/FileSystem';
import { FontService, type FontServiceShape } from '@/application/services/FontService';
import { importFont, deleteFont } from '@/application/services/fonts/fontAssets';

export const FontServiceLive = Layer.effect(
  FontService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const provide = <A, E>(e: Effect.Effect<A, E, FileSystem>) =>
      e.pipe(Effect.provideService(FileSystem, fsPort));
    return {
      importFont: (file) => provide(importFont(file)),
      deleteFont: (font) => provide(deleteFont(font)),
    } satisfies FontServiceShape;
  }),
);
