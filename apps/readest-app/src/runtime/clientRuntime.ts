import { Effect, type ManagedRuntime } from 'effect';
import { Platform, type PlatformInfo } from '@/application/ports/Platform';
import type { PathState } from '@/application/ports/PathState';
import type { PathResolver } from '@/application/ports/PathResolver';
import type { FileSystem } from '@/application/ports/FileSystem';
import type { Dialog } from '@/application/ports/Dialog';
import type { Database } from '@/application/ports/Database';
import type { SettingsRepository } from '@/application/repositories/SettingsRepository';
import type { MigrationService } from '@/application/services/MigrationService';
import type { BookRepository } from '@/application/repositories/BookRepository';
import type { LibraryRepository } from '@/application/repositories/LibraryRepository';
import type { CoverService } from '@/application/services/CoverService';
import type { FontService } from '@/application/services/FontService';
import type { ImageService } from '@/application/services/ImageService';
import type { DictionaryService } from '@/application/services/DictionaryService';
import type { CloudService } from '@/application/services/CloudService';
import { isTauriAppPlatform } from '@/services/environment';
import { tauriClientRuntime } from './client-tauri';
import { webClientRuntime } from './client-web';

// The Tauri and Web client runtimes provide the same set of port tags, but their inferred
// `ManagedRuntime` types are not structurally identical (distinct Live layers). Pin both to a
// shared alias built from the union of provided port tags so the singleton + ternary typecheck.
export type ClientServices =
  | Platform
  | PathState
  | PathResolver
  | FileSystem
  | Dialog
  | Database
  | SettingsRepository
  | MigrationService
  | BookRepository
  | LibraryRepository
  | CoverService
  | FontService
  | ImageService
  | DictionaryService
  | CloudService;
type ClientRuntime = ManagedRuntime.ManagedRuntime<ClientServices, never>;

// `Platform.info` in the original plan referenced the service field on the Tag; `info` lives on
// the resolved service, so access it via the tag. This Effect has no error/requirement channel
// once Platform is provided, keeping `runSync` valid.
const platformInfoEffect = Effect.flatMap(Platform, (platform) => platform.info);

let runtime: ClientRuntime | null = null;
let platformInfo: PlatformInfo | null = null;

// SSR fallback: the platform layers read Tauri/UA APIs that only exist client-side.
// On the server we can't (and shouldn't) construct the runtime; return neutral web defaults
// so sync consumers degrade exactly like the legacy null-appService path.
const SSR_PLATFORM_INFO: PlatformInfo = {
  appPlatform: 'web',
  osPlatform: 'unknown',
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

export const getClientRuntime = (): ClientRuntime => {
  if (typeof window === 'undefined') {
    throw new Error('getClientRuntime() is not available during SSR');
  }
  if (!runtime) {
    runtime = isTauriAppPlatform()
      ? (tauriClientRuntime as ClientRuntime)
      : (webClientRuntime as ClientRuntime);
  }
  return runtime;
};

export const getPlatformInfo = (): PlatformInfo => {
  if (typeof window === 'undefined') return SSR_PLATFORM_INFO;
  if (!platformInfo) platformInfo = getClientRuntime().runSync(platformInfoEffect);
  return platformInfo;
};

/** Test seam: inject a runtime + reset caches. */
export const setClientRuntime = (rt: ClientRuntime): void => {
  runtime = rt;
  platformInfo = null;
};
