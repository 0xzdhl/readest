import { Effect, Layer } from 'effect';
import { clientEnv } from '@/clientEnv';
import { getOSPlatform } from '@/utils/misc';
import { isSafariBrowser } from '@/utils/ua';
import { isPWA } from '@/services/environment';
import type { DistChannel } from '@/domain/system';
import { Platform } from '@/application/ports/Platform';
import type { PlatformInfo } from '@/application/ports/Platform';

/**
 * Compute PlatformInfo for the web platform.
 * Mirrors the legacy web platform-flag overrides plus
 * the shared defaults for every other field.
 */
function computeInfo(): PlatformInfo {
  const distChannel = clientEnv.VITE_DIST_CHANNEL as DistChannel;
  const osPlatform = getOSPlatform();

  return {
    appPlatform: 'web',
    osPlatform,
    // UA-based mobile detection
    isMobile: ['android', 'ios'].includes(osPlatform),
    // shared defaults for every other field
    isAppDataSandbox: false,
    isAndroidApp: false,
    isIOSApp: false,
    isMacOSApp: false,
    isLinuxApp: false,
    isMobileApp: false,
    isPortableApp: false,
    isDesktopApp: false,
    isAppImage: false,
    isEink: false,
    hasTrafficLight: false,
    hasWindow: false,
    hasWindowBar: false,
    hasContextMenu: false,
    hasRoundedWindow: false,
    hasSafeAreaInset: typeof window !== 'undefined' ? isPWA() : false,
    hasHaptics: false,
    hasUpdater: false,
    hasOrientationLock: false,
    hasScreenBrightness: false,
    hasIAP: false,
    canCustomizeRootDir: false,
    canReadExternalDir: false,
    supportsCanvasContext2DFilter: typeof navigator !== 'undefined' ? !isSafariBrowser() : true,
    distChannel,
    storefrontRegionCode: null,
    isOnlineCatalogsAccessible: true,
  };
}

export const WebPlatformLive = Layer.succeed(Platform, {
  info: Effect.sync(() => computeInfo()),
});
