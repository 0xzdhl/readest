import { Context, type Effect } from 'effect';
import type { BaseDir, FileInfo, FileItem } from '@/domain/system';
import type { FsError } from '@/application/errors/AppError';

export interface FileSystemShape {
  readonly openFile: (
    path: string,
    base: BaseDir,
    filename?: string,
  ) => Effect.Effect<File, FsError>;
  readonly readFile: (
    path: string,
    base: BaseDir,
    mode: 'text' | 'binary',
  ) => Effect.Effect<string | ArrayBuffer, FsError>;
  readonly writeFile: (
    path: string,
    base: BaseDir,
    content: string | ArrayBuffer | File,
  ) => Effect.Effect<void, FsError>;
  readonly copyFile: (
    srcPath: string,
    srcBase: BaseDir,
    dstPath: string,
    dstBase: BaseDir,
  ) => Effect.Effect<void, FsError>;
  readonly removeFile: (path: string, base: BaseDir) => Effect.Effect<void, FsError>;
  readonly createDir: (
    path: string,
    base: BaseDir,
    recursive?: boolean,
  ) => Effect.Effect<void, FsError>;
  readonly removeDir: (
    path: string,
    base: BaseDir,
    recursive?: boolean,
  ) => Effect.Effect<void, FsError>;
  readonly readDir: (path: string, base: BaseDir) => Effect.Effect<FileItem[], FsError>;
  readonly exists: (path: string, base: BaseDir) => Effect.Effect<boolean>;
  readonly stat: (path: string, base: BaseDir) => Effect.Effect<FileInfo, FsError>;
  readonly getUrl: (path: string) => Effect.Effect<string, FsError>;
  readonly getBlobUrl: (path: string, base: BaseDir) => Effect.Effect<string, FsError>;
}

export class FileSystem extends Context.Tag('app/FileSystem')<FileSystem, FileSystemShape>() {}
