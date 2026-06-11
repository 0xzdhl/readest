import { Context, type Effect } from 'effect';
import type { SelectedFile } from '@/domain/file-selector';
import type { ImportDictionariesResult, ImportedDictionary } from '@/domain/dictionaries';
import type { AssetError } from '@/application/errors/AppError';

export interface DictionaryServiceShape {
  readonly importDictionaries: (
    files: SelectedFile[],
    existingDictionaries?: ImportedDictionary[],
  ) => Effect.Effect<ImportDictionariesResult, AssetError>;
  readonly deleteDictionary: (dict: ImportedDictionary) => Effect.Effect<void, AssetError>;
}

export class DictionaryService extends Context.Tag('app/DictionaryService')<
  DictionaryService,
  DictionaryServiceShape
>() {}
