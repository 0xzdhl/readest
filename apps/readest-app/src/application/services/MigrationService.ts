import { Context, type Effect } from 'effect';
import type { MigrationError } from '@/application/errors/AppError';

export type RunMigrationsInput = {
  readonly lastMigrationVersion: number;
};

export interface MigrationServiceShape {
  // Runs any migrations newer than lastMigrationVersion; resolves to the current version.
  readonly run: (input: RunMigrationsInput) => Effect.Effect<number, MigrationError>;
  readonly currentVersion: number;
}

export class MigrationService extends Context.Tag('app/MigrationService')<
  MigrationService,
  MigrationServiceShape
>() {}
