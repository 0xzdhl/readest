import type { SystemSettings } from '@/domain/settings';
import type { Book, BookConfig, BookContent, ImportBookOptions, ViewSettings } from '@/domain/book';
import type { BookMetadata } from '@/domain/document';
import type { BookNav } from '@/domain/nav';
import type { ProgressHandler } from '@/domain/transfer';
import type { CustomFont, CustomFontInfo } from '@/domain/fonts';
import type { CustomTextureInfo } from '@/domain/textures';
import type { DatabaseOpts, DatabaseService } from '@/domain/database';
import type { SchemaType } from '@/domain/migration';
import type { ImportedDictionary } from '@/domain/dictionaries';
import type { ImportDictionariesResult } from '@/domain/dictionaries';
import type { SelectedFile } from '@/domain/file-selector';

export type AppPlatform = 'web' | 'tauri' | 'node';
export type OsPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'linux' | 'unknown';
// prettier-ignore
export type BaseDir = | 'Books' | 'Settings' | 'Data' | 'Fonts' | 'Images' | 'Dictionaries' | 'Log' | 'Cache' | 'Temp' | 'None';
export type DeleteAction = 'cloud' | 'local' | 'both';
export type SelectDirectoryMode = 'read' | 'write';
export type DistChannel = 'readest' | 'playstore' | 'appstore' | 'unknown';

export type ResolvedPath = {
  baseDir: number;
  basePrefix: () => Promise<string>;
  fp: string;
  base: BaseDir;
};

export type FileItem = {
  path: string;
  size: number;
};

export type FileInfo = {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: Date | null;
  atime: Date | null;
  birthtime: Date | null;
};

export type NativeTouchEventType = {
  type: 'touchstart' | 'touchcancel' | 'touchend';
  pointerId: number;
  x: number;
  y: number;
  pressure: number;
  pointerCount: number;
  timestamp: number;
};

export interface FileSystem {
  resolvePath(path: string, base: BaseDir): ResolvedPath;
  getURL(path: string): string;
  getBlobURL(path: string, base: BaseDir): Promise<string>;
  getImageURL(path: string): Promise<string>;
  openFile(path: string, base: BaseDir, filename?: string): Promise<File>;
  copyFile(srcPath: string, srcBase: BaseDir, dstPath: string, dstBase: BaseDir): Promise<void>;
  readFile(path: string, base: BaseDir, mode: 'text' | 'binary'): Promise<string | ArrayBuffer>;
  writeFile(path: string, base: BaseDir, content: string | ArrayBuffer | File): Promise<void>;
  removeFile(path: string, base: BaseDir): Promise<void>;
  readDir(path: string, base: BaseDir): Promise<FileItem[]>;
  createDir(path: string, base: BaseDir, recursive?: boolean): Promise<void>;
  removeDir(path: string, base: BaseDir, recursive?: boolean): Promise<void>;
  exists(path: string, base: BaseDir): Promise<boolean>;
  stats(path: string, base: BaseDir): Promise<FileInfo>;
  getPrefix(base: BaseDir): Promise<string>;
}

/**
 * Minimal write-only fs contract for libs/storage.downloadFile (which reaches
 * only writeFile). Reuses the legacy FileSystem.writeFile signature so there's
 * one source of truth. The legacy god-object interface is gone (E5b-2); this is
 * the narrow write contract its download consumers actually needed.
 */
export type FileWriter = Pick<FileSystem, 'writeFile'>;
