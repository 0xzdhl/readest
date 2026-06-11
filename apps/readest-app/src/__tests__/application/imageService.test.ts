import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ImageService } from '@/application/services/ImageService';
import { ImageServiceLive } from '@/infra/shared/ImageService.layer';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { AssetError, FsError } from '@/application/errors/AppError';
import type { CustomTextureInfo } from '@/domain/textures';

const baseResolver = Layer.provideMerge(TestPathResolverLive, PathStateLive);

const makeFs = (over: Partial<FileSystemShape> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    createDir: () => Effect.void,
    writeFile: () => Effect.void,
    openFile: (path: string) =>
      Effect.succeed(new File([new Uint8Array(1024)], path.split('/').pop() ?? 'bg.png')),
    removeFile: () => Effect.void,
    removeDir: () => Effect.void,
    ...over,
  } as unknown as FileSystemShape);

const mkLayer = (fs: Layer.Layer<FileSystem>) =>
  Layer.provide(ImageServiceLive, Layer.merge(fs, baseResolver));
const run = <A>(p: Effect.Effect<A, unknown, ImageService>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(mkLayer(fs))) as Effect.Effect<A, unknown, never>);

describe('ImageService (live over stub FileSystem)', () => {
  it('importImage writes a bundle and returns a populated CustomTextureInfo', async () => {
    const info = await run(
      Effect.flatMap(ImageService, (s) =>
        s.importImage(new File([new Uint8Array(1024)], 'bg.png')),
      ),
      makeFs(),
    );
    expect(info).toBeTruthy();
    expect(info!.path.endsWith('bg.png')).toBe(true);
    expect(typeof info!.bundleDir).toBe('string');
    expect(info!.byteSize).toBe(1024);
    expect(typeof info!.contentId).toBe('string');
    expect(typeof info!.name).toBe('string');
  });

  it('importImage returns null when no file is given', async () => {
    const info = await run(
      Effect.flatMap(ImageService, (s) => s.importImage(undefined)),
      makeFs(),
    );
    expect(info).toBeNull();
  });

  it('deleteImage removes the file and the bundle dir', async () => {
    const removeFile = vi.fn(() => Effect.void);
    const removeDir = vi.fn(() => Effect.void);
    const texture = { name: 'bg', path: 'abc/bg.png', bundleDir: 'abc' } as CustomTextureInfo;
    await run(
      Effect.flatMap(ImageService, (s) => s.deleteImage(texture)),
      makeFs({ removeFile, removeDir }),
    );
    expect(removeFile).toHaveBeenCalledWith('abc/bg.png', 'Images');
    expect(removeDir).toHaveBeenCalledWith('abc', 'Images', true);
  });

  it('deleteImage skips removeDir for legacy textures without bundleDir', async () => {
    const removeDir = vi.fn(() => Effect.void);
    const texture = { name: 'bg', path: 'bg.png' } as CustomTextureInfo;
    await run(
      Effect.flatMap(ImageService, (s) => s.deleteImage(texture)),
      makeFs({ removeDir }),
    );
    expect(removeDir).not.toHaveBeenCalled();
  });

  it('maps a failure to AssetError', async () => {
    const texture = { name: 'bg', path: 'abc/bg.png' } as CustomTextureInfo;
    const err = (await run(
      Effect.flatMap(ImageService, (s) => s.deleteImage(texture)).pipe(Effect.flip),
      makeFs({
        removeFile: () =>
          Effect.fail(new FsError({ operation: 'removeFile', path: 'abc/bg.png', cause: 'boom' })),
      }),
    )) as AssetError;
    expect(err).toBeInstanceOf(AssetError);
    expect(err.operation).toBe('deleteImage');
  });
});
