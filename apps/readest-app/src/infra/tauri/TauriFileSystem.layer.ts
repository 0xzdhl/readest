import { Effect, Layer } from 'effect';
import {
  type DirEntry,
  type WriteFileOptions,
  copyFile,
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  stat,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { basename, join } from '@tauri-apps/api/path';
import { type as osType } from '@tauri-apps/plugin-os';
import type { BaseDir, FileInfo, FileItem } from '@/domain/system';
import { FsError } from '@/application/errors/AppError';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { isContentURI, isFileURI, isValidURL } from '@/utils/misc';
import { getDirPath, getFilename } from '@/utils/path';
import { NativeFile, RemoteFile } from '@/utils/file';
import { copyURIToPath } from '@/utils/bridge';

// Mirrors nativeAppService.ts safeDecodePath (67-73).
const safeDecodePath = (input: string): string => {
  try {
    return decodeURI(input);
  } catch {
    return input;
  }
};

/**
 * Faithful port of `nativeFileSystem` (src/services/nativeAppService.ts:197-419)
 * into the `FileSystemShape` port. Path logic comes from the injected `PathResolver`
 * (replacing `this.resolvePath`) and the per-OS `openFile` branch reads `Platform`.
 * Every `@tauri-apps/plugin-fs` / `@tauri-apps/api` call is wrapped in
 * `Effect.tryPromise` mapping throws to `FsError`. Edge-cases (`content://`,
 * iOS file URI decode, Android external storage, RemoteFile-vs-NativeFile fallback,
 * Rust `read_dir`) are ported verbatim — they are exercised by `.tauri.test.ts`
 * follow-ups, not jsdom.
 */
export const TauriFileSystemLive = Layer.effect(
  FileSystem,
  Effect.gen(function* () {
    const resolver = yield* PathResolver;
    // OS_TYPE calls a Tauri API; compute it when the layer builds (Tauri-only),
    // not at import time, so web/test contexts can import this module safely.
    const OS_TYPE = osType();

    // getURL (nativeAppService.ts:206-208) — pure, used by openFile + getBlobUrl.
    const getUrlSync = (path: string): string => (isValidURL(path) ? path : convertFileSrc(path));

    const getUrl = (path: string) =>
      Effect.try({
        try: () => getUrlSync(path),
        catch: (cause) => new FsError({ operation: 'getUrl', path, cause }),
      });

    // exists (404-413) — no error channel; catch → false.
    const existsFs = (path: string, base: BaseDir) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp, baseDir }) =>
          Effect.tryPromise({
            try: () => exists(fp, baseDir ? { baseDir } : undefined),
            catch: (cause) => new FsError({ operation: 'exists', path, cause }),
          }),
        ),
        Effect.orElseSucceed(() => false),
      );

    // createDir (326-330).
    const createDir = (path: string, base: BaseDir, recursive = false) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp, baseDir }) =>
          Effect.tryPromise({
            try: () => mkdir(fp, { baseDir: baseDir ? baseDir : undefined, recursive }),
            catch: (cause) => new FsError({ operation: 'createDir', path, cause }),
          }),
        ),
        Effect.asVoid,
      );

    // removeDir (331-335).
    const removeDir = (path: string, base: BaseDir, recursive = false) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp, baseDir }) =>
          Effect.tryPromise({
            try: () => remove(fp, { baseDir: baseDir ? baseDir : undefined, recursive }),
            catch: (cause) => new FsError({ operation: 'removeDir', path, cause }),
          }),
        ),
        Effect.asVoid,
      );

    // removeFile (321-325).
    const removeFile = (path: string, base: BaseDir) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp, baseDir }) =>
          Effect.tryPromise({
            try: () => remove(fp, baseDir ? { baseDir } : undefined),
            catch: (cause) => new FsError({ operation: 'removeFile', path, cause }),
          }),
        ),
        Effect.asVoid,
      );

    // readFile (293-299).
    const readFileFs = (path: string, base: BaseDir, mode: 'text' | 'binary') =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp, baseDir }) =>
          Effect.tryPromise({
            try: async (): Promise<string | ArrayBuffer> =>
              mode === 'text'
                ? ((await readTextFile(fp, baseDir ? { baseDir } : undefined)) as string)
                : ((await readFile(fp, baseDir ? { baseDir } : undefined)).buffer as ArrayBuffer),
            catch: (cause) => new FsError({ operation: 'readFile', path, cause }),
          }),
        ),
      );

    // stat / stats (414-418).
    const statFs = (path: string, base: BaseDir) =>
      resolver.resolve(path, base).pipe(
        Effect.flatMap(({ fp, baseDir }) =>
          Effect.tryPromise({
            try: (): Promise<FileInfo> =>
              stat(fp, baseDir ? { baseDir } : undefined) as Promise<FileInfo>,
            catch: (cause) => new FsError({ operation: 'stat', path, cause }),
          }),
        ),
      );

    // getBlobURL (209-212).
    const getBlobUrl = (path: string, base: BaseDir) =>
      readFileFs(path, base, 'binary').pipe(
        Effect.flatMap((content) =>
          Effect.try({
            try: () => URL.createObjectURL(new Blob([content as ArrayBuffer])),
            catch: (cause) => new FsError({ operation: 'getBlobUrl', path, cause }),
          }),
        ),
      );

    // getPrefix (200-205) — used by openFile + copyFile edge-cases.
    const getPrefix = (base: BaseDir) => resolver.prefix(base);

    // writeFile (300-320) — create parent dir first, then string / File / ArrayBuffer.
    const writeFileFs = (path: string, base: BaseDir, content: string | ArrayBuffer | File) =>
      Effect.gen(function* () {
        const { fp, baseDir } = yield* resolver.resolve(path, base);
        const dirExists = yield* existsFs(getDirPath(path), base);
        if (!dirExists) {
          yield* createDir(getDirPath(path), base, true);
        }
        yield* Effect.tryPromise({
          try: async () => {
            if (typeof content === 'string') {
              await writeTextFile(fp, content, baseDir ? { baseDir } : undefined);
            } else if (content instanceof File) {
              const writeOptions = {
                write: true,
                create: true,
                baseDir: baseDir ? baseDir : undefined,
              } as WriteFileOptions;
              await writeFile(fp, content.stream(), writeOptions);
            } else {
              await writeFile(fp, new Uint8Array(content), baseDir ? { baseDir } : undefined);
            }
          },
          catch: (cause) => new FsError({ operation: 'writeFile', path, cause }),
        });
      });

    // copyFile (263-292) — content:// via copyURIToPath; else plugin-fs copyFile.
    const copyFileFs = (srcPath: string, srcBase: BaseDir, dstPath: string, dstBase: BaseDir) =>
      Effect.gen(function* () {
        // Best-effort parent-dir creation (legacy swallows errors here).
        const dstDirExists = yield* existsFs(getDirPath(dstPath), dstBase).pipe(
          Effect.orElseSucceed(() => false),
        );
        if (!dstDirExists) {
          yield* createDir(getDirPath(dstPath), dstBase, true).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => console.log('Failed to create directory for copying file:', error)),
            ),
          );
        }

        if (isContentURI(srcPath)) {
          const prefix = yield* getPrefix(dstBase);
          if (!prefix) {
            return yield* Effect.fail(
              new FsError({
                operation: 'copyFile',
                path: dstPath,
                cause: new Error('Invalid base directory'),
              }),
            );
          }
          yield* Effect.tryPromise({
            try: async () => {
              const res = await copyURIToPath({
                uri: srcPath,
                dst: await join(prefix, dstPath),
              });
              if (!res.success) {
                console.error('Failed to copy file:', res);
                throw new Error('Failed to copy file');
              }
            },
            catch: (cause) => new FsError({ operation: 'copyFile', path: srcPath, cause }),
          });
          return;
        }

        const src = yield* resolver.resolve(srcPath, srcBase);
        const dst = yield* resolver.resolve(dstPath, dstBase);
        const opts: { fromPathBaseDir?: number; toPathBaseDir?: number } = {};
        if (src.baseDir) opts.fromPathBaseDir = src.baseDir;
        if (dst.baseDir) opts.toPathBaseDir = dst.baseDir;
        yield* Effect.tryPromise({
          try: () => copyFile(src.fp, dst.fp, Object.keys(opts).length > 0 ? opts : undefined),
          catch: (cause) => new FsError({ operation: 'copyFile', path: srcPath, cause }),
        });
      });

    // openFile (216-262) — URL→RemoteFile; content://→copy-to-cache; file:// iOS decode;
    // Android external storage; per-OS RemoteFile-vs-NativeFile fallback.
    const openFile = (path: string, base: BaseDir, name?: string) =>
      Effect.gen(function* () {
        const normalizedPath = OS_TYPE === 'ios' ? safeDecodePath(path) : path;
        const { fp, baseDir } = yield* resolver.resolve(normalizedPath, base);

        if (isValidURL(path)) {
          return yield* Effect.tryPromise({
            try: () => {
              const fname = safeDecodePath(name || getFilename(fp));
              return new RemoteFile(path, fname).open();
            },
            catch: (cause) => new FsError({ operation: 'openFile', path, cause }),
          });
        }

        if (isContentURI(path) || (isFileURI(path) && OS_TYPE === 'ios')) {
          if (path.includes('com.android.externalstorage')) {
            // Shared internal storage (e.g. /storage/emulated/0) — direct access, no copy.
            return yield* Effect.tryPromise({
              try: async () => {
                const fname = safeDecodePath(await basename(path));
                return new NativeFile(fp, fname, baseDir ? baseDir : null).open();
              },
              catch: (cause) => new FsError({ operation: 'openFile', path, cause }),
            });
          }
          // content:// (MediaStore/Drive/3rd-party) or iOS security-scoped file:// —
          // copy to a temporary cache location then open.
          const cachePrefix = yield* getPrefix('Cache');
          return yield* Effect.tryPromise({
            try: async () => {
              const fname = safeDecodePath(await basename(path));
              const dst = await join(cachePrefix, decodeURIComponent(fname));
              const res = await copyURIToPath({ uri: path, dst });
              if (!res.success) {
                console.error('Failed to open file:', res);
                throw new Error('Failed to open file');
              }
              return new NativeFile(dst, fname, baseDir ? baseDir : null).open();
            },
            catch: (cause) => new FsError({ operation: 'openFile', path, cause }),
          });
        }

        if (isFileURI(path)) {
          return yield* Effect.tryPromise({
            try: () => {
              const fname = safeDecodePath(name || getFilename(fp));
              return new NativeFile(fp, fname, baseDir ? baseDir : null).open();
            },
            catch: (cause) => new FsError({ operation: 'openFile', path, cause }),
          });
        }

        if (OS_TYPE === 'android' || OS_TYPE === 'ios') {
          // RemoteFile is unusable on Android (WebView range-request bug) and unreliable for
          // iOS picker Inbox files — use NativeFile.
          return yield* Effect.tryPromise({
            try: () => {
              const fname = safeDecodePath(name || getFilename(fp));
              return new NativeFile(fp, fname, baseDir ? baseDir : null).open();
            },
            catch: (cause) => new FsError({ operation: 'openFile', path, cause }),
          });
        }

        // Desktop: prefer RemoteFile (~2× faster than NativeFile, tauri-apps/tauri#9190),
        // fall back to NativeFile on error.
        const prefix = yield* getPrefix(base);
        return yield* Effect.tryPromise({
          try: async () => {
            const fname = safeDecodePath(name || getFilename(fp));
            const absolutePath = prefix ? await join(prefix, path) : path;
            return new RemoteFile(getUrlSync(absolutePath), fname).open();
          },
          catch: (cause) => new FsError({ operation: 'openFile', path, cause }),
        }).pipe(
          Effect.catchAll(() =>
            Effect.tryPromise({
              try: () => {
                const fname = safeDecodePath(name || getFilename(fp));
                return new NativeFile(fp, fname, baseDir ? baseDir : null).open();
              },
              catch: (cause) => new FsError({ operation: 'openFile', path, cause }),
            }),
          ),
        );
      });

    // readDir (336-403) — absolute path (baseDir===0) → Rust read_dir; else recursive JS walk.
    const readDirFs = (path: string, base: BaseDir) =>
      Effect.gen(function* () {
        const { fp, baseDir } = yield* resolver.resolve(path, base);

        const getRelativePath = (filePath: string, basePath: string): string => {
          let relativePath = filePath;
          if (filePath.toLowerCase().startsWith(basePath.toLowerCase())) {
            relativePath = filePath.substring(basePath.length);
          }
          if (relativePath.startsWith('\\') || relativePath.startsWith('/')) {
            relativePath = relativePath.substring(1);
          }
          return relativePath;
        };

        // Rust WalkDir for absolute paths (massive perf gain); fall back to JS on error.
        if (!baseDir || baseDir === 0) {
          const rust = yield* Effect.tryPromise({
            try: () =>
              invoke<{ path: string; size: number }[]>('read_dir', {
                path: fp,
                recursive: true,
                extensions: ['*'],
              }),
            catch: (cause) => new FsError({ operation: 'readDir', path, cause }),
          }).pipe(
            Effect.map((files) =>
              files.map((file) => ({
                path: getRelativePath(file.path, fp),
                size: file.size,
              })),
            ),
            Effect.catchAll((e) =>
              Effect.sync(() => {
                console.error('Rust read_dir failed, falling back to JS recursion', e);
                return null;
              }),
            ),
          );
          if (rust) return rust;
        }

        return yield* Effect.tryPromise({
          try: async () => {
            const entries = await readDir(fp, baseDir ? { baseDir } : undefined);
            const fileList: FileItem[] = [];
            const readDirRecursively = async (
              parent: string,
              relative: string,
              entries: DirEntry[],
              fileList: FileItem[],
            ) => {
              for (const entry of entries) {
                if (entry.isDirectory) {
                  const dir = await join(parent, entry.name);
                  const relativeDir = relative ? await join(relative, entry.name) : entry.name;
                  try {
                    const childEntries = await readDir(dir, baseDir ? { baseDir } : undefined);
                    await readDirRecursively(dir, relativeDir, childEntries, fileList);
                  } catch {
                    console.warn(`Skipping unreadable dir: ${dir}`);
                  }
                } else {
                  const relativePath = relative ? await join(relative, entry.name) : entry.name;
                  const filePath = await join(parent, entry.name);
                  const opts = baseDir ? { baseDir } : undefined;
                  const fileSize = await stat(filePath, opts)
                    .then((info) => info.size)
                    .catch(() => 0);
                  fileList.push({ path: relativePath, size: fileSize });
                }
              }
            };
            await readDirRecursively(fp, '', entries, fileList);
            return fileList;
          },
          catch: (cause) => new FsError({ operation: 'readDir', path, cause }),
        });
      });

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
