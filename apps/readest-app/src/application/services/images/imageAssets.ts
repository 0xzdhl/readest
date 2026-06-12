import { Effect } from 'effect';
import type { CustomTextureInfo } from '@/domain/textures';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { computeTextureContentId } from '@/services/imageService';
import { getTextureName } from '@/styles/textures';
import { partialMd5 } from '@/utils/md5';
import { uniqueId } from '@/utils/misc';
import { getFilename } from '@/utils/path';

/**
 * Import an image into the user's `Images` base under a per-texture bundle dir
 * (`<bundleDir>/<filename>`). Effect-native port of the legacy
 * `imageService.importImage`; maps any failure to `AssetError`.
 */
export const importImage = (
  file?: string | File,
): Effect.Effect<CustomTextureInfo | null, AssetError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const bundleDir = uniqueId();
    let filename: string;
    let bytes: ArrayBuffer;

    if (typeof file === 'string') {
      const fileobj = yield* fs.openFile(file, 'None');
      filename = fileobj.name || getFilename(file);
      bytes = yield* Effect.tryPromise(() => fileobj.arrayBuffer());
    } else if (file) {
      filename = getFilename(file.name);
      bytes = yield* Effect.tryPromise(() => file.arrayBuffer());
    } else {
      return null;
    }

    const texturePath = `${bundleDir}/${filename}`;
    yield* fs.createDir(bundleDir, 'Images', true);
    yield* fs.writeFile(texturePath, 'Images', bytes);

    const textureFile = yield* fs.openFile(texturePath, 'Images');
    const partialMD5 = yield* Effect.tryPromise(() => partialMd5(textureFile));
    const byteSize = bytes.byteLength;
    const contentId = computeTextureContentId(partialMD5, byteSize, filename);

    return {
      name: getTextureName(filename),
      path: texturePath,
      bundleDir,
      contentId,
      byteSize,
    };
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'importImage', cause })));

/**
 * Delete a texture file and its (now-empty) per-texture bundle dir. The
 * bundle-dir removal is best-effort: the dir-removal error is swallowed and
 * never surfaces as an `AssetError` (a `removeFile` failure still does).
 */
export const deleteImage = (
  texture: CustomTextureInfo,
): Effect.Effect<void, AssetError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.removeFile(texture.path, 'Images');
    if (texture.bundleDir) {
      yield* fs
        .removeDir(texture.bundleDir, 'Images', true)
        .pipe(
          Effect.catchAll((err) =>
            Effect.sync(() =>
              console.warn('Failed to remove texture bundleDir', texture.bundleDir, err),
            ),
          ),
        );
    }
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'deleteImage', cause })));
