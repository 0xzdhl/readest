import { Effect, Layer } from 'effect';
import type { BaseDir, FileInfo, FileItem } from '@/domain/system';
import { FsError } from '@/application/errors/AppError';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';

const key = (base: BaseDir, path: string) => `${base}::${path}`;

const byteLength = (v: string | ArrayBuffer): number =>
  typeof v === 'string' ? new TextEncoder().encode(v).byteLength : v.byteLength;

export const TestFileSystemLive = Layer.effect(
  FileSystem,
  Effect.sync(() => {
    const store = new Map<string, string | ArrayBuffer>();

    const shape: FileSystemShape = {
      writeFile: (path, base, content) =>
        Effect.sync(() => {
          if (content instanceof File) {
            // Tests use string/ArrayBuffer; File is not exercised by the in-memory double.
            throw new FsError({
              operation: 'writeFile',
              path,
              cause: 'File not supported in TestFileSystem',
            });
          }
          store.set(key(base, path), content);
        }).pipe(
          Effect.catchAllDefect((cause) =>
            Effect.fail(new FsError({ operation: 'writeFile', path, cause })),
          ),
        ),
      readFile: (path, base) =>
        Effect.suspend(() => {
          const v = store.get(key(base, path));
          return v === undefined
            ? Effect.fail(new FsError({ operation: 'readFile', path, cause: 'ENOENT' }))
            : Effect.succeed(v);
        }),
      copyFile: (srcPath, srcBase, dstPath, dstBase) =>
        Effect.suspend(() => {
          const v = store.get(key(srcBase, srcPath));
          if (v === undefined)
            return Effect.fail(
              new FsError({ operation: 'copyFile', path: srcPath, cause: 'ENOENT' }),
            );
          store.set(key(dstBase, dstPath), v);
          return Effect.void;
        }),
      removeFile: (path, base) =>
        Effect.sync(() => {
          store.delete(key(base, path));
        }),
      createDir: () => Effect.void,
      removeDir: (path, base) =>
        Effect.sync(() => {
          const prefix = key(base, path);
          for (const k of store.keys())
            if (k === prefix || k.startsWith(`${prefix}/`)) store.delete(k);
        }),
      readDir: (path, base) =>
        Effect.sync<FileItem[]>(() => {
          const prefix = key(base, path);
          const items: FileItem[] = [];
          for (const [k, v] of store) {
            if (k.startsWith(`${prefix}/`)) {
              items.push({ path: k.slice(`${base}::`.length), size: byteLength(v) });
            }
          }
          return items;
        }),
      exists: (path, base) => Effect.sync(() => store.has(key(base, path))),
      stat: (path, base) =>
        Effect.suspend(() => {
          const v = store.get(key(base, path));
          return v === undefined
            ? Effect.fail(new FsError({ operation: 'stat', path, cause: 'ENOENT' }))
            : Effect.succeed<FileInfo>({
                isFile: true,
                isDirectory: false,
                size: byteLength(v),
                mtime: null,
                atime: null,
                birthtime: null,
              });
        }),
      openFile: (path) =>
        Effect.fail(
          new FsError({ operation: 'openFile', path, cause: 'not supported in TestFileSystem' }),
        ),
      getUrl: (path) => Effect.succeed(`mem://${path}`),
      getBlobUrl: (path, base) =>
        Effect.suspend(() =>
          store.has(key(base, path))
            ? Effect.succeed(`blob://${base}/${path}`)
            : Effect.fail(new FsError({ operation: 'getBlobUrl', path, cause: 'ENOENT' })),
        ),
    };

    return shape;
  }),
);
