import { Effect } from 'effect';
import {
  type Book,
  type BookConfig,
  type BookFormat,
  type BookLookupIndex,
  type BookNote,
  type ImportBookOptions,
} from '@/domain/book';
import type { BookDoc } from '@/domain/document';
import { BookError, type FsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { CoverService } from '@/application/services/CoverService';
import { BookRepository } from '@/application/repositories/BookRepository';
import {
  getDir,
  getLocalBookFilename,
  getCoverFilename,
  INIT_BOOK_CONFIG,
  formatTitle,
  formatAuthors,
  getPrimaryLanguage,
  getMetadataHash,
} from '@/utils/book';
import { getConfigStoragePath } from '@/utils/userPaths';
import { partialMd5, md5 } from '@/utils/md5';
import { getBaseFilename, getFilename } from '@/utils/path';
import { DocumentLoader } from '@/libs/document';
import {
  isPseStreamFileName,
  openPseStreamBook,
  parsePseStreamFileName,
} from '@/services/opds/pseStream';
import { isContentURI, isValidURL } from '@/utils/misc';
import type { ClosableFile } from '@/utils/file';
import { TxtToEpubConverter } from '@/utils/txt';
import { svg2png } from '@/utils/svg';
import { normalizeMetadataIsbn } from '@/utils/isbn';

export function buildBookLookupIndex(books: Book[]): BookLookupIndex {
  const byHash = new Map<string, Book>();
  const byMetaKey = new Map<string, Book[]>();
  for (const book of books) {
    byHash.set(book.hash, book);
    if (book.metaHash && !book.deletedAt) {
      const key = `${book.metaHash}:${book.format}`;
      const list = byMetaKey.get(key);
      if (list) list.push(book);
      else byMetaKey.set(key, [book]);
    }
  }
  return { byHash, byMetaKey };
}

// Internal: merge duplicate entries sharing metaHash+format; returns the merged
// config JSON (or undefined). Per-config read/parse is best-effort (corrupt
// configs ignored), faithful to legacy try/catch.
const mergeBooks = (
  books: Book[],
  book: Book,
  lookupIndex?: BookLookupIndex,
): Effect.Effect<string | undefined, FsError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (!book.metaHash) return undefined;

    const metaKey = `${book.metaHash}:${book.format}`;
    const duplicates = lookupIndex
      ? (lookupIndex.byMetaKey.get(metaKey) ?? []).filter((b) => !b.deletedAt && b !== book)
      : books.filter(
          (b) =>
            b.metaHash === book.metaHash && b.format === book.format && !b.deletedAt && b !== book,
        );
    if (duplicates.length === 0) return undefined;

    const allCandidates = [book, ...duplicates];
    const configs: Partial<BookConfig>[] = [];
    for (const candidate of allCandidates) {
      const configPath = getConfigStoragePath(candidate);
      if (yield* fs.exists(configPath, 'Books')) {
        const parsed = yield* fs.readFile(configPath, 'Books', 'text').pipe(
          Effect.flatMap((str) =>
            Effect.try(() => JSON.parse(str as string) as Partial<BookConfig>),
          ),
          Effect.catchAll(() => Effect.succeed(undefined)),
        );
        if (parsed !== undefined) configs.push(parsed);
      }
    }

    let mergedConfigData: string | undefined;
    if (configs.length > 0) {
      const base = configs.reduce((best, cfg) => {
        const bestPage = best.progress?.[0] ?? 0;
        const cfgPage = cfg.progress?.[0] ?? 0;
        return cfgPage > bestPage ? cfg : best;
      });
      const noteMap = new Map<string, BookNote>();
      for (const cfg of configs) {
        for (const note of cfg.booknotes ?? []) {
          const existing = noteMap.get(note.id);
          if (!existing || (note.updatedAt || 0) > (existing.updatedAt || 0)) {
            noteMap.set(note.id, note);
          }
        }
      }
      base.booknotes = [...noteMap.values()];
      mergedConfigData = JSON.stringify(base);
    }

    for (const dup of duplicates) {
      dup.deletedAt = Date.now();
      const dupDir = getDir(dup);
      if (yield* fs.exists(dupDir, 'Books')) {
        yield* fs.removeDir(dupDir, 'Books', true);
      }
    }
    return mergedConfigData;
  });

