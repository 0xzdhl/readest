import { Effect } from 'effect';
import type { CustomFont, CustomFontInfo } from '@/domain/fonts';
import { AssetError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { computeFontContentId } from '@/services/fontService';
import { parseFontInfo } from '@/utils/font';
import { partialMd5 } from '@/utils/md5';
import { uniqueId } from '@/utils/misc';
import { getFilename } from '@/utils/path';

/**
 * Import a font into the user's `Fonts` base under a per-font bundle dir
 * (`<bundleDir>/<filename>`). Effect-native port of the legacy
 * `fontService.importFont`; maps any failure to `AssetError`.
 */
export const importFont = (
  file?: string | File,
): Effect.Effect<CustomFontInfo | null, AssetError, FileSystem> =>
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

    const fontPath = `${bundleDir}/${filename}`;
    yield* fs.createDir(bundleDir, 'Fonts', true);
    yield* fs.writeFile(fontPath, 'Fonts', bytes);

    const fontFile = yield* fs.openFile(fontPath, 'Fonts');
    const partialMD5 = yield* Effect.tryPromise(() => partialMd5(fontFile));
    const byteSize = bytes.byteLength;
    const contentId = computeFontContentId(partialMD5, byteSize, filename);

    return {
      path: fontPath,
      bundleDir,
      contentId,
      byteSize,
      ...parseFontInfo(bytes, filename),
    };
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'importFont', cause })));

/**
 * Delete a font file and its (now-empty) per-font bundle dir. The bundle-dir
 * removal is best-effort (legacy logged + continued), so the dir-removal error
 * is swallowed and never surfaces as an `AssetError` (a `removeFile` failure
 * still does).
 */
export const deleteFont = (font: CustomFont): Effect.Effect<void, AssetError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.removeFile(font.path, 'Fonts');
    if (font.bundleDir) {
      yield* fs
        .removeDir(font.bundleDir, 'Fonts', true)
        .pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => console.warn('Failed to remove font bundleDir', font.bundleDir, err)),
          ),
        );
    }
  }).pipe(Effect.mapError((cause) => new AssetError({ operation: 'deleteFont', cause })));
