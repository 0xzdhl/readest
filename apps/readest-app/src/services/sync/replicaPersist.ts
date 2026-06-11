/**
 * Replica-side mutators (applyRemote*, softDelete*, markAvailable*) fire from the
 * boot-time pull / download-complete handlers, NOT the settings UI. The replica
 * path has no UI saveCustomX pairing, so without auto-persist the next loadCustomX
 * would read stale settings. EffectRuntimeProvider enables this once at boot; every
 * replica-aware store checks isReplicaPersistEnabled() inside its replica-side
 * mutators and fire-and-forget saves.
 */
let replicaPersistEnabled = false;

export const enableReplicaAutoPersist = (): void => {
  replicaPersistEnabled = true;
};

export const isReplicaPersistEnabled = (): boolean => replicaPersistEnabled;

/** Test-only: reset the module flag back to disabled between cases. */
export const __resetReplicaPersistForTests = (): void => {
  replicaPersistEnabled = false;
};
