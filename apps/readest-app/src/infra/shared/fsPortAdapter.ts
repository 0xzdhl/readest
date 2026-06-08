import { Effect } from 'effect';
import type { BaseDir, FileSystem as LegacyFileSystem, ResolvedPath } from '@/domain/system';
import type { FileSystemShape } from '@/application/ports/FileSystem';
import type { PathResolverShape } from '@/application/ports/PathResolver';

/**
 * Adapts the new Effect-based FileSystem + PathResolver ports to the legacy
 * Promise-based `FileSystem` interface that settingsService/persistence/migration
 * still consume. `fsPort`/`resolver` are RESOLVED shapes (no remaining R), so
 * `Effect.runPromise` on their methods is valid. Sync legacy methods
 * (resolvePath, getURL) are never called by those consumers — they throw.
 */
export const makeLegacyFsAdapter = (
  fsPort: FileSystemShape,
  resolver: PathResolverShape,
): LegacyFileSystem => ({
  getPrefix: (base: BaseDir) => Effect.runPromise(resolver.prefix(base)),
  readFile: (path, base, mode) => Effect.runPromise(fsPort.readFile(path, base, mode)),
  writeFile: (path, base, content) => Effect.runPromise(fsPort.writeFile(path, base, content)),
  exists: (path, base) => Effect.runPromise(fsPort.exists(path, base)),
  removeFile: (path, base) => Effect.runPromise(fsPort.removeFile(path, base)),
  openFile: (path, base, filename) => Effect.runPromise(fsPort.openFile(path, base, filename)),
  copyFile: (s, sb, d, db) => Effect.runPromise(fsPort.copyFile(s, sb, d, db)),
  createDir: (path, base, recursive) => Effect.runPromise(fsPort.createDir(path, base, recursive)),
  removeDir: (path, base, recursive) => Effect.runPromise(fsPort.removeDir(path, base, recursive)),
  readDir: (path, base) => Effect.runPromise(fsPort.readDir(path, base)),
  stats: (path, base) => Effect.runPromise(fsPort.stat(path, base)),
  getBlobURL: (path, base) => Effect.runPromise(fsPort.getBlobUrl(path, base)),
  getImageURL: (path) => Effect.runPromise(fsPort.getUrl(path)),
  resolvePath: (_path: string, _base: BaseDir): ResolvedPath => {
    throw new Error(
      'resolvePath is not supported by the port adapter (unused by settings/migration)',
    );
  },
  getURL: (_path: string): string => {
    throw new Error('getURL is not supported by the port adapter (unused by settings/migration)');
  },
});
