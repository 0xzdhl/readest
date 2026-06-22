import { Effect } from 'effect';
import { create } from 'zustand';
import type { SystemSettings } from '@/domain/settings';
import type { Book, BookConfig, BookNote } from '@/domain/book';
import type { BookDoc } from '@/domain/document';
import { BookRepository } from '@/application/repositories/BookRepository';
import { LibraryRepository } from '@/application/repositories/LibraryRepository';
import { getClientRuntime } from '@/runtime/clientRuntime';
import { useLibraryStore } from './libraryStore';

/**
 * Upper bound (ms) on how far ahead of wall-clock a monotonic timestamp bump is
 * allowed to chase a pulled value. Past this, a far-future timestamp (clock
 * skew / corruption) is treated as bogus and the stamp resets to `now` instead
 * of pinning this device permanently "ahead" on last-write-wins.
 */
export const MONOTONIC_BUMP_BOUND_MS = 5_000;

/**
 * Next timestamp for a deliberate local config write under last-write-wins.
 *
 * It must out-stamp a value this device may have just pulled (so LWW picks this
 * device for a deliberate change), while staying anchored to wall-clock:
 *  - prev in the past (normal)            → `now`
 *  - prev == now / slightly ahead (tie or → `prev + 1` (strictly monotonic)
 *    tiny skew, within the bound)
 *  - prev far in the future (> bound)     → `now` (ignore the bogus value)
 */
export const nextMonotonicTimestamp = (
  prev: number | undefined,
  now: number,
  bound: number = MONOTONIC_BUMP_BOUND_MS,
): number => {
  const previous = prev ?? 0;
  return previous >= now && previous < now + bound ? previous + 1 : now;
};

export interface BookData {
  /* Persistent data shared with different views of the same book */
  id: string;
  book: Book | null;
  file: File | null;
  config: BookConfig | null;
  bookDoc: BookDoc | null;
  isFixedLayout: boolean;
}

interface BookDataState {
  booksData: { [id: string]: BookData };
  getConfig: (key: string | null) => BookConfig | null;
  setConfig: (key: string, partialConfig: Partial<BookConfig>) => void;
  saveConfig: (bookKey: string, config: BookConfig, settings: SystemSettings) => Promise<void>;
  updateBooknotes: (key: string, booknotes: BookNote[]) => BookConfig | undefined;
  getBookData: (keyOrId: string) => BookData | null;
  clearBookData: (keyOrId: string) => void;
  clearAll: () => void;
}

export const useBookDataStore = create<BookDataState>((set, get) => ({
  booksData: {},
  getBookData: (keyOrId: string) => {
    const id = keyOrId.split('-')[0]!;
    return get().booksData[id] || null;
  },
  clearBookData: (keyOrId: string) => {
    const id = keyOrId.split('-')[0]!;
    set((state) => {
      const newBooksData = { ...state.booksData };
      delete newBooksData[id];
      return {
        booksData: newBooksData,
      };
    });
  },
  clearAll: () => {
    set({ booksData: {} });
  },
  getConfig: (key: string | null) => {
    if (!key) return null;
    const id = key.split('-')[0]!;
    return get().booksData[id]?.config || null;
  },
  setConfig: (key: string, partialConfig: Partial<BookConfig>) => {
    set((state: BookDataState) => {
      const id = key.split('-')[0]!;
      const config = state.booksData[id]?.config;
      if (!config) {
        console.warn('No config found for book', id);
        return state;
      }
      return {
        booksData: {
          ...state.booksData,
          [id]: {
            ...state.booksData[id]!,
            config: { ...config, ...partialConfig },
          },
        },
      };
    });
  },
  saveConfig: async (bookKey: string, config: BookConfig, settings: SystemSettings) => {
    const { library, hashIndex, setLibrary } = useLibraryStore.getState();
    const hash = bookKey.split('-')[0]!;
    const idx = hashIndex.get(hash);
    if (idx === undefined) return;

    // Immutably move the book to the front of the library with updated
    // progress and timestamps. We do NOT mutate the existing book object or
    // the existing library array — Zustand subscribers see fresh references
    // and the visibleLibrary cache stays in sync via setLibrary's full update.
    const original = library[idx]!;
    // Monotonic, wall-clock-anchored stamp so a deliberate local write wins LWW
    // over a value it may have just pulled. Book row and config share one stamp
    // (they are the same logical update). See nextMonotonicTimestamp.
    const stamp = nextMonotonicTimestamp(config.updatedAt, Date.now());
    const updatedBook: Book = {
      ...original,
      progress: config.progress,
      updatedAt: stamp,
      downloadedAt: original.downloadedAt || Date.now(),
    };
    const newLibrary = [updatedBook, ...library.slice(0, idx), ...library.slice(idx + 1)];
    setLibrary(newLibrary);

    config.updatedAt = stamp;
    const runtime = getClientRuntime();
    await runtime.runPromise(
      Effect.flatMap(BookRepository, (r) => r.saveConfig(updatedBook, config, settings)),
    );
    await runtime.runPromise(
      Effect.flatMap(LibraryRepository, (r) => r.save(useLibraryStore.getState().library)),
    );
  },
  updateBooknotes: (key: string, booknotes: BookNote[]) => {
    let updatedConfig: BookConfig | undefined;
    set((state) => {
      const id = key.split('-')[0]!;
      const book = state.booksData[id];
      if (!book) return state;
      const dedupedBooknotes = Array.from(
        new Map(booknotes.map((item) => [`${item.id}-${item.type}-${item.cfi}`, item])).values(),
      );
      updatedConfig = {
        ...book.config,
        updatedAt: Date.now(),
        booknotes: dedupedBooknotes,
      };
      return {
        booksData: {
          ...state.booksData,
          [id]: {
            ...book,
            config: {
              ...book.config,
              updatedAt: Date.now(),
              booknotes: dedupedBooknotes,
            },
          },
        },
      };
    });
    return updatedConfig;
  },
}));
