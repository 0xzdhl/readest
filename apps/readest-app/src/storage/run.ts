import { Effect } from 'effect';
import type { StorageNotFoundError, StorageRequestError, StorageSignError } from './errors';
import { StorageLive } from './live';
import type { ObjectStorage } from './service';

type StorageProgramError = StorageSignError | StorageRequestError | StorageNotFoundError;

export const runStorageProgram = <A>(
  program: Effect.Effect<A, StorageProgramError, ObjectStorage>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(StorageLive)));
