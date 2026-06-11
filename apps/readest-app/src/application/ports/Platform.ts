import { Context, type Effect } from 'effect';
import type { AppPlatform, DistChannel, OsPlatform } from '@/domain/system';

// Mirrors the capability surface of the legacy platform god-object (faithful port target).
export type PlatformInfo = {
  readonly appPlatform: AppPlatform;
  readonly osPlatform: OsPlatform;
  readonly hasTrafficLight: boolean;
  readonly hasWindow: boolean;
  readonly hasWindowBar: boolean;
  readonly hasContextMenu: boolean;
  readonly hasRoundedWindow: boolean;
  readonly hasSafeAreaInset: boolean;
  readonly hasHaptics: boolean;
  readonly hasUpdater: boolean;
  readonly hasOrientationLock: boolean;
  readonly hasScreenBrightness: boolean;
  readonly hasIAP: boolean;
  readonly isMobile: boolean;
  readonly isAppDataSandbox: boolean;
  readonly isMobileApp: boolean;
  readonly isAndroidApp: boolean;
  readonly isIOSApp: boolean;
  readonly isMacOSApp: boolean;
  readonly isLinuxApp: boolean;
  readonly isPortableApp: boolean;
  readonly isDesktopApp: boolean;
  readonly isAppImage: boolean;
  readonly isEink: boolean;
  readonly canCustomizeRootDir: boolean;
  readonly canReadExternalDir: boolean;
  readonly supportsCanvasContext2DFilter: boolean;
  readonly distChannel: DistChannel;
  readonly storefrontRegionCode: string | null;
  readonly isOnlineCatalogsAccessible: boolean;
};

export interface PlatformShape {
  readonly info: Effect.Effect<PlatformInfo>;
}

export class Platform extends Context.Tag('app/Platform')<Platform, PlatformShape>() {}
