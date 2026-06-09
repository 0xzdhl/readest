import { Effect } from 'effect';
import { FileSystem } from '@/application/ports/FileSystem';
import { getClientRuntime } from '@/runtime/clientRuntime';
import { MAX_KNOWN_ENTRIES, OPDS_SUBSCRIPTIONS_DIR } from './types';
import type { OPDSSubscriptionState } from './types';

export function emptyState(catalogId: string): OPDSSubscriptionState {
  return {
    catalogId,
    lastCheckedAt: 0,
    knownEntryIds: [],
    failedEntries: [],
  };
}

export function pruneKnownEntryIds(ids: string[]): string[] {
  if (ids.length <= MAX_KNOWN_ENTRIES) return ids;
  return ids.slice(ids.length - MAX_KNOWN_ENTRIES);
}

function statePath(catalogId: string): string {
  return `${OPDS_SUBSCRIPTIONS_DIR}/${catalogId}.json`;
}

// Heal state files written by older versions that could append the same
// entryId to failedEntries multiple times during back-off retries. Keeps
// the entry with the highest attempts count (most recent attempt) so
// retry-eligibility is computed correctly.
function dedupeFailedEntries(entries: OPDSSubscriptionState['failedEntries']) {
  const byId = new Map<string, OPDSSubscriptionState['failedEntries'][number]>();
  for (const entry of entries) {
    const prev = byId.get(entry.entryId);
    if (!prev || entry.attempts > prev.attempts || entry.lastAttemptAt > prev.lastAttemptAt) {
      byId.set(entry.entryId, entry);
    }
  }
  return Array.from(byId.values());
}

export async function loadSubscriptionState(catalogId: string): Promise<OPDSSubscriptionState> {
  const path = statePath(catalogId);
  try {
    const fileExists = await getClientRuntime().runPromise(
      Effect.flatMap(FileSystem, (fs) => fs.exists(path, 'Data')),
    );
    if (!fileExists) return emptyState(catalogId);

    const content = await getClientRuntime().runPromise(
      Effect.flatMap(FileSystem, (fs) => fs.readFile(path, 'Data', 'text')),
    );
    const parsed = JSON.parse(content as string) as OPDSSubscriptionState;
    return {
      ...parsed,
      failedEntries: dedupeFailedEntries(parsed.failedEntries ?? []),
    };
  } catch {
    console.error(`OPDS: failed to load subscription state for ${catalogId}, using empty state`);
    return emptyState(catalogId);
  }
}

export async function saveSubscriptionState(state: OPDSSubscriptionState): Promise<void> {
  await getClientRuntime().runPromise(
    Effect.flatMap(FileSystem, (fs) => fs.createDir(OPDS_SUBSCRIPTIONS_DIR, 'Data', true)),
  );
  const path = statePath(state.catalogId);
  const content = JSON.stringify(state, null, 2);
  await getClientRuntime().runPromise(
    Effect.flatMap(FileSystem, (fs) => fs.writeFile(path, 'Data', content)),
  );
}

export async function deleteSubscriptionState(catalogId: string): Promise<void> {
  try {
    await getClientRuntime().runPromise(
      Effect.flatMap(FileSystem, (fs) => fs.removeFile(statePath(catalogId), 'Data')),
    );
  } catch {
    // File may not exist — that's fine
  }
}
