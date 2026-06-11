import { Context, type Effect } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import type { ViewSettings } from '@/domain/book';
import type { SettingsError } from '@/application/errors/AppError';

export interface SettingsRepositoryShape {
  readonly load: Effect.Effect<SystemSettings, SettingsError>;
  readonly save: (settings: SystemSettings) => Effect.Effect<void, SettingsError>;
  readonly getDefaultViewSettings: Effect.Effect<ViewSettings>;
}

export class SettingsRepository extends Context.Tag('app/SettingsRepository')<
  SettingsRepository,
  SettingsRepositoryShape
>() {}
