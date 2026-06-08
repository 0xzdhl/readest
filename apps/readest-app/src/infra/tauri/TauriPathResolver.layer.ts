import { Effect, Layer } from 'effect';
import { BaseDirectory } from '@tauri-apps/plugin-fs';
import {
  appCacheDir,
  appConfigDir,
  appDataDir,
  appLogDir,
  join,
  tempDir,
} from '@tauri-apps/api/path';
import type { BaseDir, ResolvedPath } from '@/domain/system';
import { FsError } from '@/application/errors/AppError';
import { PathResolver, type PathResolverShape } from '@/application/ports/PathResolver';
import { PathState, type PathConfig } from '@/application/ports/PathState';
import {
  DATA_SUBDIR,
  LOCAL_BOOKS_SUBDIR,
  LOCAL_DICTIONARIES_SUBDIR,
  LOCAL_FONTS_SUBDIR,
  LOCAL_IMAGES_SUBDIR,
} from '@/services/constants';

// Categories that nest directly under the custom root WITHOUT a leaf BaseDir-name segment.
// Ported verbatim from getPathResolver() (nativeAppService.ts) `dataDirs`.
const DATA_DIRS: BaseDir[] = ['Settings', 'Data', 'Books', 'Fonts', 'Images', 'Dictionaries'];

/**
 * Faithful port of `getPathResolver()` (src/services/nativeAppService.ts:83-195),
 * parameterised by the current `PathConfig` from `PathState`.
 *
 * Note: under a custom root, the custom prefix collapses to just the root for the
 * `dataDirs` categories (their BaseDir name is dropped), but the subdir constant
 * (e.g. LOCAL_BOOKS_SUBDIR = 'Readest/Books') is STILL appended to `fp` — exactly
 * as the legacy resolver does.
 */
const buildResolved = (path: string, base: BaseDir, cfg: PathConfig): ResolvedPath => {
  const { customRootDir, isPortable, execDir } = cfg;
  const customBaseDir = customRootDir ? 0 : undefined;
  const isCustomBaseDir = Boolean(customRootDir);

  const customBasePrefixSync = isCustomBaseDir
    ? () => {
        const leafDir = DATA_DIRS.includes(base) ? '' : base;
        return leafDir ? `${customRootDir}/${leafDir}` : customRootDir!;
      }
    : undefined;
  const customBasePrefix = customBasePrefixSync ? async () => customBasePrefixSync() : undefined;

  switch (base) {
    case 'Settings':
      return {
        baseDir: isPortable ? 0 : BaseDirectory.AppConfig,
        basePrefix: isPortable && execDir ? async () => execDir : appConfigDir,
        fp: isPortable && execDir ? `${execDir}${path ? `/${path}` : ''}` : path,
        base,
      };
    case 'Cache':
      return {
        baseDir: BaseDirectory.AppCache,
        basePrefix: appCacheDir,
        fp: path,
        base,
      };
    case 'Log':
      return {
        baseDir: isCustomBaseDir ? 0 : BaseDirectory.AppLog,
        basePrefix: customBasePrefix ?? appLogDir,
        fp: customBasePrefixSync ? `${customBasePrefixSync()}${path ? `/${path}` : ''}` : path,
        base,
      };
    case 'Data':
      return {
        baseDir: customBaseDir ?? BaseDirectory.AppData,
        basePrefix: customBasePrefix ?? appDataDir,
        fp: customBasePrefixSync
          ? `${customBasePrefixSync()}/${DATA_SUBDIR}${path ? `/${path}` : ''}`
          : `${DATA_SUBDIR}${path ? `/${path}` : ''}`,
        base,
      };
    case 'Books':
      return {
        baseDir: customBaseDir ?? BaseDirectory.AppData,
        basePrefix: customBasePrefix || appDataDir,
        fp: customBasePrefixSync
          ? `${customBasePrefixSync()}/${LOCAL_BOOKS_SUBDIR}${path ? `/${path}` : ''}`
          : `${LOCAL_BOOKS_SUBDIR}${path ? `/${path}` : ''}`,
        base,
      };
    case 'Fonts':
      return {
        baseDir: customBaseDir ?? BaseDirectory.AppData,
        basePrefix: customBasePrefix || appDataDir,
        fp: customBasePrefixSync
          ? `${customBasePrefixSync()}/${LOCAL_FONTS_SUBDIR}${path ? `/${path}` : ''}`
          : `${LOCAL_FONTS_SUBDIR}${path ? `/${path}` : ''}`,
        base,
      };
    case 'Images':
      return {
        baseDir: customBaseDir ?? BaseDirectory.AppData,
        basePrefix: customBasePrefix || appDataDir,
        fp: customBasePrefixSync
          ? `${customBasePrefixSync()}/${LOCAL_IMAGES_SUBDIR}${path ? `/${path}` : ''}`
          : `${LOCAL_IMAGES_SUBDIR}${path ? `/${path}` : ''}`,
        base,
      };
    case 'Dictionaries':
      return {
        baseDir: customBaseDir ?? BaseDirectory.AppData,
        basePrefix: customBasePrefix || appDataDir,
        fp: customBasePrefixSync
          ? `${customBasePrefixSync()}/${LOCAL_DICTIONARIES_SUBDIR}${path ? `/${path}` : ''}`
          : `${LOCAL_DICTIONARIES_SUBDIR}${path ? `/${path}` : ''}`,
        base,
      };
    case 'None':
      return {
        baseDir: 0,
        basePrefix: async () => '',
        fp: path,
        base,
      };
    default: // 'Temp'
      return {
        baseDir: BaseDirectory.Temp,
        basePrefix: tempDir,
        fp: path,
        base,
      };
  }
};

export const TauriPathResolverLive = Layer.effect(
  PathResolver,
  Effect.gen(function* () {
    const state = yield* PathState;

    const resolve = (path: string, base: BaseDir) =>
      state.get.pipe(Effect.map((cfg) => buildResolved(path, base, cfg)));

    // Mirrors nativeFileSystem.getPrefix (nativeAppService.ts:200-205).
    const prefix = (base: BaseDir) =>
      resolve('', base).pipe(
        Effect.flatMap((r) =>
          Effect.tryPromise({
            try: async () => {
              const basePath = (await r.basePrefix()).replace(/\/+$/, '');
              if (!r.fp) return basePath;
              return r.baseDir === 0 ? r.fp : await join(basePath, r.fp);
            },
            catch: (cause) => new FsError({ operation: 'prefix', path: base, cause }),
          }),
        ),
      );

    const absolute = (path: string, base: BaseDir) =>
      prefix(base).pipe(
        Effect.flatMap((p) =>
          path
            ? Effect.tryPromise({
                try: () => join(p, path),
                catch: (cause) => new FsError({ operation: 'absolute', path, cause }),
              })
            : Effect.succeed(p),
        ),
      );

    return { resolve, prefix, absolute } satisfies PathResolverShape;
  }),
);
