import { clientEnv } from '@/clientEnv';

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
// Strip a trailing slash so derived paths don't double up (e.g. an operator
// setting VITE_DOWNLOAD_BASE_URL with a trailing "/").
const noTrailingSlash = (url: string) => url.replace(/\/+$/, '');
export const getShareBaseUrl = () => `${noTrailingSlash(getBaseUrl())}/s`;
export const getUpdaterFileUrl = () => `${noTrailingSlash(getDownloadBaseUrl())}/latest.json`;
export const getChangelogFileUrl = () =>
  `${noTrailingSlash(getDownloadBaseUrl())}/release-notes.json`;

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

// EnvConfigType is now empty — the legacy app-service accessor is gone (E5b-2,
// god-objects deleted). The ~513 vestigial `envConfig` threading sites still
// compile against this empty shape; their removal is the optional E5b-3 cleanup.
export type EnvConfigType = Record<string, never>;

const environmentConfig: EnvConfigType = {};

export default environmentConfig;
