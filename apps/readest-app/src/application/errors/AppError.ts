import { Data } from 'effect';

export class FsError extends Data.TaggedError('FsError')<{
  readonly operation: string;
  readonly path?: string;
  readonly cause: unknown;
}> {}

export class PlatformError extends Data.TaggedError('PlatformError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly operation: string;
  readonly path?: string;
  readonly cause: unknown;
}> {}

export class SettingsError extends Data.TaggedError('SettingsError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class MigrationError extends Data.TaggedError('MigrationError')<{
  readonly operation: string;
  readonly fromVersion?: number;
  readonly cause: unknown;
}> {}

export class UserCancelled extends Data.TaggedError('UserCancelled')<{
  readonly operation: string;
}> {}

export type AppError =
  | FsError
  | PlatformError
  | DatabaseError
  | SettingsError
  | MigrationError
  | UserCancelled;
