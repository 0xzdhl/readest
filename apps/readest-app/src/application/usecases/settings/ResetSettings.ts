// Reset = remove the persisted settings file (+ .bak) then reload, which regenerates
// defaults via the repository's "no file → defaults" path. Matches legacy behavior.
import { Effect } from 'effect';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';
import { FileSystem } from '@/application/ports/FileSystem';
import { SETTINGS_FILENAME } from '@/services/constants';

export const ResetSettings = Effect.gen(function* () {
  const fs = yield* FileSystem;
  yield* fs.removeFile(SETTINGS_FILENAME, 'Settings').pipe(Effect.orElse(() => Effect.void));
  yield* fs
    .removeFile(`${SETTINGS_FILENAME}.bak`, 'Settings')
    .pipe(Effect.orElse(() => Effect.void));
  const repo = yield* SettingsRepository;
  return yield* repo.load; // returns regenerated defaults
});
