import { invoke } from '@tauri-apps/api/core';
import { Effect } from 'effect';
import type { Book } from '@/domain/book';
import { getClientRuntime, getPlatformInfo } from '@/runtime/clientRuntime';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { CloudService } from '@/application/services/CloudService';
import { getCoverFilename } from './book';
import { processDiscordCover } from './image';

type CacheEntry = {
  url: string | null;
  timestamp: number;
};

const coverUrlCache = new Map<string, CacheEntry>();
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

// Mirrors the legacy `appService.isDesktopApp` (false on web; native is
// macos/windows/linux) via the SSR-safe Platform-port snapshot.
const isDesktopApp = () => getPlatformInfo().isDesktopApp;

type BookPresence = {
  bookHash: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
  sessionStart: number;
};

/**
 * Get an HTTPS cover URL suitable for Discord Rich Presence
 * - Caches successful uploads for session
 * - Caches failures (undefined) for 1 hour to avoid retries
 * - Processes cover with Readest icon overlay
 */
const getCoverUrlForDiscord = async (book: Book): Promise<string | undefined> => {
  const cached = coverUrlCache.get(book.hash);
  if (cached) {
    const isExpired = Date.now() - cached.timestamp > CACHE_DURATION;
    if (!isExpired) {
      return cached.url ?? undefined;
    }
    if (!cached.url) {
      coverUrlCache.delete(book.hash);
    }
  }

  try {
    const rt = getClientRuntime();
    const fp = getCoverFilename(book);

    const exists = await rt.runPromise(Effect.flatMap(FileSystem, (fs) => fs.exists(fp, 'Books')));
    if (!exists) {
      coverUrlCache.set(book.hash, { url: null, timestamp: Date.now() });
      return undefined;
    }

    const cacheKey = `drp_${book.hash}.jpg`;
    // Check if processed image exists in cache
    const cachedExists = await rt.runPromise(
      Effect.flatMap(FileSystem, (fs) => fs.exists(cacheKey, 'Cache')),
    );
    if (cachedExists) {
      const downloadUrl = await rt.runPromise(
        Effect.flatMap(CloudService, (c) =>
          c.uploadFileToCloud(cacheKey, cacheKey, 'Cache', () => {}, book.hash, true),
        ),
      );

      if (downloadUrl) {
        coverUrlCache.set(book.hash, { url: downloadUrl, timestamp: Date.now() });
        return downloadUrl;
      }
    }

    const fullPath = await rt.runPromise(
      Effect.flatMap(PathResolver, (r) => r.absolute(fp, 'Books')),
    );
    const coverUrl = rt.runSync(Effect.flatMap(FileSystem, (fs) => fs.getUrl(fullPath)));
    const iconUrl = '/icon-tiny.png';

    const processedBlob = await processDiscordCover(coverUrl, iconUrl);
    console.log('Processed Discord cover for book:', book.title);
    const arrayBuffer = await processedBlob.arrayBuffer();
    await rt.runPromise(
      Effect.flatMap(FileSystem, (fs) => fs.writeFile(cacheKey, 'Cache', arrayBuffer)),
    );
    const downloadUrl = await rt.runPromise(
      Effect.flatMap(CloudService, (c) =>
        c.uploadFileToCloud(cacheKey, cacheKey, 'Cache', () => {}, book.hash, true),
      ),
    );

    if (downloadUrl) {
      coverUrlCache.set(book.hash, { url: downloadUrl, timestamp: Date.now() });
      return downloadUrl;
    }
    coverUrlCache.set(book.hash, { url: null, timestamp: Date.now() });
    return undefined;
  } catch (error) {
    console.warn('Failed to process/upload cover for Discord:', error);
    coverUrlCache.set(book.hash, { url: null, timestamp: Date.now() });
    return undefined;
  }
};

/**
 * Update Discord Rich Presence with current book information
 */
export const updateDiscordPresence = async (book: Book, sessionStart: number): Promise<void> => {
  if (!isDesktopApp()) return;

  try {
    const coverUrl = await getCoverUrlForDiscord(book);
    const bookPresence: BookPresence = {
      bookHash: book.hash,
      title: book.title,
      author: book.author || null,
      coverUrl: coverUrl || null,
      sessionStart,
    };

    await invoke('update_book_presence', { presence: bookPresence });
  } catch (error) {
    console.warn('Failed to update Discord presence:', error);
  }
};

/**
 * Clear Discord Rich Presence
 */
export const clearDiscordPresence = async (): Promise<void> => {
  if (!isDesktopApp()) return;

  try {
    await invoke('clear_book_presence');
  } catch (error) {
    console.warn('Failed to clear Discord presence:', error);
  }
};
