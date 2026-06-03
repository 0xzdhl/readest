import { clientEnv } from '@/clientEnv';
import type { AppService } from '@/types/system';

declare global {
  interface Window {
    __READEST_CLI_ACCESS?: boolean;
  }
}

export const isTauriAppPlatform = () => clientEnv.VITE_APP_PLATFORM === 'tauri';
export const isWebAppPlatform = () => clientEnv.VITE_APP_PLATFORM === 'web';
export const hasCli = () => window.__READEST_CLI_ACCESS === true;
export const isPWA = () => window.matchMedia('(display-mode: standalone)').matches;
export const getBaseUrl = () => clientEnv.VITE_API_BASE_URL;
export const getNodeBaseUrl = () => clientEnv.VITE_NODE_BASE_URL;
export const getWebsiteUrl = () => clientEnv.VITE_WEBSITE_URL;
export const getDownloadBaseUrl = () => clientEnv.VITE_DOWNLOAD_BASE_URL;
export const getSupportEmail = () => clientEnv.VITE_SUPPORT_EMAIL;
export const getBrandName = () => clientEnv.VITE_BRAND_NAME;
export const getShareBaseUrl = () => `${getBaseUrl()}/s`;
export const getUpdaterFileUrl = () => `${getDownloadBaseUrl()}/latest.json`;
export const getChangelogFileUrl = () => `${getDownloadBaseUrl()}/release-notes.json`;

export const isMacPlatform = () =>
  typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

export const getCommandPaletteShortcut = () => (isMacPlatform() ? '⌘⇧P' : 'Ctrl+Shift+P');

const isWebDevMode = () => clientEnv.NODE_ENV === 'development' && isWebAppPlatform();

// Dev API only in development mode and web platform
// with command `pnpm dev-web`
// for production build or tauri app use the production Web API
export const getAPIBaseUrl = () => (isWebDevMode() ? '/api' : `${getBaseUrl()}/api`);

// For Node.js API that currently not supported in some edge runtimes
export const getNodeAPIBaseUrl = () => (isWebDevMode() ? '/api' : `${getNodeBaseUrl()}/api`);

export interface EnvConfigType {
  getAppService: () => Promise<AppService>;
}

let nativeAppService: AppService | null = null;
const getNativeAppService = async () => {
  if (!nativeAppService) {
    const { NativeAppService } = await import('@/services/nativeAppService');
    nativeAppService = new NativeAppService();
    await nativeAppService.init();
  }
  return nativeAppService;
};

let webAppService: AppService | null = null;
const getWebAppService = async () => {
  if (!webAppService) {
    const { WebAppService } = await import('@/services/webAppService');
    webAppService = new WebAppService();
    await webAppService.init();
  }
  return webAppService;
};

const environmentConfig: EnvConfigType = {
  getAppService: async () => {
    if (isTauriAppPlatform()) {
      return getNativeAppService();
    } else {
      return getWebAppService();
    }
  },
};

export default environmentConfig;
