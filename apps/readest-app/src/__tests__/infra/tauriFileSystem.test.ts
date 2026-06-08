import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable plugin-fs store: writeFile records the last write; readTextFile/readFile
// return what was written so the CRUD round-trip is observable.
const lastWrite: { fp?: string; baseDir?: number; content?: unknown } = {};

const writeTextFile = vi.fn((fp: string, content: unknown, opts?: { baseDir?: number }) => {
  lastWrite.fp = fp;
  lastWrite.baseDir = opts?.baseDir;
  lastWrite.content = content;
  return Promise.resolve();
});
const writeFile = vi.fn(() => Promise.resolve());
const readTextFile = vi.fn((_fp: string, _opts?: { baseDir?: number }) =>
  Promise.resolve(lastWrite.content as string),
);
const readFile = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])));
const copyFile = vi.fn(() => Promise.resolve());
const remove = vi.fn(() => Promise.resolve());
const mkdir = vi.fn(() => Promise.resolve());
const exists = vi.fn(() => Promise.resolve(true));
const stat = vi.fn(() =>
  Promise.resolve({
    isFile: true,
    isDirectory: false,
    size: 3,
    mtime: null,
    atime: null,
    birthtime: null,
  }),
);
const readDir = vi.fn(() => Promise.resolve([]));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile,
  writeFile,
  readTextFile,
  readFile,
  copyFile,
  remove,
  mkdir,
  exists,
  stat,
  readDir,
  BaseDirectory: { AppData: 8, AppConfig: 10, AppCache: 11, AppLog: 12, Temp: 1 },
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('/appdata'),
  appConfigDir: vi.fn().mockResolvedValue('/appconfig'),
  appCacheDir: vi.fn().mockResolvedValue('/appcache'),
  appLogDir: vi.fn().mockResolvedValue('/applog'),
  tempDir: vi.fn().mockResolvedValue('/tmp'),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
  basename: vi.fn((p: string) => Promise.resolve(p.split('/').pop() ?? p)),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve([])),
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
}));

vi.mock('@tauri-apps/plugin-os', () => ({
  type: vi.fn(() => 'macos'),
}));

const load = async () => {
  const { TauriFileSystemLive } = await import('@/infra/tauri/TauriFileSystem.layer');
  const { TauriPathResolverLive } = await import('@/infra/tauri/TauriPathResolver.layer');
  const { TauriPlatformLive } = await import('@/infra/tauri/TauriPlatform.layer');
  const { FileSystem } = await import('@/application/ports/FileSystem');
  const { PathStateLive } = await import('@/application/ports/PathState');

  // FileSystem needs PathResolver + Platform; PathResolver needs PathState.
  const deps = Layer.provideMerge(
    Layer.mergeAll(TauriPathResolverLive, TauriPlatformLive),
    PathStateLive,
  );
  const layer = Layer.provide(TauriFileSystemLive, deps);
  const run = <A>(p: Effect.Effect<A, unknown, never>) => Effect.runPromise(p);
  return { FileSystem, layer, run };
};

describe('TauriFileSystem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastWrite.fp = undefined;
    lastWrite.baseDir = undefined;
    lastWrite.content = undefined;
  });
  afterEach(() => vi.resetModules());

  it('writeFile then readFile(text) round-trips and delegates with resolved path/baseDir', async () => {
    const { FileSystem, layer, run } = await load();
    const content = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        yield* fs.writeFile('a.txt', 'Books', 'hi');
        return yield* fs.readFile('a.txt', 'Books', 'text');
      }).pipe(Effect.provide(layer)),
    );

    expect(content).toBe('hi');
    // Books resolves under AppData (8) at the books subdir + path.
    expect(writeTextFile).toHaveBeenCalled();
    expect(lastWrite.fp).toBe('Readest/Books/a.txt');
    expect(lastWrite.baseDir).toBe(8);
    expect(readTextFile).toHaveBeenCalledWith('Readest/Books/a.txt', { baseDir: 8 });
  });

  it('removeFile delegates to plugin-fs remove with resolved path/baseDir', async () => {
    const { FileSystem, layer, run } = await load();
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        yield* fs.removeFile('a.txt', 'Books');
      }).pipe(Effect.provide(layer)),
    );

    expect(remove).toHaveBeenCalledWith('Readest/Books/a.txt', { baseDir: 8 });
  });

  it('copyFile (non-content://) delegates to plugin-fs copyFile with resolved src/dst', async () => {
    const { FileSystem, layer, run } = await load();
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        yield* fs.copyFile('a.txt', 'Books', 'b.txt', 'Books');
      }).pipe(Effect.provide(layer)),
    );

    expect(copyFile).toHaveBeenCalledWith('Readest/Books/a.txt', 'Readest/Books/b.txt', {
      fromPathBaseDir: 8,
      toPathBaseDir: 8,
    });
  });

  it('exists returns false (no error channel) when plugin-fs throws', async () => {
    exists.mockRejectedValueOnce(new Error('boom'));
    const { FileSystem, layer, run } = await load();
    const res = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        return yield* fs.exists('missing.txt', 'Books');
      }).pipe(Effect.provide(layer)),
    );
    expect(res).toBe(false);
  });
});
