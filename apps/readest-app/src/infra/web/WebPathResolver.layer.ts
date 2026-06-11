import { Effect, Layer } from 'effect';
import type { BaseDir, ResolvedPath } from '@/domain/system';
import { PathResolver, type PathResolverShape } from '@/application/ports/PathResolver';
import {
  DATA_SUBDIR,
  LOCAL_BOOKS_SUBDIR,
  LOCAL_DICTIONARIES_SUBDIR,
  LOCAL_FONTS_SUBDIR,
  LOCAL_IMAGES_SUBDIR,
} from '@/services/constants';

// Faithful port of the legacy web resolvePath + getPrefix.
// The web filesystem stores flat relative paths under category subdirs; there is no
// custom root / portable handling, so this resolver does not depend on PathState.
const webBasePrefix = async () => '';

const resolvePath = (path: string, base: BaseDir): ResolvedPath => {
  switch (base) {
    case 'Data':
      return { baseDir: 0, basePrefix: webBasePrefix, fp: `${DATA_SUBDIR}/${path}`, base };
    case 'Books':
      return { baseDir: 0, basePrefix: webBasePrefix, fp: `${LOCAL_BOOKS_SUBDIR}/${path}`, base };
    case 'Fonts':
      return { baseDir: 0, basePrefix: webBasePrefix, fp: `${LOCAL_FONTS_SUBDIR}/${path}`, base };
    case 'Images':
      return { baseDir: 0, basePrefix: webBasePrefix, fp: `${LOCAL_IMAGES_SUBDIR}/${path}`, base };
    case 'Dictionaries':
      return {
        baseDir: 0,
        basePrefix: webBasePrefix,
        fp: `${LOCAL_DICTIONARIES_SUBDIR}/${path}`,
        base,
      };
    case 'None':
      return { baseDir: 0, basePrefix: webBasePrefix, fp: path, base };
    default:
      return { baseDir: 0, basePrefix: webBasePrefix, fp: `${base}/${path}`, base };
  }
};

export const WebPathResolverLive = Layer.succeed(PathResolver, {
  resolve: (path, base) => Effect.succeed(resolvePath(path, base)),
  // Mirrors the legacy web IndexedDB filesystem getPrefix.
  prefix: (base) =>
    Effect.sync(() => {
      const { basePrefix: _basePrefix, fp } = resolvePath('', base);
      // basePrefix is always '' for web — keep the structure to stay faithful.
      const prefix = fp || '';
      return prefix.replace(/\/+$/, '');
    }),
  absolute: (path, base) =>
    Effect.sync(() => {
      const prefix = resolvePath('', base).fp.replace(/\/+$/, '');
      if (!path) return prefix;
      return prefix ? `${prefix}/${path}` : path;
    }),
} satisfies PathResolverShape);
