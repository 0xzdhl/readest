import { Effect } from 'effect';
import { PathState } from '@/application/ports/PathState';
import { PathResolver } from '@/application/ports/PathResolver';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';

export const ChangeRootDirectory = (customRootDir: string) =>
  Effect.gen(function* () {
    const pathState = yield* PathState;
    const resolver = yield* PathResolver;
    const settingsRepo = yield* SettingsRepository;

    const settings = yield* settingsRepo.load;
    yield* pathState.update((current) => ({ ...current, customRootDir }));
    const localBooksDir = yield* resolver.prefix('Books');
    yield* settingsRepo.save({ ...settings, customRootDir, localBooksDir });
    return { localBooksDir };
  });
