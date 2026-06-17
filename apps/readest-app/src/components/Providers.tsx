import '@/utils/polyfill';
import { useEffect } from 'react';
import { IconContext } from 'react-icons';
import AppLockScreen from '@/components/AppLockScreen';
import AtmosphereOverlay from '@/components/AtmosphereOverlay';
import { CommandPalette, CommandPaletteProvider } from '@/components/command-palette';
import PassphrasePrompt from '@/components/PassphrasePrompt';
import AppLockDialog from '@/components/settings/AppLockDialog';
import { AuthProvider } from '@/context/AuthContext';
import { DropdownProvider } from '@/context/DropdownContext';
import { useBooted, useBootSettings } from '@/context/EffectRuntimeProvider';
import { CSPostHogProvider } from '@/context/PHContext';
import { SyncProvider } from '@/context/SyncContext';
import { useBackgroundTexture } from '@/hooks/useBackgroundTexture';
import { useEinkMode } from '@/hooks/useEinkMode';
import { useUserScopedReset } from '@/hooks/useUserScopedReset';
import { useDefaultIconSize } from '@/hooks/useResponsiveSize';
import { useSafeAreaInsets } from '@/hooks/useSafeAreaInsets';
import i18n from '@/i18n/i18n';
import { upgradeToKeychainIfAvailable } from '@/libs/crypto/passphrase';
import { cryptoSession } from '@/libs/crypto/session';
import { initSettingsSync } from '@/services/sync/replicaSettingsSync';
import { useAppLockStore } from '@/store/appLockStore';
import { useSettingsStore } from '@/store/settingsStore';
import { initSystemThemeListener, loadDataTheme } from '@/store/themeStore';
import { getLocale } from '@/utils/misc';
import { getDirFromUILanguage } from '@/utils/rtl';
import { getAndroidPatchedViewportContent } from '@/utils/viewport';

/**
 * Null-rendering mount point for useUserScopedReset.
 *
 * Placed inside <AuthProvider> (so useAuth resolves) and inside the component
 * tree that is itself a child of <EffectRuntimeProvider> in __root.tsx
 * (so useRunEffect resolves).  Both contexts are guaranteed available here.
 */
const UserScopedResetMount = () => {
  useUserScopedReset();
  return null;
};

const Providers = ({ children }: { children: React.ReactNode }) => {
  const booted = useBooted();
  const bootSettings = useBootSettings();
  const { applyUILanguage } = useSettingsStore();
  const { applyBackgroundTexture } = useBackgroundTexture();
  const { applyEinkMode } = useEinkMode();
  const {
    isInitialized: isLockInitialized,
    isUnlocked,
    initialize: initializeAppLock,
  } = useAppLockStore();
  const iconSize = useDefaultIconSize();
  useSafeAreaInsets(); // Initialize safe area insets

  useEffect(() => {
    const handlerLanguageChanged = (lng: string) => {
      document.documentElement.lang = lng;
      // Set RTL class on document for targeted styling without affecting layout
      const dir = getDirFromUILanguage();
      if (dir === 'rtl') {
        document.documentElement.classList.add('ui-rtl');
      } else {
        document.documentElement.classList.remove('ui-rtl');
      }
    };

    const locale = getLocale();
    handlerLanguageChanged(locale);
    i18n.on('languageChanged', handlerLanguageChanged);
    return () => {
      i18n.off('languageChanged', handlerLanguageChanged);
    };
  }, []);

  useEffect(() => {
    loadDataTheme();
    if (!booted || !bootSettings) return;
    initSystemThemeListener();
    const settings = bootSettings;
    const globalViewSettings = settings.globalViewSettings;
    applyUILanguage(globalViewSettings.uiLanguage);
    applyBackgroundTexture(globalViewSettings);
    if (globalViewSettings.isEink) {
      applyEinkMode(true);
    }
    // Initialize the app-lock gate from on-disk settings. Until
    // this runs, the gate renders nothing — guarantees the
    // library can't flash on screen before the lock screen does.
    initializeAppLock({
      enabled: !!settings.pinCodeEnabled,
      hash: settings.pinCodeHash,
      salt: settings.pinCodeSalt,
    });
    // Subscribe the bundled-settings publisher to settingsStore
    // changes, AFTER priming the publish snapshot from the just-
    // loaded disk settings. Without this priming, the very first
    // setSettings(disk_default) at boot (typically from library
    // page's initLibrary) would diff every whitelisted field
    // against `undefined`, treat them all as "new", and push the
    // local defaults to the server with a fresh HLC — overwriting
    // the cross-device authoritative values another device set.
    // Idempotent — safe to call on remount.
    initSettingsSync(settings);
  }, [
    booted,
    bootSettings,
    applyUILanguage,
    applyBackgroundTexture,
    applyEinkMode,
    initializeAppLock,
  ]);

  // Sync-passphrase boot path: upgrade the passphrase store from
  // ephemeral to OS keychain on Tauri (probe is async — must run after
  // the platform check resolves), then attempt a silent unlock from
  // the saved passphrase. Failures are silent — the gate prompts on
  // first encrypted-field operation if we couldn't restore.
  useEffect(() => {
    void (async () => {
      await upgradeToKeychainIfAvailable();
      await cryptoSession.tryRestoreFromStore();
    })();
  }, []);

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const updated = getAndroidPatchedViewportContent(navigator.userAgent, meta.content);
    if (updated) meta.content = updated;
  }, []);

  // Preserve SSR and the first client paint even before the Effect boot
  // (BootApp) has resolved. Hooks/components that depend on boot readiness
  // already guard themselves via useBooted()/early returns.
  //
  // Once booted, re-enable the app-lock gate so protected sessions still
  // hide the shell until the persisted PIN state loads.
  const showAppLockScreen = booted && isLockInitialized && !isUnlocked;
  const appShellHidden = booted && (!isLockInitialized || !isUnlocked);

  return (
    <CSPostHogProvider>
      <AuthProvider>
        <UserScopedResetMount />
        <IconContext.Provider value={{ size: `${iconSize}px` }}>
          <SyncProvider>
            <DropdownProvider>
              <CommandPaletteProvider>
                <div
                  aria-hidden={appShellHidden}
                  style={appShellHidden ? { display: 'none' } : undefined}
                >
                  {children}
                  <CommandPalette />
                  <AtmosphereOverlay />
                  <PassphrasePrompt />
                </div>
                <AppLockDialog />
                {showAppLockScreen && <AppLockScreen />}
              </CommandPaletteProvider>
            </DropdownProvider>
          </SyncProvider>
        </IconContext.Provider>
      </AuthProvider>
    </CSPostHogProvider>
  );
};

export default Providers;