export const importBook = (
  file: string | File,
  books: Book[],
  options: ImportBookOptions & { lookupIndex?: BookLookupIndex } = {},
): Effect.Effect<Book | null, BookError, FileSystem | CoverService | BookRepository> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const coverSvc = yield* CoverService;
    const bookRepo = yield* BookRepository;
    const {
      saveBook = true,
      saveCover = true,
      overwrite = false,
      transient = false,
      lookupIndex,
    } = options;
    const isPseStream = typeof file === 'string' && isPseStreamFileName(file);

    if (transient && typeof file !== 'string') {
      return yield* Effect.fail(new Error('Transient import is only supported for file paths'));
    }

    // --- open (errors wrapped as "Failed to open the book file: <msg>") ---
    const opened = yield* Effect.gen(function* () {
      let loadedBook: BookDoc;
      let format: BookFormat;
      let filename: string;
      let fileobj: File | undefined;
      if (isPseStream) {
        const r = yield* Effect.tryPromise(() =>
          openPseStreamBook(parsePseStreamFileName(file as string)),
        );
        loadedBook = r.book;
        format = r.format;
        filename = file as string;
      } else {
        if (typeof file === 'string') {
          fileobj = yield* fs.openFile(file, 'None');
          filename = fileobj.name || getFilename(file);
        } else {
          fileobj = file;
          filename = file.name;
        }
        if (/\.txt$/i.test(filename)) {
          const conv = yield* Effect.tryPromise(() =>
            new TxtToEpubConverter().convert({ file: fileobj! }),
          );
          fileobj = conv.file;
        }
        if (!fileobj || fileobj.size === 0) {
          return yield* Effect.fail(new Error('Invalid or empty book file'));
        }
        const r = yield* Effect.tryPromise(() => new DocumentLoader(fileobj!).open());
        loadedBook = r.book;
        format = r.format;
      }
      if (!loadedBook) {
        return yield* Effect.fail(new Error('Unsupported or corrupted book file'));
      }
      normalizeMetadataIsbn(loadedBook.metadata);
      const metadataTitle = formatTitle(loadedBook.metadata.title);
      if (!metadataTitle || !metadataTitle.trim() || metadataTitle === filename) {
        loadedBook.metadata.title = getBaseFilename(filename);
      }
      return { loadedBook, format, filename, fileobj };
    }).pipe(
      Effect.mapError(
        (error) => new Error(`Failed to open the book file: ${(error as Error).message || error}`),
      ),
    );

    const { loadedBook, format, filename, fileobj } = opened;

    const hash = isPseStream
      ? md5(file as string)
      : yield* Effect.tryPromise(() => partialMd5(fileobj!));

    const metaHash = getMetadataHash(loadedBook.metadata);
    let existingBook = lookupIndex
      ? lookupIndex.byHash.get(hash)
      : books.find((b) => b.hash === hash);
    let metaHashMatch = false;
    let oldBookDir: string | undefined;
    if (existingBook) {
      if (!transient) existingBook.deletedAt = null;
      existingBook.createdAt = Date.now();
      existingBook.updatedAt = Date.now();
    }

    let bestConfigData: string | undefined;
    if (!transient && metaHash) {
      if (!existingBook) {
        const metaKey = `${metaHash}:${format}`;
        const firstMatch = lookupIndex
          ? (lookupIndex.byMetaKey.get(metaKey) ?? []).find((b) => !b.deletedAt)
          : books.find((b) => b.metaHash === metaHash && b.format === format && !b.deletedAt);
        if (firstMatch) {
          oldBookDir = getDir(firstMatch);
          existingBook = firstMatch;
          metaHashMatch = true;
          existingBook.createdAt = Date.now();
          existingBook.updatedAt = Date.now();
        }
      }
      if (existingBook) {
        bestConfigData = yield* mergeBooks(books, existingBook, lookupIndex);
      }
    }

    const primaryLanguage = getPrimaryLanguage(loadedBook.metadata.language);
    const book: Book = {
      hash,
      format,
      metaHash,
      title: formatTitle(loadedBook.metadata.title),
      sourceTitle: formatTitle(loadedBook.metadata.title),
      primaryLanguage,
      author: formatAuthors(loadedBook.metadata.author, primaryLanguage),
      metadata: loadedBook.metadata,
      createdAt: existingBook ? existingBook.createdAt : Date.now(),
      uploadedAt: existingBook ? existingBook.uploadedAt : null,
      deletedAt: transient ? Date.now() : null,
      downloadedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (book.metadata?.belongsTo?.series) {
      const belongsTo = book.metadata.belongsTo.series;
      const series = Array.isArray(belongsTo) ? belongsTo[0] : belongsTo;
      if (series) {
        book.metadata.series = formatTitle(series.name);
        book.metadata.seriesIndex = parseFloat(series.position || '0');
      }
    }
    if (existingBook && metaHashMatch) {
      existingBook.hash = hash;
      existingBook.format = book.format;
      existingBook.metaHash = metaHash;
      existingBook.title = book.title;
      existingBook.sourceTitle = book.sourceTitle;
      existingBook.author = book.author;
      existingBook.primaryLanguage = book.primaryLanguage;
      existingBook.metadata = book.metadata;
      existingBook.uploadedAt = null;
      existingBook.downloadedAt = Date.now();
    } else if (existingBook) {
      existingBook.format = book.format;
      existingBook.metaHash = metaHash;
      existingBook.title = existingBook.title.trim() ? existingBook.title.trim() : book.title;
      existingBook.sourceTitle = existingBook.sourceTitle ?? book.sourceTitle;
      existingBook.author = existingBook.author ?? book.author;
      existingBook.primaryLanguage = existingBook.primaryLanguage ?? book.primaryLanguage;
      existingBook.metadata = book.metadata;
      existingBook.downloadedAt = Date.now();
    }

    if (!(yield* fs.exists(getDir(book), 'Books'))) {
      yield* fs.createDir(getDir(book), 'Books');
    }
    const bookFilename = getLocalBookFilename(book);
    if (
      saveBook &&
      !transient &&
      fileobj &&
      (!(yield* fs.exists(bookFilename, 'Books')) || overwrite)
    ) {
      if (/\.txt$/i.test(filename)) {
        yield* fs.writeFile(bookFilename, 'Books', fileobj);
      } else if (typeof file === 'string' && isContentURI(file)) {
        yield* fs.copyFile(file, 'None', bookFilename, 'Books');
      } else if (typeof file === 'string' && !isValidURL(file)) {
        // Try a direct copy first (large files); fall back to read+write on failure.
        yield* fs.copyFile(file, 'None', bookFilename, 'Books').pipe(
          Effect.catchAll(() =>
            Effect.gen(function* () {
              const buf = yield* Effect.tryPromise(() => fileobj!.arrayBuffer());
              yield* fs.writeFile(bookFilename, 'Books', buf);
            }),
          ),
        );
      } else {
        yield* fs.writeFile(bookFilename, 'Books', fileobj);
      }
    }
    if (saveCover && (!(yield* fs.exists(getCoverFilename(book), 'Books')) || overwrite)) {
      let coverBlob = yield* Effect.tryPromise(() => loadedBook.getCover());
      if (coverBlob?.type === 'image/svg+xml') {
        const original = coverBlob;
        coverBlob = yield* Effect.gen(function* () {
          yield* Effect.sync(() => console.log('Converting SVG cover to PNG...'));
          return yield* Effect.tryPromise(() => svg2png(original));
        }).pipe(Effect.catchAll(() => Effect.succeed(original)));
      }
      if (coverBlob) {
        const buf = yield* Effect.tryPromise(() => coverBlob!.arrayBuffer());
        yield* fs.writeFile(getCoverFilename(book), 'Books', buf);
      }
    }
    // Config: only write INIT when the book is new; otherwise migrate/adopt config.
    if (!existingBook) {
      yield* bookRepo.saveConfig(book, INIT_BOOK_CONFIG);
      books.push(book);
      if (lookupIndex) {
        lookupIndex.byHash.set(book.hash, book);
        if (book.metaHash) {
          const key = `${book.metaHash}:${book.format}`;
          const list = lookupIndex.byMetaKey.get(key);
          if (list) list.push(book);
          else lookupIndex.byMetaKey.set(key, [book]);
        }
      }
    } else if (metaHashMatch && oldBookDir && oldBookDir !== getDir(book)) {
      if (bestConfigData) {
        const config = yield* Effect.try(() => JSON.parse(bestConfigData!) as Partial<BookConfig>);
        config.bookHash = hash;
        config.metaHash = metaHash;
        yield* fs.writeFile(getConfigStoragePath(book), 'Books', JSON.stringify(config));
      } else {
        const oldConfigPath = `${oldBookDir}/config.json`;
        if (yield* fs.exists(oldConfigPath, 'Books')) {
          const configData = (yield* fs.readFile(oldConfigPath, 'Books', 'text')) as string;
          const config = yield* Effect.try(() => JSON.parse(configData) as Partial<BookConfig>);
          config.bookHash = hash;
          config.metaHash = metaHash;
          yield* fs.writeFile(getConfigStoragePath(book), 'Books', JSON.stringify(config));
        } else {
          yield* bookRepo.saveConfig(book, INIT_BOOK_CONFIG);
        }
      }
      if (yield* fs.exists(oldBookDir, 'Books')) {
        yield* fs.removeDir(oldBookDir, 'Books', true);
      }
    } else if (bestConfigData) {
      const config = yield* Effect.try(() => JSON.parse(bestConfigData!) as Partial<BookConfig>);
      config.bookHash = hash;
      config.metaHash = metaHash;
      yield* fs.writeFile(getConfigStoragePath(book), 'Books', JSON.stringify(config));
    }

    if (isPseStream) {
      book.url = file as string;
      if (existingBook) existingBook.url = file as string;
    } else if (typeof file === 'string') {
      if (isValidURL(file)) {
        book.url = file;
        if (existingBook) existingBook.url = file;
      }
      if (transient) {
        book.filePath = file;
        if (existingBook) existingBook.filePath = file;
      }
    }
    book.coverImageUrl = yield* coverSvc.generateCoverImageUrl(book);
    const f = file as unknown as ClosableFile;
    if (f && f.close) {
      yield* Effect.tryPromise(() => f.close());
    }

    return existingBook || book;
  }).pipe(
    Effect.tapError((cause) => Effect.sync(() => console.error('Error importing book:', cause))),
    Effect.mapError((cause) => new BookError({ operation: 'importBook', cause })),
  );
