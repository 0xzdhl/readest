import { Effect } from 'effect';
import { SettingsRepository } from '@/application/repositories/SettingsRepository';

export const LoadSettings = Effect.flatMap(SettingsRepository, (r) => r.load);
