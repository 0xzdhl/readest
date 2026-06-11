import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { FontService } from '@/application/services/FontService';
import { FontServiceLive } from '@/infra/shared/FontService.layer';
import { FileSystem, type FileSystemShape } from '@/application/ports/FileSystem';
import { PathStateLive } from '@/application/ports/PathState';
import { TestPathResolverLive } from '@/__tests__/support/TestPathResolver.layer';
import { AssetError, FsError } from '@/application/errors/AppError';
import type { CustomFont } from '@/domain/fonts';

const baseResolver = Layer.provideMerge(TestPathResolverLive, PathStateLive);

// Minimal in-memory FileSystem stub supporting only the ops importFont/deleteFont touch.
const makeFs = (over: Partial<FileSystemShape> = {}): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, {
    createDir: () => Effect.void,
    writeFile: () => Effect.void,
    openFile: (path: string) =>
      Effect.succeed(new File([new Uint8Array(1024)], path.split('/').pop() ?? 'font.ttf')),
    removeFile: () => Effect.void,
    removeDir: () => Effect.void,
    ...over,
  } as unknown as FileSystemShape);

const mkLayer = (fs: Layer.Layer<FileSystem>) =>
  Layer.provide(FontServiceLive, Layer.merge(fs, baseResolver));
const run = <A>(p: Effect.Effect<A, unknown, FontService>, fs: Layer.Layer<FileSystem>) =>
  Effect.runPromise(p.pipe(Effect.provide(mkLayer(fs))) as Effect.Effect<A, unknown, never>);

describe('FontService (live over stub FileSystem)', () => {
  it('importFont writes a bundle and returns a populated CustomFontInfo', async () => {
    const info = await run(
      Effect.flatMap(FontService, (s) =>
        s.importFont(new File([new Uint8Array(1024)], 'Roboto.ttf')),
      ),
      makeFs(),
    );
    expect(info).toBeTruthy();
    expect(info!.path.endsWith('Roboto.ttf')).toBe(true);
    expect(typeof info!.bundleDir).toBe('string');
    expect(info!.byteSize).toBe(1024);
    expect(typeof info!.contentId).toBe('string');
  });

  it('importFont returns null when no file is given', async () => {
    const info = await run(
      Effect.flatMap(FontService, (s) => s.importFont(undefined)),
      makeFs(),
    );
    expect(info).toBeNull();
  });

  it('deleteFont removes the file', async () => {
    const removeFile = vi.fn(() => Effect.void);
    const removeDir = vi.fn(() => Effect.void);
    const font = {
      id: '1',
      name: 'Roboto',
      path: 'abc/Roboto.ttf',
      bundleDir: 'abc',
    } as CustomFont;
    await run(
      Effect.flatMap(FontService, (s) => s.deleteFont(font)),
      makeFs({ removeFile, removeDir }),
    );
    expect(removeFile).toHaveBeenCalledWith('abc/Roboto.ttf', 'Fonts');
    expect(removeDir).toHaveBeenCalledWith('abc', 'Fonts', true);
  });

  it('deleteFont skips removeDir for legacy fonts without bundleDir', async () => {
    const removeDir = vi.fn(() => Effect.void);
    const font = { id: '1', name: 'Roboto', path: 'Roboto.ttf' } as CustomFont;
    await run(
      Effect.flatMap(FontService, (s) => s.deleteFont(font)),
      makeFs({ removeDir }),
    );
    expect(removeDir).not.toHaveBeenCalled();
  });

  it('maps a failure to AssetError', async () => {
    const font = { id: '1', name: 'Roboto', path: 'abc/Roboto.ttf' } as CustomFont;
    const err = (await run(
      Effect.flatMap(FontService, (s) => s.deleteFont(font)).pipe(Effect.flip),
      makeFs({
        removeFile: () =>
          Effect.fail(
            new FsError({ operation: 'removeFile', path: 'abc/Roboto.ttf', cause: 'boom' }),
          ),
      }),
    )) as AssetError;
    expect(err).toBeInstanceOf(AssetError);
    expect(err.operation).toBe('deleteFont');
  });
});
