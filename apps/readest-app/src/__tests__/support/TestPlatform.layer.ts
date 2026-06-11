import { Effect, Layer } from 'effect';
import { Platform, type PlatformInfo } from '@/application/ports/Platform';

export const TEST_PLATFORM_INFO: PlatformInfo = {
  appPlatform: 'web',
  osPlatform: 'linux',
  hasTrafficLight: false,
  hasWindow: false,
  hasWindowBar: false,
  hasContextMenu: false,
  hasRoundedWindow: false,
  hasSafeAreaInset: false,
  hasHaptics: false,
  hasUpdater: false,
  hasOrientationLock: false,
  hasScreenBrightness: false,
  hasIAP: false,
  isMobile: false,
  isAppDataSandbox: false,
  isMobileApp: false,
  isAndroidApp: false,
  isIOSApp: false,
  isMacOSApp: false,
  isLinuxApp: false,
  isPortableApp: false,
  isDesktopApp: false,
  isAppImage: false,
  isEink: false,
  canCustomizeRootDir: false,
  canReadExternalDir: false,
  supportsCanvasContext2DFilter: true,
  distChannel: 'readest',
  storefrontRegionCode: null,
  isOnlineCatalogsAccessible: true,
};

export const TestPlatformLive = Layer.succeed(Platform, {
  info: Effect.succeed(TEST_PLATFORM_INFO),
});
