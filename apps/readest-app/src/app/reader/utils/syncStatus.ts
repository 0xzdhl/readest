import dayjs from 'dayjs';

/** Inputs that decide how the reader's sync menu item presents itself. */
export interface SyncStatusInput {
  /** Whether the user is authenticated (sync is available at all). */
  signedIn: boolean;
  /** True while any sync operation (push or pull) is in flight. */
  syncing: boolean;
  /** Last sync error message, or null when the last attempt succeeded. */
  error: string | null;
  /** Latest synced/pushed timestamp (ms), or 0 if never synced. */
  lastSyncTime: number;
}

/** Presentation derived from the sync lifecycle. */
export interface SyncStatus {
  /** Translated label for the menu item. */
  label: string;
  /** True while in flight — drives the looping spinner on the icon. */
  spinning: boolean;
  /** True when the icon should signal a problem (signed-out or error). */
  problem: boolean;
}

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/**
 * Pure state→UI mapping for the reader's "sync now" menu item. Kept free of
 * React so the precedence (in-flight > error > idle) is unit-testable.
 *
 * Precedence:
 *  - signed out → "Sign in to Sync" (problem)
 *  - syncing    → "Syncing…" + looping spinner (wins over a stale error)
 *  - error      → "Sync failed" (problem)
 *  - idle       → "Synced {{time}}" / "Never synced"
 */
export const getSyncStatus = (input: SyncStatusInput, _: Translate): SyncStatus => {
  const { signedIn, syncing, error, lastSyncTime } = input;
  if (!signedIn) {
    return { label: _('Sign in to Sync'), spinning: false, problem: true };
  }
  if (syncing) {
    return { label: _('Syncing…'), spinning: true, problem: false };
  }
  if (error) {
    return { label: _('Sync failed'), spinning: false, problem: true };
  }
  if (lastSyncTime) {
    return {
      label: _('Synced {{time}}', { time: dayjs(lastSyncTime).fromNow() }),
      spinning: false,
      problem: false,
    };
  }
  return { label: _('Never synced'), spinning: false, problem: false };
};
