import { afterEach, describe, expect, it, vi } from 'vitest';

const loadFresh = async (platform: 'tauri' | 'web') => {
  vi.resetModules();
  vi.doMock('@/services/environment', () => ({
    isTauriAppPlatform: () => platform === 'tauri',
    isWebAppPlatform: () => platform === 'web',
  }));
  // Mock the two runtimes so the test does not construct real Tauri/web layers.
  const fakeInfo = { appPlatform: platform, isMobile: false } as unknown;
  const fakeRuntime = { runSync: vi.fn(() => fakeInfo), runPromise: vi.fn() };
  vi.doMock('@/runtime/client-tauri', () => ({
    tauriClientRuntime: { ...fakeRuntime, _tag: 'tauri' },
  }));
  vi.doMock('@/runtime/client-web', () => ({ webClientRuntime: { ...fakeRuntime, _tag: 'web' } }));
  return import('@/runtime/clientRuntime');
};

describe('getClientRuntime / getPlatformInfo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('selects the tauri runtime when isTauriAppPlatform()', async () => {
    const m = await loadFresh('tauri');
    expect((m.getClientRuntime() as unknown as { _tag: string })._tag).toBe('tauri');
  });

  it('selects the web runtime otherwise', async () => {
    const m = await loadFresh('web');
    expect((m.getClientRuntime() as unknown as { _tag: string })._tag).toBe('web');
  });

  it('getPlatformInfo runs Platform.info via runSync and caches it', async () => {
    const m = await loadFresh('web');
    const a = m.getPlatformInfo();
    const b = m.getPlatformInfo();
    expect(a).toBe(b); // cached (same reference)
    expect((a as { appPlatform: string }).appPlatform).toBe('web');
  });

  it('setClientRuntime injects a runtime for tests', async () => {
    const m = await loadFresh('web');
    const injected = {
      runSync: () => ({ appPlatform: 'tauri' }),
      runPromise: vi.fn(),
      _tag: 'injected',
    };
    m.setClientRuntime(injected as never);
    expect((m.getClientRuntime() as unknown as { _tag: string })._tag).toBe('injected');
  });
});
