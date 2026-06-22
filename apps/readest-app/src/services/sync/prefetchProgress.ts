import type { Book, BookConfig } from '@/domain/book';
import type { DBBookConfig } from '@/types/records';
import { SyncClient } from '@/libs/sync';
import { isSyncCategoryEnabled } from '@/services/sync/syncCategories';
import { transformBookConfigFromDB } from '@/utils/transform';

const syncClient = new SyncClient();

// In-flight / resolved prefetches keyed by bookHash. Each entry resolves to the
// remote BookConfig for that book, or null when there is none (offline, not
// authenticated, deleted, or no matching row).
const prefetchCache = new Map<string, Promise<BookConfig | null>>();

/**
 * Adopt the remote reading position into the local config for the initial open,
 * using the same timestamp last-write-wins rule `applyRemoteProgress` and the
 * server's `lwwSetWhere` enforce: the most-recently-written position wins by
 * `updatedAt`, even when it is EARLIER in the book (a deliberate re-read).
 *
 * The old "furthest-CFI wins" rule was the cross-device bug — a device that was
 * BEHIND but genuinely re-reading got yanked to the furthest (stale) position on
 * open, and the carried-over LOCAL timestamp let a re-push re-stamp the stale
 * position so it never died. We now adopt the remote ONLY when it is strictly
 * newer, and carry the remote `updatedAt` forward so `applyRemoteProgress` does
 * not later treat the adopted position as "local is newer" and so a subsequent
 * re-push merely ties (not >) the server LWW gate and is dropped.
 *
 * A timestamp tie keeps the local position. Pure; never mutates.
 */
export const mergeRemoteOpenPosition = (local: BookConfig, remote: BookConfig): BookConfig => {
  if (!remote.location) return local;
  const remoteNewer = (remote.updatedAt ?? 0) > (local.updatedAt ?? 0);
  if (!remoteNewer) return local;
  return {
    ...local,
    location: remote.location,
    progress: remote.progress ?? local.progress,
    xpointer: remote.xpointer ?? local.xpointer,
    // Carry the winning timestamp forward so the adopted position is recognized
    // as remote-authored, not as a fresh local write.
    updatedAt: remote.updatedAt,
  };
};

const pullRemoteConfig = async (book: Book, userId?: string): Promise<BookConfig | null> => {
  try {
    // since = 0 → always the book's latest config row, not an incremental delta.
    const result = await syncClient.pullChanges(0, 'configs', book.hash, book.metaHash);
    const rows = (result.configs ?? []) as unknown as DBBookConfig[];
    const match = rows.find(
      (row) =>
        !row.deleted_at &&
        // Defense-in-depth: never adopt another user's reading position. Rows
        // with no user_id (legacy/local) are kept; only a present, foreign
        // user_id is rejected.
        (!userId || !row.user_id || row.user_id === userId) &&
        (row.book_hash === book.hash || row.meta_hash === book.metaHash),
    );
    return match ? transformBookConfigFromDB(match) : null;
  } catch {
    // Offline / not authenticated / server error — degrade to "no prefetch".
    return null;
  }
};

/**
 * Fire-and-forget prefetch of a book's cloud reading-progress config, started
 * when the book is launched from the library so the network round-trip overlaps
 * the book download / route navigation. No-op when progress sync is disabled.
 * Idempotent per bookHash while a pull is in flight.
 */
export const prefetchBookProgress = (book: Book, userId?: string): void => {
  if (!book.hash) return;
  if (!isSyncCategoryEnabled('progress')) return;
  if (prefetchCache.has(book.hash)) return;
  prefetchCache.set(book.hash, pullRemoteConfig(book, userId));
};

/**
 * Consume a prefetched config for `bookHash`. Awaits the in-flight pull, racing a
 * timeout, and returns the remote BookConfig (or null). One-shot: the entry is
 * removed so a stale prefetch can never be reused on a later open.
 */
export const takePrefetchedProgress = async (
  bookHash: string,
  timeoutMs = 2000,
): Promise<BookConfig | null> => {
  const pending = prefetchCache.get(bookHash);
  prefetchCache.delete(bookHash);
  if (!pending) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
};
