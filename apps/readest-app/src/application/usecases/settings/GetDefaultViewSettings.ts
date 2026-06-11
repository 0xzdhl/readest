import { Effect } from 'effect';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';

export const GetDefaultViewSettings = Effect.flatMap(
  SettingsRepository,
  (r) => r.getDefaultViewSettings,
);
