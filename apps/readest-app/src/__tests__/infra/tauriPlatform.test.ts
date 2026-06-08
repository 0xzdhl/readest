import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Must be hoisted before any dynamic imports
vi.mock('@tauri-apps/plugin-os', () => ({ type: vi.fn(() => 'macos') }));
// clientEnv reads VITE_ vars — stub to avoid validation errors in tests
vi.mock('@/clientEnv', () => ({
  clientEnv: {
    VITE_DIST_CHANNEL: 'readest',
    VITE_DISABLE_UPDATER: 'false',
  },
}));
// getOSPlatform uses navigator UA — provide a neutral stub
vi.mock('@/utils/misc', () => ({
  getOSPlatform: vi.fn(() => 'macos'),
}));

const load = async (osOverride: string) => {
  const { type } = await import('@tauri-apps/plugin-os');
  (type as ReturnType<typeof vi.fn>).mockReturnValue(osOverride);

  const { TauriPlatformLive } = await import('@/infra/tauri/TauriPlatform.layer');
  const { Platform } = await import('@/application/ports/Platform');
  const run = <A>(p: Effect.Effect<A, unknown, never>) => Effect.runPromise(p);

  const info = await run(
    Effect.flatMap(Platform, (p) => p.info).pipe(Effect.provide(TauriPlatformLive)),
  );
  return info;
};

describe('TauriPlatform', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('macOS: appPlatform=tauri, isMacOSApp, hasTrafficLight, not mobile', async () => {
    const info = await load('macos');
    expect(info.appPlatform).toBe('tauri');
    expect(info.isMacOSApp).toBe(true);
    expect(info.isMobile).toBe(false);
    expect(info.hasTrafficLight).toBe(true);
    expect(info.isDesktopApp).toBe(true);
    expect(info.isAndroidApp).toBe(false);
    expect(info.isIOSApp).toBe(false);
  });

  it('iOS: isIOSApp, hasHaptics, hasSafeAreaInset, isMobile all true', async () => {
    const info = await load('ios');
    expect(info.isIOSApp).toBe(true);
    expect(info.hasHaptics).toBe(true);
    expect(info.hasSafeAreaInset).toBe(true);
    expect(info.isMobile).toBe(true);
    expect(info.isMobileApp).toBe(true);
    expect(info.hasTrafficLight).toBe(false);
    expect(info.isDesktopApp).toBe(false);
  });
});
