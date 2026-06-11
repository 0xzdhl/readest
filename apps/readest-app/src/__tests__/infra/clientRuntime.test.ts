import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tauri client runtime transitively imports every Tauri infra layer, so every
// @tauri-apps/* (and friends) module they touch must be mocked for jsdom. Path logic
// is the only behaviour exercised here — the rest are stubbed to no-ops.
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('/appdata'),
  appConfigDir: vi.fn().mockResolvedValue('/appconfig'),
  appCacheDir: vi.fn().mockResolvedValue('/appcache'),
  appLogDir: vi.fn().mockResolvedValue('/applog'),
  tempDir: vi.fn().mockResolvedValue('/tmp'),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
  basename: vi.fn((p: string) => Promise.resolve(p.split('/').pop() ?? p)),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 8, AppConfig: 10, AppCache: 11, AppLog: 12, Temp: 1 },
  copyFile: vi.fn(() => Promise.resolve()),
  exists: vi.fn(() => Promise.resolve(true)),
  mkdir: vi.fn(() => Promise.resolve()),
  readDir: vi.fn(() => Promise.resolve([])),
  readFile: vi.fn(() => Promise.resolve(new Uint8Array())),
  readTextFile: vi.fn(() => Promise.resolve('')),
  remove: vi.fn(() => Promise.resolve()),
  stat: vi.fn(() => Promise.resolve({})),
  writeFile: vi.fn(() => Promise.resolve()),
  writeTextFile: vi.fn(() => Promise.resolve()),
}));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((p: string) => p),
  invoke: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@tauri-apps/plugin-os', () => ({
  type: vi.fn(() => 'linux'),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(() => Promise.resolve(null)),
  ask: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@choochmeque/tauri-plugin-sharekit-api', () => ({
  shareFile: vi.fn(() => Promise.resolve()),
}));

const load = async () => {
  const { tauriClientRuntime } = await import('@/runtime/client-tauri');
  const { Platform } = await import('@/application/ports/Platform');
  const { PathResolver } = await import('@/application/ports/PathResolver');
  const { PathState } = await import('@/application/ports/PathState');
  return { tauriClientRuntime, Platform, PathResolver, PathState };
};

describe('tauriClientRuntime', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('composes Platform + PathResolver + PathState (requirement never) and resolves a custom-root Books path', async () => {
    const { tauriClientRuntime, Platform, PathResolver, PathState } = await load();

    const result = await tauriClientRuntime.runPromise(
      Effect.gen(function* () {
        const platform = yield* Platform;
        const info = yield* platform.info;
        const state = yield* PathState;
        yield* state.set({ customRootDir: '/custom', isPortable: false });
        const resolver = yield* PathResolver;
        const abs = yield* resolver.absolute('book.epub', 'Books');
        return { appPlatform: info.appPlatform, abs };
      }),
    );

    expect(result.appPlatform).toBe('tauri');
    // Under a custom root, Books collapses to the root then LOCAL_BOOKS_SUBDIR
    // ('Readest/Books') is appended — same as the resolver unit test.
    expect(result.abs).toBe('/custom/Readest/Books/book.epub');
  });
});
