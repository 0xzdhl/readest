import { Effect, Layer } from 'effect';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import {
  DictionaryService,
  type DictionaryServiceShape,
} from '@/application/services/DictionaryService';

const loadModule = () => import('@/application/services/dictionaries/dictionaryService');

export const DictionaryServiceLive = Layer.effect(
  DictionaryService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    return {
      importDictionaries: (files, existingDictionaries = []) =>
        Effect.tryPromise({
          try: loadModule,
          catch: (cause) => new AssetError({ operation: 'importDictionaries', cause }),
        }).pipe(
          Effect.flatMap((m) => m.importDictionaries(files, existingDictionaries)),
          Effect.provideService(FileSystem, fsPort),
        ),
      deleteDictionary: (dict) =>
        Effect.tryPromise({
          try: loadModule,
          catch: (cause) => new AssetError({ operation: 'deleteDictionary', cause }),
        }).pipe(
          Effect.flatMap((m) => m.deleteDictionary(dict)),
          Effect.provideService(FileSystem, fsPort),
        ),
    } satisfies DictionaryServiceShape;
  }),
);
