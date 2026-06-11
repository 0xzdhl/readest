import { Effect, Layer } from 'effect';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import {
  DictionaryService,
  type DictionaryServiceShape,
} from '@/application/services/DictionaryService';
import { makeLegacyFsAdapter } from './fsPortAdapter';

export const DictionaryServiceLive = Layer.effect(
  DictionaryService,
  Effect.gen(function* () {
    const fsPort = yield* FileSystem;
    const resolver = yield* PathResolver;
    const fs = makeLegacyFsAdapter(fsPort, resolver);
    const err = (operation: string) => (cause: unknown) => new AssetError({ operation, cause });
    return {
      importDictionaries: (files, existingDictionaries = []) =>
        Effect.tryPromise({
          try: async () => {
            const m = await import('@/services/dictionaries/dictionaryService');
            return m.importDictionaries(fs, files, existingDictionaries);
          },
          catch: err('importDictionaries'),
        }),
      deleteDictionary: (dict) =>
        Effect.tryPromise({
          try: async () => {
            const m = await import('@/services/dictionaries/dictionaryService');
            return m.deleteDictionary(fs, dict);
          },
          catch: err('deleteDictionary'),
        }),
    } satisfies DictionaryServiceShape;
  }),
);
