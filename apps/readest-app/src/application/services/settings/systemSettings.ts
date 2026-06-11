import { Effect } from 'effect';
import { v4 as uuidv4 } from 'uuid';
import type { SystemSettings } from '@/domain/settings';
import {
  DEFAULT_READSETTINGS,
  SYSTEM_SETTINGS_VERSION,
  DEFAULT_SYSTEM_SETTINGS,
  DEFAULT_MOBILE_READSETTINGS,
  SETTINGS_FILENAME,
  DEFAULT_MOBILE_SYSTEM_SETTINGS,
} from '@/services/constants';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import { SettingsError } from '@/application/errors/AppError';
import { FileSystem } from '@/application/ports/FileSystem';
import { PathResolver } from '@/application/ports/PathResolver';
import { getDefaultViewSettings, migrateHighlightColorPrefs } from './viewSettings';
import { safeLoadJsonE, safeSaveJsonE } from './json';

export type SettingsCtx = {
  readonly isMobile: boolean;
  readonly isEink: boolean;
  readonly isAppDataSandbox: boolean;
};

export const saveSystemSettings = (
  settings: SystemSettings,
): Effect.Effect<void, SettingsError, FileSystem> =>
  safeSaveJsonE(SETTINGS_FILENAME, 'Settings', settings).pipe(
    Effect.mapError((cause) => new SettingsError({ operation: 'save', cause })),
  );

export const loadSystemSettings = (
  ctx: SettingsCtx,
): Effect.Effect<SystemSettings, SettingsError, FileSystem | PathResolver> =>
  Effect.gen(function* () {
    const resolver = yield* PathResolver;
    const booksPrefix = () =>
      resolver
        .prefix('Books')
        .pipe(Effect.mapError((cause) => new SettingsError({ operation: 'load', cause })));

    const defaultSettings: SystemSettings = {
      ...DEFAULT_SYSTEM_SETTINGS,
      ...(ctx.isMobile ? DEFAULT_MOBILE_SYSTEM_SETTINGS : {}),
      version: SYSTEM_SETTINGS_VERSION,
      localBooksDir: yield* booksPrefix(),
      koreaderSyncDeviceId: uuidv4(),
      globalReadSettings: {
        ...DEFAULT_READSETTINGS,
        ...(ctx.isMobile ? DEFAULT_MOBILE_READSETTINGS : {}),
      },
      globalViewSettings: getDefaultViewSettings({ isMobile: ctx.isMobile, isEink: ctx.isEink }),
    } as SystemSettings;

    let settings = yield* safeLoadJsonE<SystemSettings>(
      SETTINGS_FILENAME,
      'Settings',
      defaultSettings,
    );

    const version = settings.version ?? 0;
    if (ctx.isAppDataSandbox || version < SYSTEM_SETTINGS_VERSION) {
      settings.version = SYSTEM_SETTINGS_VERSION;
    }
    settings = {
      ...DEFAULT_SYSTEM_SETTINGS,
      ...(ctx.isMobile ? DEFAULT_MOBILE_SYSTEM_SETTINGS : {}),
      ...settings,
    };
    settings.globalReadSettings = {
      ...DEFAULT_READSETTINGS,
      ...(ctx.isMobile ? DEFAULT_MOBILE_READSETTINGS : {}),
      ...settings.globalReadSettings,
    };
    migrateHighlightColorPrefs(settings.globalReadSettings);
    settings.globalViewSettings = {
      ...getDefaultViewSettings({ isMobile: ctx.isMobile, isEink: ctx.isEink }),
      ...settings.globalViewSettings,
    };
    settings.aiSettings = {
      ...DEFAULT_AI_SETTINGS,
      ...settings.aiSettings,
    };

    settings.localBooksDir = yield* booksPrefix();

    // Coerce stale `'wikipedia'` quick-action to `'dictionary'`. The Wikipedia
    // annotation tool was removed; Wikipedia is now reachable as a tab inside
    // the unified dictionary popup. Without this guard, users who had set the
    // quick action to wikipedia would get a no-op.
    if ((settings.globalViewSettings.annotationQuickAction as string) === 'wikipedia') {
      settings.globalViewSettings.annotationQuickAction = 'dictionary';
    }

    if (!settings.kosync.deviceId) {
      settings.kosync.deviceId = uuidv4();
      yield* saveSystemSettings(settings);
    }

    if (!settings.replicaDeviceId) {
      settings.replicaDeviceId = uuidv4();
      yield* saveSystemSettings(settings);
    }

    return settings;
  });
