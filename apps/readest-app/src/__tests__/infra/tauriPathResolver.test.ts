import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('/appdata'),
  appConfigDir: vi.fn().mockResolvedValue('/appconfig'),
  appCacheDir: vi.fn().mockResolvedValue('/appcache'),
  appLogDir: vi.fn().mockResolvedValue('/applog'),
  tempDir: vi.fn().mockResolvedValue('/tmp'),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 8, AppConfig: 10, AppCache: 11, AppLog: 12, Temp: 1 },
}));

const load = async () => {
  const { TauriPathResolverLive } = await import('@/infra/tauri/TauriPathResolver.layer');
  const { PathResolver } = await import('@/application/ports/PathResolver');
  const { PathState, PathStateLive } = await import('@/application/ports/PathState');
  const layer = Layer.provideMerge(TauriPathResolverLive, PathStateLive);
  const run = <A>(p: Effect.Effect<A, unknown, never>) => Effect.runPromise(p);
  return { PathResolver, PathState, layer, run };
};

describe('TauriPathResolver', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('default (no custom root): Books absolute = appDataDir + Books subdir + path', async () => {
    const { PathResolver, layer, run } = await load();
    const abs = await run(
      Effect.flatMap(PathResolver, (r) => r.absolute('b.epub', 'Books')).pipe(
        Effect.provide(layer),
      ),
    );
    // LOCAL_BOOKS_SUBDIR === 'Readest/Books' in this repo; assert the resolved shape.
    expect(abs.startsWith('/appdata/')).toBe(true);
    expect(abs.endsWith('/b.epub')).toBe(true);
    expect(abs).toBe('/appdata/Readest/Books/b.epub');
  });

  it('custom root: Books path nests under customRootDir + Books subdir', async () => {
    const { PathResolver, PathState, layer, run } = await load();
    const abs = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.set({ customRootDir: '/custom', isPortable: false });
        const r = yield* PathResolver;
        return yield* r.absolute('b.epub', 'Books');
      }).pipe(Effect.provide(layer)),
    );
    // Under a custom root, getPathResolver keeps the leaf BaseDir collapsed (Books is in
    // dataDirs so the custom prefix is just the root) but STILL appends LOCAL_BOOKS_SUBDIR
    // ('Readest/Books') to fp. So the faithful port produces /custom/Readest/Books/b.epub.
    expect(abs).toBe('/custom/Readest/Books/b.epub');
  });

  it('portable: Settings resolves under execDir', async () => {
    const { PathResolver, PathState, layer, run } = await load();
    const abs = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.set({ isPortable: true, execDir: '/exec' });
        const r = yield* PathResolver;
        return yield* r.absolute('settings.json', 'Settings');
      }).pipe(Effect.provide(layer)),
    );
    expect(abs).toBe('/exec/settings.json');
  });

  it('resolve returns ResolvedPath with baseDir=0 under custom root', async () => {
    const { PathResolver, PathState, layer, run } = await load();
    const resolved = await run(
      Effect.gen(function* () {
        const s = yield* PathState;
        yield* s.set({ customRootDir: '/custom', isPortable: false });
        const r = yield* PathResolver;
        return yield* r.resolve('x.json', 'Data');
      }).pipe(Effect.provide(layer)),
    );
    expect(resolved.baseDir).toBe(0);
    expect(resolved.base).toBe('Data');
    // Data is in dataDirs -> custom prefix collapses to the root, then DATA_SUBDIR is appended.
    expect(resolved.fp).toBe('/custom/Readest/x.json');
  });
});
