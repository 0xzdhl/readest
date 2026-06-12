import { Effect } from 'effect';
import type { Book } from '@/domain/book';
import type { AppPlatform } from '@/domain/system';
import { BookError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { Platform } from '@/application/ports/Platform';
import { getCoverFilename } from '@/utils/book';
import { md5 } from '@/utils/md5';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export const getCoverImageBlobUrl = (
  book: Book,
): Effect.Effect<string, BookError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const localBooksDir = yield* resolver.prefix('Books');
    return yield* fs.getBlobUrl(`${localBooksDir}/${getCoverFilename(book)}`, 'None');
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'getCoverImageBlobUrl', bookId: book.hash, cause }),
    ),
  );

export const getCachedImageUrl = (
  pathOrUrl: string,
): Effect.Effect<string, BookError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const cachedKey = `img_${md5(pathOrUrl)}`;
    const cachePrefix = yield* resolver.prefix('Cache');
    const cachedPath = `${cachePrefix}/${cachedKey}`;
    if (yield* fs.exists(cachedPath, 'None')) {
      return yield* fs.getUrl(cachedPath);
    }
    const file = yield* fs.openFile(pathOrUrl, 'None');
    const buf = yield* Effect.tryPromise(() => file.arrayBuffer());
    yield* fs.writeFile(cachedKey, 'Cache', buf);
    return yield* fs.getUrl(cachedPath);
  }).pipe(Effect.mapError((cause) => new BookError({ operation: 'getCachedImageUrl', cause })));

// Inlines both branches (legacy generateCoverImageUrl delegated to the same two
// getBlobUrl/getUrl lines), so the whole effect maps once to 'generateCoverImageUrl'.
export const generateCoverImageUrl = (
  book: Book,
): Effect.Effect<string, BookError, FileSystem | PathResolver | Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const resolver = yield* PathResolver;
    const platform = yield* Platform;
    const info = yield* platform.info;
    const localBooksDir = yield* resolver.prefix('Books');
    const path = `${localBooksDir}/${getCoverFilename(book)}`;
    return info.appPlatform === 'web' ? yield* fs.getBlobUrl(path, 'None') : yield* fs.getUrl(path);
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'generateCoverImageUrl', bookId: book.hash, cause }),
    ),
  );

// Effect-native port of legacy imageToArrayBuffer (bookService.ts:90-120).
const imageToArrayBuffer = (
  appPlatform: AppPlatform,
  imageUrl?: string,
  imageFile?: string,
): Effect.Effect<ArrayBuffer, unknown, FileSystem> =>
  Effect.gen(function* () {
    if (!imageUrl && !imageFile) {
      return yield* Effect.fail(new Error('No image URL or file provided'));
    }
    if (appPlatform === 'web' && imageUrl && imageUrl.startsWith('blob:')) {
      return yield* Effect.tryPromise(() => fetch(imageUrl).then((r) => r.arrayBuffer()));
    }
    if (appPlatform === 'tauri' && imageFile) {
      const fs = yield* FileSystem;
      const file = yield* fs.openFile(imageFile, 'None');
      return yield* Effect.tryPromise(() => file.arrayBuffer());
    }
    if (appPlatform === 'tauri' && imageUrl) {
      return yield* Effect.tryPromise(() =>
        tauriFetch(imageUrl, { method: 'GET' }).then((r) => r.arrayBuffer()),
      );
    }
    return yield* Effect.fail(new Error('Unsupported platform or missing image data'));
  });

export const updateCoverImage = (
  book: Book,
  imageUrl?: string,
  imageFile?: string,
): Effect.Effect<void, BookError, FileSystem | Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (imageUrl === '_blank') {
      yield* fs.removeFile(getCoverFilename(book), 'Books');
    } else if (imageUrl || imageFile) {
      const platform = yield* Platform;
      const info = yield* platform.info;
      const arrayBuffer = yield* imageToArrayBuffer(info.appPlatform, imageUrl, imageFile);
      yield* fs.writeFile(getCoverFilename(book), 'Books', arrayBuffer);
    }
  }).pipe(
    Effect.mapError(
      (cause) => new BookError({ operation: 'updateCoverImage', bookId: book.hash, cause }),
    ),
  );
