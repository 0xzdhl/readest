import { redirect } from '@tanstack/react-router';
import type { AppRouter } from '@/router';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ScrollBarStyle } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauriAppPlatform } from '@/services/environment';
import { BOOK_IDS_SEPARATOR } from '@/services/constants';
import { getPlatformInfo } from '@/runtime/clientRuntime';

let readerWindowsCount = 0;

type AppNavigator = Pick<AppRouter, 'navigate'>;
const createReaderWindow = (url: string) => {
  const { isMacOSApp, osPlatform } = getPlatformInfo();
  const currentWindow = getCurrentWindow();
  const label = currentWindow.label;
  const newLabelPrefix = label === 'main' ? 'reader' : label;
  const win = new WebviewWindow(`${newLabelPrefix}-${readerWindowsCount}`, {
    url,
    width: 800,
    height: 600,
    center: true,
    resizable: true,
    title: isMacOSApp ? '' : 'Readest',
    decorations: !!isMacOSApp,
    transparent: !isMacOSApp,
    shadow: isMacOSApp ? undefined : true,
    titleBarStyle: isMacOSApp ? 'overlay' : undefined,
    scrollBarStyle: (osPlatform === 'windows'
      ? 'fluentOverlay'
      : 'default') as unknown as ScrollBarStyle,
  });
  win.once('tauri://created', () => {
    console.log('new window created');
    readerWindowsCount += 1;
  });
  win.once('tauri://error', (e) => {
    console.error('error creating window', e);
  });
  win.once('tauri://destroyed', () => {
    readerWindowsCount -= 1;
  });
};

export const showReaderWindow = (bookIds: string[]) => {
  const ids = bookIds.join(BOOK_IDS_SEPARATOR);
  const url = `/reader/${ids}`;
  createReaderWindow(url);
};

export const showLibraryWindow = (filenames: string[]) => {
  const params = new URLSearchParams();
  filenames.forEach((filename) => params.append('file', filename));
  const url = `/library?${params.toString()}`;
  createReaderWindow(url);
};

export const ensureMainLibraryWindow = async () => {
  const existing = await WebviewWindow.getByLabel('main');
  if (existing) {
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const { isMacOSApp, osPlatform } = getPlatformInfo();
  const win = new WebviewWindow('main', {
    url: '/library',
    width: 800,
    height: 600,
    center: true,
    resizable: true,
    title: isMacOSApp ? '' : 'Readest',
    decorations: !!isMacOSApp,
    transparent: !isMacOSApp,
    shadow: isMacOSApp ? undefined : true,
    titleBarStyle: isMacOSApp ? 'overlay' : undefined,
    scrollBarStyle: (osPlatform === 'windows'
      ? 'fluentOverlay'
      : 'default') as unknown as ScrollBarStyle,
  });
  win.once('tauri://error', (e) => {
    console.error('error recreating main window', e);
  });
};

export const navigateToReader = (
  router: AppNavigator,
  bookIds: string[],
  queryParams?: string,
  navOptions?: { scroll?: boolean },
) => {
  const ids = bookIds.join(BOOK_IDS_SEPARATOR);
  router.navigate({
    to: `/reader/${ids}${queryParams ? `?${queryParams}` : ''}`,
    ...navOptions,
  });
};

export const navigateToLogin = (router: AppNavigator) => {
  const pathname = window.location.pathname;
  const search = window.location.search;
  const currentPath = pathname !== '/auth' ? pathname + search : '/';
  router.navigate({ to: '/auth', search: { redirect: currentPath } });
};

export const navigateToProfile = (router: AppNavigator) => {
  router.navigate({ to: '/user', search: { section: '' } });
};

export const navigateToLibrary = (
  router: AppNavigator,
  queryParams?: string,
  navOptions?: { scroll?: boolean },
  navBack?: boolean,
) => {
  let params = queryParams;
  if (navBack) {
    const lastLibraryParams =
      typeof window !== 'undefined' ? sessionStorage.getItem('lastLibraryParams') : null;
    if (lastLibraryParams) {
      params = lastLibraryParams;
    }
  }
  router.navigate({
    to: `/library${params ? `?${params}` : ''}`,
    replace: true,
    ...navOptions,
  });
};

export const closeReaderWindowOrGoToLibrary = async (router: AppNavigator) => {
  if (isTauriAppPlatform() && getPlatformInfo().hasWindow) {
    const currentWindow = getCurrentWindow();
    if (currentWindow.label !== 'main') {
      await ensureMainLibraryWindow();
      await currentWindow.close();
      return;
    }
  }
  navigateToLibrary(router, '', undefined, true);
};

export const redirectToLibrary = () => {
  throw redirect({ to: '/library' });
};

export const navigateToResetPassword = (router: AppNavigator) => {
  const pathname = window.location.pathname;
  const search = window.location.search;
  const currentPath = pathname !== '/auth' ? pathname + search : '/';
  router.navigate({ to: '/auth/recovery', search: { redirect: currentPath } });
};

export const navigateToUpdatePassword = (router: AppNavigator) => {
  const pathname = window.location.pathname;
  const search = window.location.search;
  const currentPath = pathname !== '/auth' ? pathname + search : '/';
  router.navigate({ to: '/auth/update', search: { redirect: currentPath } });
};
