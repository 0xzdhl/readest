import { Effect, Either } from 'effect';
import type {
  StorageConfigError,
  StorageNotFoundError,
  StorageRequestError,
  StorageSignError,
} from './errors';
import { StorageLive } from './live';
import type { ObjectStorage } from './service';

export type StorageError =
  | StorageSignError
  | StorageRequestError
  | StorageNotFoundError
  | StorageConfigError;

/**
 * Runs a storage program and surfaces typed failures as an `Either` value
 * instead of rejecting the promise. Callers discriminate on `result.left._tag`
 * rather than wrapping the call in `try/catch` + `instanceof`. Config errors are
 * folded into the typed channel by `StorageConfigLive`, so they appear as
 * `Either.left` too; only genuine defects (programmer bugs) still reject.
 */
export const runStorageProgram = <A>(
  program: Effect.Effect<A, StorageError, ObjectStorage>,
): Promise<Either.Either<A, StorageError>> =>
  Effect.runPromise(program.pipe(Effect.provide(StorageLive), Effect.either));
