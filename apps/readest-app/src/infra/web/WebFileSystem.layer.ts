import { Effect, Layer } from 'effect';
import type { BaseDir, FileInfo, FileItem } from '@/domain/system';
import { FsError } from '@/application/errors/AppError';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { isValidURL } from '@/utils/misc';
import { RemoteFile } from '@/utils/file';

// NOTE: CRUD covered by Plan-B TestFileSystem contract; real IDB coverage via
// .browser.test.ts (follow-up). jsdom lacks IndexedDB so there is no unit test here;
// tsgo + the client-web runtime smoke test are the gates for this layer.

const dbName = 'AppFileSystem';
const dbVersion = 1;

// Faithful port of the legacy web openIndexedDB — same store/keyPath.
const openIndexedDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'path' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * Faithful port of the legacy web IndexedDB filesystem into
 * the `FileSystemShape` port. The flat key path (`fp`) comes from the injected
 * `PathResolver` (the Web resolver mirrors the legacy `resolvePath`). All IndexedDB
 * ops are wrapped in `Effect.tryPromise` mapping rejections to `FsError`.
 */
export const WebFileSystemLive = Layer.effect(
  FileSystem,
  Effect.gen(function* () {
    const resolver = yield* PathResolver;

    // getURL — used by openFile + getBlobUrl.
    const getUrlSync = (path: string): string =>
      isValidURL(path) ? path : URL.createObjectURL(new Blob([path]));

    const getUrl = (path: string) =>
      Effect.try({
        try: () => getUrlSync(path),
        catch: (cause) => new FsError({ operation: 'getUrl', path, cause }),
      });

    // readFile (114-146).
    const readFileFs = (path: string, base: BaseDir, mode: 'text' | 'binary') =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp }) =>
          Effect.tryPromise({
            try: async (): Promise<string | ArrayBuffer> => {
              const db = await openIndexedDB();
              return new Promise<string | ArrayBuffer>((resolve, reject) => {
                const transaction = db.transaction('files', 'readonly');
                const store = transaction.objectStore('files');
                const request = store.get(fp);

                request.onsuccess = async () => {
                  if (request.result) {
                    const content = request.result.content;
                    if (mode === 'text') {
                      resolve(content);
                    } else if (content instanceof Blob) {
                      resolve(await content.arrayBuffer());
                    } else if (content instanceof ArrayBuffer) {
                      resolve(content);
                    } else if (typeof content === 'string') {
                      resolve(new TextEncoder().encode(content).buffer as ArrayBuffer);
                    } else {
                      reject(new Error('Unsupported content type in IndexedDB'));
                    }
                  } else {
                    reject(new Error(`File not found: ${fp}`));
                  }
                };

                request.onerror = () => reject(request.error);
              });
            },
            catch: (cause) => new FsError({ operation: 'readFile', path, cause }),
          }),
        ),
      );

    // getBlobURL (72-79) — on failure falls back to the raw path.
    const getBlobUrl = (path: string, base: BaseDir) =>
      readFileFs(path, base, 'binary').pipe(
        Effect.map((content) => URL.createObjectURL(new Blob([content as ArrayBuffer]))),
        Effect.orElseSucceed(() => path),
      );

    // openFile (83-90) — URL→RemoteFile; else read binary and wrap in a File.
    const openFile = (path: string, base: BaseDir, filename?: string) =>
      isValidURL(path)
        ? Effect.tryPromise({
            try: () => new RemoteFile(path, filename).open(),
            catch: (cause) => new FsError({ operation: 'openFile', path, cause }),
          })
        : readFileFs(path, base, 'binary').pipe(
            Effect.map((content) => new File([content as ArrayBuffer], filename || path)),
          );

    // writeFile (147-163).
    const writeFileFs = (path: string, base: BaseDir, content: string | ArrayBuffer | File) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp }) =>
          Effect.tryPromise({
            try: async () => {
              const db = await openIndexedDB();
              let value = content;
              if (value instanceof File) {
                value = await value.arrayBuffer();
              }
              return new Promise<void>((resolve, reject) => {
                const transaction = db.transaction('files', 'readwrite');
                const store = transaction.objectStore('files');
                store.put({ path: fp, content: value });
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
              });
            },
            catch: (cause) => new FsError({ operation: 'writeFile', path, cause }),
          }),
        ),
      );

    // createDir (178-180) — web has no directories; writes an empty placeholder.
    const createDir = (path: string, base: BaseDir) => writeFileFs(path, base, '');

    // copyFile (91-113).
    const copyFileFs = (srcPath: string, srcBase: BaseDir, dstPath: string, dstBase: BaseDir) =>
      Effect.gen(function* () {
        const { fp: srcFp } = yield* resolver.resolve(srcPath, srcBase);
        const { fp: dstFp } = yield* resolver.resolve(dstPath, dstBase);
        yield* Effect.tryPromise({
          try: async () => {
            const db = await openIndexedDB();
            return new Promise<void>((resolve, reject) => {
              const transaction = db.transaction('files', 'readwrite');
              const store = transaction.objectStore('files');
              const getRequest = store.get(srcFp);

              getRequest.onsuccess = () => {
                const data = getRequest.result;
                if (data) {
                  store.put({ path: dstFp, content: data.content });
                  resolve();
                } else {
                  reject(new Error(`File not found: ${srcFp}`));
                }
              };

              getRequest.onerror = () => reject(getRequest.error);
            });
          },
          catch: (cause) => new FsError({ operation: 'copyFile', path: srcPath, cause }),
        });
      });

    // removeFile (164-177).
    const removeFile = (path: string, base: BaseDir) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp }) =>
          Effect.tryPromise({
            try: async () => {
              const db = await openIndexedDB();
              return new Promise<void>((resolve, reject) => {
                const transaction = db.transaction('files', 'readwrite');
                const store = transaction.objectStore('files');
                store.delete(fp);
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
              });
            },
            catch: (cause) => new FsError({ operation: 'removeFile', path, cause }),
          }),
        ),
        Effect.asVoid,
      );

    // removeDir (181-202) — delete every key under the prefix.
    const removeDir = (path: string, base: BaseDir) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp }) =>
          Effect.tryPromise({
            try: async () => {
              const db = await openIndexedDB();
              return new Promise<void>((resolve, reject) => {
                const transaction = db.transaction('files', 'readwrite');
                const store = transaction.objectStore('files');
                const request = store.getAll();

                request.onsuccess = () => {
                  const files = request.result as { path: string }[];
                  files.forEach((file) => {
                    if (file.path.startsWith(fp)) {
                      store.delete(file.path);
                    }
                  });
                };

                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
              });
            },
            catch: (cause) => new FsError({ operation: 'removeDir', path, cause }),
          }),
        ),
        Effect.asVoid,
      );

    // readDir (203-234) — list keys under the prefix, stripping it.
    const readDirFs = (path: string, base: BaseDir) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp }) =>
          Effect.tryPromise({
            try: async (): Promise<FileItem[]> => {
              const prefix = fp.endsWith('/') ? fp : `${fp}/`;
              const db = await openIndexedDB();
              return new Promise<FileItem[]>((resolve, reject) => {
                const transaction = db.transaction('files', 'readonly');
                const store = transaction.objectStore('files');
                const request = store.getAll();

                request.onsuccess = () => {
                  const files = request.result as {
                    path: string;
                    content: string | ArrayBuffer | Blob;
                  }[];
                  resolve(
                    files
                      .filter((file) => file.path.startsWith(prefix))
                      .map((file) => ({
                        path: file.path.slice(prefix.length),
                        size:
                          file.content instanceof Blob
                            ? file.content.size
                            : typeof file.content === 'string'
                              ? file.content.length
                              : file.content instanceof ArrayBuffer
                                ? file.content.byteLength
                                : 0,
                      })),
                  );
                };

                request.onerror = () => reject(request.error);
              });
            },
            catch: (cause) => new FsError({ operation: 'readDir', path, cause }),
          }),
        ),
      );

    // exists (235-247) — no error channel; map IDB rejection → false.
    const existsFs = (path: string, base: BaseDir) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp }) =>
          Effect.tryPromise({
            try: async () => {
              const db = await openIndexedDB();
              return new Promise<boolean>((resolve, reject) => {
                const transaction = db.transaction('files', 'readonly');
                const store = transaction.objectStore('files');
                const request = store.get(fp);
                request.onsuccess = () => resolve(!!request.result);
                request.onerror = () => reject(request.error);
              });
            },
            catch: (cause) => new FsError({ operation: 'exists', path, cause }),
          }),
        ),
        Effect.orElseSucceed(() => false),
      );

    // stats (248-284).
    const statFs = (path: string, base: BaseDir) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp }) =>
          Effect.tryPromise({
            try: async (): Promise<FileInfo> => {
              const db = await openIndexedDB();
              return new Promise<FileInfo>((resolve, reject) => {
                const transaction = db.transaction('files', 'readonly');
                const store = transaction.objectStore('files');
                const request = store.get(fp);

                request.onsuccess = () => {
                  const result = request.result;
                  if (result) {
                    const content = result.content;
                    const size =
                      content instanceof Blob
                        ? content.size
                        : typeof content === 'string'
                          ? content.length
                          : content instanceof ArrayBuffer
                            ? content.byteLength
                            : 0;
                    resolve({
                      isFile: true,
                      isDirectory: false,
                      size,
                      mtime: null,
                      atime: null,
                      birthtime: null,
                    });
                  } else {
                    reject(new Error(`File not found: ${fp}`));
                  }
                };

                request.onerror = () => reject(request.error);
              });
            },
            catch: (cause) => new FsError({ operation: 'stat', path, cause }),
          }),
        ),
      );

    return {
      openFile,
      readFile: readFileFs,
      writeFile: writeFileFs,
      copyFile: copyFileFs,
      removeFile,
      createDir,
      removeDir,
      readDir: readDirFs,
      exists: existsFs,
      stat: statFs,
      getUrl,
      getBlobUrl,
    } satisfies FileSystemShape;
  }),
);
