import { Effect } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';

export const SaveSettings = (settings: SystemSettings) =>
  Effect.flatMap(SettingsRepository, (r) => r.save(settings));
