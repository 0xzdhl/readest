import { Effect } from 'effect';
import type { SystemSettings } from '@/domain/settings';
import { type Book, type BookConfig, type BookContent, FIXED_LAYOUT_FORMATS } from '@/domain/book';
import type { BookNav } from '@/domain/nav';
import { BookError, type FsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import {
  getDir,
  getLocalBookFilename,
  getConfigFilename,
  getBookNavFilename,
  getMetadataHash,
  formatTitle,
  getPrimaryLanguage,
} from '@/utils/book';
import { EXTS } from '@/domain/document';
import { DocumentLoader } from '@/libs/document';
import {
  DEFAULT_BOOK_SEARCH_CONFIG,
  DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS,
} from '@/services/constants';
import { isValidURL } from '@/utils/misc';
import { deserializeConfig, serializeConfig } from '@/utils/serializer';
import type { ClosableFile } from '@/utils/file';
import { BookFileNotFoundError } from '@/services/errors';

// Internal raw open: the file-resolution cascade, without BookError mapping, so
// callers (loadContent/refreshMetadata/fetchBookDetails) map exactly once.
const openBookFile = (
  book: Book,
): Effect.Effect<BookContent, FsError | BookFileNotFoundError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const fp = getLocalBookFilename(book);
    if (yield* fs.exists(fp, 'Books')) {
      return { book, file: yield* fs.openFile(fp, 'Books') };
    }
    if (book.filePath) {
      return { book, file: yield* fs.openFile(book.filePath, 'None') };
    }
    if (book.url) {
      return { book, file: yield* fs.openFile(book.url, 'None') };
    }
    // 0.9.64 bug: book.title may change without the filename being updated.
    const bookDir = getDir(book);
    const files = yield* fs.readDir(bookDir, 'Books');
    if (files.length > 0) {
      const bookFile = files.find((f) => f.path.endsWith(`.${EXTS[book.format]}`));
      if (bookFile) {
        return { book, file: yield* fs.openFile(`${bookDir}/${bookFile.path}`, 'Books') };
      }
    }
    return yield* Effect.fail(new BookFileNotFoundError());
  });

export const loadBookContent = (book: Book): Effect.Effect<BookContent, BookError, FileSystem> =>
  openBookFile(book).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'loadContent', bookId: book.hash, cause }),
    ),
  );

export const isBookAvailable = (book: Book): Effect.Effect<boolean, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const fp = getLocalBookFilename(book);
    if (yield* fs.exists(fp, 'Books')) return true;
    if (book.filePath) return yield* fs.exists(book.filePath, 'None');
    if (book.url) return isValidURL(book.url);
    return false;
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'isAvailable', bookId: book.hash, cause }),
    ),
  );

export const getBookFileSize = (book: Book): Effect.Effect<number | null, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const fp = getLocalBookFilename(book);
    if (yield* fs.exists(fp, 'Books')) {
      const file = yield* fs.openFile(fp, 'Books');
      const size = file.size;
      const f = file as ClosableFile;
      if (f && f.close) {
        yield* Effect.tryPromise(() => f.close());
      }
      return size;
    }
    return null;
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'getFileSize', bookId: book.hash, cause }),
    ),
  );

export const loadBookConfig = (
  book: Book,
  settings: SystemSettings,
): Effect.Effect<BookConfig, BookError, FileSystem> => {
  const globalViewSettings = {
    ...settings.globalViewSettings,
    ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
  };
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    let str = '{}';
    if (yield* fs.exists(getConfigFilename(book), 'Books')) {
      str = (yield* fs.readFile(getConfigFilename(book), 'Books', 'text')) as string;
    }
    return deserializeConfig(str, globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG);
  }).pipe(
    // Faithful to legacy try/catch -> default: any failure yields the default config.
    Effect.catchAll(() =>
      Effect.sync(() => deserializeConfig('{}', globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG)),
    ),
  );
};

export const saveBookConfig = (
  book: Book,
  config: BookConfig,
  settings?: SystemSettings,
): Effect.Effect<void, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    let serializedConfig: string;
    if (settings) {
      const globalViewSettings = {
        ...settings.globalViewSettings,
        ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
      };
      serializedConfig = serializeConfig(config, globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG);
    } else {
      serializedConfig = JSON.stringify(config);
    }
    yield* fs.writeFile(getConfigFilename(book), 'Books', serializedConfig);
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'saveConfig', bookId: book.hash, cause }),
    ),
  );

export const loadBookNav = (book: Book): Effect.Effect<BookNav | null, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = getBookNavFilename(book);
    if (!(yield* fs.exists(path, 'Books'))) return null;
    const str = (yield* fs.readFile(path, 'Books', 'text')) as string;
    const parsed = JSON.parse(str) as BookNav;
    if (!parsed || typeof parsed.version !== 'number') return null;
    return parsed;
  }).pipe(
    // Faithful to legacy try/catch -> null.
    Effect.catchAll(() => Effect.succeed(null)),
  );

export const saveBookNav = (book: Book, nav: BookNav): Effect.Effect<void, BookError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.writeFile(getBookNavFilename(book), 'Books', JSON.stringify(nav));
  }).pipe(
    Effect.mapError((cause) => new BookError({ operation: 'saveNav', bookId: book.hash, cause })),
  );

export const refreshBookMetadata = (book: Book): Effect.Effect<boolean, BookError, FileSystem> =>
  Effect.gen(function* () {
    const { file } = yield* openBookFile(book);
    const { book: bookDoc } = yield* Effect.tryPromise(() => new DocumentLoader(file).open());
    if (!bookDoc) return false;

    book.metadata = bookDoc.metadata;
    book.metaHash = getMetadataHash(bookDoc.metadata);
    const primaryLanguage = getPrimaryLanguage(bookDoc.metadata.language);
    if (primaryLanguage) {
      book.primaryLanguage = primaryLanguage;
    }
    if (book.metadata?.belongsTo?.series) {
      const belongsTo = book.metadata.belongsTo.series;
      const series = Array.isArray(belongsTo) ? belongsTo[0] : belongsTo;
      if (series) {
        book.metadata.series = formatTitle(series.name);
        book.metadata.seriesIndex = parseFloat(series.position || '0');
      }
    }
    return true;
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'refreshMetadata', bookId: book.hash, cause }),
    ),
  );
