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
 * Mirrors WebAppService field overrides (webAppService.ts:287–292) plus
 * the BaseAppService defaults (appService.ts:36–66) for every other field.
 */
function computeInfo(): PlatformInfo {
  const distChannel = clientEnv.VITE_DIST_CHANNEL as DistChannel;
  const osPlatform = getOSPlatform();

  return {
    appPlatform: 'web',
    osPlatform,
    // UA-based mobile detection (webAppService.ts:289)
    isMobile: ['android', 'ios'].includes(osPlatform),
    // BaseAppService defaults for every other field
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
    // webAppService.ts:292
    hasSafeAreaInset: typeof window !== 'undefined' ? isPWA() : false,
    hasHaptics: false,
    hasUpdater: false,
    hasOrientationLock: false,
    hasScreenBrightness: false,
    hasIAP: false,
    canCustomizeRootDir: false,
    canReadExternalDir: false,
    // webAppService.ts:291
    supportsCanvasContext2DFilter: typeof navigator !== 'undefined' ? !isSafariBrowser() : true,
    distChannel,
    storefrontRegionCode: null,
    isOnlineCatalogsAccessible: true,
  };
}

export const WebPlatformLive = Layer.succeed(Platform, {
  info: Effect.sync(() => computeInfo()),
});
