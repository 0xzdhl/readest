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

/**
 * Minimal write-only fs contract for libs/storage.downloadFile (which reaches
 * only writeFile). The legacy FileSystem god-object interface is gone (E6e);
 * this is the narrow write contract its download consumers actually need.
 */
export type FileWriter = {
  writeFile(path: string, base: BaseDir, content: string | ArrayBuffer | File): Promise<void>;
};
