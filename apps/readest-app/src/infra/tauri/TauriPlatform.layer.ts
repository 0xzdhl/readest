import { Effect, Layer } from 'effect';
import { type as osType } from '@tauri-apps/plugin-os';
import { clientEnv } from '@/clientEnv';
import { getOSPlatform } from '@/utils/misc';
import type { DistChannel } from '@/domain/system';
import { Platform } from '@/application/ports/Platform';
import type { PlatformInfo } from '@/application/ports/Platform';

// DIST_CHANNEL comes from env (safe to read at import). OS_TYPE calls a Tauri API,
// so it is computed lazily inside computeInfo() — importing this module must be
// side-effect-free, because the client-runtime singleton statically pulls in this
// Tauri layer even on web/test where Tauri APIs are absent.
const DIST_CHANNEL = clientEnv.VITE_DIST_CHANNEL as DistChannel;

/**
 * Compute PlatformInfo from the current Tauri runtime context.
 * Mirrors NativeAppService field-by-field (nativeAppService.ts:423–461).
 * Window globals are guarded for SSR safety.
 */
function computeInfo(): PlatformInfo {
  const OS_TYPE = osType();
  const isEink = typeof window !== 'undefined' ? Boolean(window.__READEST_IS_EINK) : false;
  const isAppImage = typeof window !== 'undefined' ? Boolean(window.__READEST_IS_APPIMAGE) : false;
  const updaterDisabled =
    typeof window !== 'undefined' ? Boolean(window.__READEST_UPDATER_DISABLED) : false;

  return {
    appPlatform: 'tauri',
    osPlatform: getOSPlatform(),
    isAppDataSandbox: ['android', 'ios'].includes(OS_TYPE),
    isMobile: ['android', 'ios'].includes(OS_TYPE),
    isAndroidApp: OS_TYPE === 'android',
    isIOSApp: OS_TYPE === 'ios',
    isMacOSApp: OS_TYPE === 'macos',
    isLinuxApp: OS_TYPE === 'linux',
    isMobileApp: ['android', 'ios'].includes(OS_TYPE),
    isPortableApp: false, // updated dynamically by BootApp after PathState init
    isDesktopApp: ['macos', 'windows', 'linux'].includes(OS_TYPE),
    isAppImage,
    isEink,
    hasTrafficLight: OS_TYPE === 'macos',
    hasWindow: !(OS_TYPE === 'ios' || OS_TYPE === 'android'),
    hasWindowBar: !(OS_TYPE === 'ios' || OS_TYPE === 'android'),
    hasContextMenu: !(OS_TYPE === 'ios' || OS_TYPE === 'android'),
    hasRoundedWindow: OS_TYPE === 'linux',
    hasSafeAreaInset: OS_TYPE === 'ios' || OS_TYPE === 'android',
    hasHaptics: OS_TYPE === 'ios' || OS_TYPE === 'android',
    hasUpdater: OS_TYPE !== 'ios' && clientEnv.VITE_DISABLE_UPDATER !== 'true' && !updaterDisabled,
    // Orientation lock is not supported on iPad
    hasOrientationLock: (OS_TYPE === 'ios' && getOSPlatform() === 'ios') || OS_TYPE === 'android',
    hasScreenBrightness: OS_TYPE === 'ios' || OS_TYPE === 'android',
    hasIAP: OS_TYPE === 'ios' || (OS_TYPE === 'android' && DIST_CHANNEL === 'playstore'),
    // CustomizeRootDir has a blocker on macOS App Store builds due to Security Scoped Resource restrictions.
    // See: https://github.com/tauri-apps/tauri/issues/3716
    canCustomizeRootDir: DIST_CHANNEL !== 'appstore',
    canReadExternalDir: DIST_CHANNEL !== 'appstore' && DIST_CHANNEL !== 'playstore',
    supportsCanvasContext2DFilter: OS_TYPE !== 'ios' && OS_TYPE !== 'macos' && OS_TYPE !== 'linux',
    distChannel: DIST_CHANNEL,
    // TODO(plan-D): async iOS region in BootApp
    storefrontRegionCode: null,
    isOnlineCatalogsAccessible: true,
  };
}

export const TauriPlatformLive = Layer.succeed(Platform, {
  info: Effect.sync(() => computeInfo()),
});
