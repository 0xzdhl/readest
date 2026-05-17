import { redirect } from '@tanstack/react-router';
import type { AppRouter } from '@/router';
import { getCurrentWindow, ScrollBarStyle } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauriAppPlatform } from '@/services/environment';
import { BOOK_IDS_SEPARATOR } from '@/services/constants';
import { AppService } from '@/types/system';

let readerWindowsCount = 0;
const createReaderWindow = (appService: AppService, url: string) => {
  const currentWindow = getCurrentWindow();
  const label = currentWindow.label;
  const newLabelPrefix = label === 'main' ? 'reader' : label;
  const win = new WebviewWindow(`${newLabelPrefix}-${readerWindowsCount}`, {
    url,
    width: 800,
    height: 600,
    center: true,
    resizable: true,
    title: appService.isMacOSApp ? '' : 'Readest',
    decorations: !!appService.isMacOSApp,
    transparent: !appService.isMacOSApp,
    shadow: appService.isMacOSApp ? undefined : true,
    titleBarStyle: appService.isMacOSApp ? 'overlay' : undefined,
    scrollBarStyle: (appService.osPlatform === 'windows'
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

export const showReaderWindow = (appService: AppService, bookIds: string[]) => {
  const ids = bookIds.join(BOOK_IDS_SEPARATOR);
  const url = `/reader/${ids}`;
  createReaderWindow(appService, url);
};

export const showLibraryWindow = (appService: AppService, filenames: string[]) => {
  const params = new URLSearchParams();
  filenames.forEach((filename) => params.append('file', filename));
  const url = `/library?${params.toString()}`;
  createReaderWindow(appService, url);
};

export const ensureMainLibraryWindow = async (appService: AppService) => {
  const existing = await WebviewWindow.getByLabel('main');
  if (existing) {
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const win = new WebviewWindow('main', {
    url: '/library',
    width: 800,
    height: 600,
    center: true,
    resizable: true,
    title: appService.isMacOSApp ? '' : 'Readest',
    decorations: !!appService.isMacOSApp,
    transparent: !appService.isMacOSApp,
    shadow: appService.isMacOSApp ? undefined : true,
    titleBarStyle: appService.isMacOSApp ? 'overlay' : undefined,
    scrollBarStyle: (appService.osPlatform === 'windows'
      ? 'fluentOverlay'
      : 'default') as unknown as ScrollBarStyle,
  });
  win.once('tauri://error', (e) => {
    console.error('error recreating main window', e);
  });
};

export const navigateToReader = (
  router: AppRouter,
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

export const navigateToLogin = (router: AppRouter) => {
  const pathname = window.location.pathname;
  const search = window.location.search;
  const currentPath = pathname !== '/auth' ? pathname + search : '/';
  router.navigate({ to: '/auth', search: { redirect: currentPath } });
};

export const navigateToProfile = (router: AppRouter) => {
  router.navigate({ to: '/user', search: { section: '' } });
};

export const navigateToLibrary = (
  router: AppRouter,
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

export const closeReaderWindowOrGoToLibrary = async (
  appService: AppService | null,
  router: AppRouter,
) => {
  if (isTauriAppPlatform() && appService?.hasWindow) {
    const currentWindow = getCurrentWindow();
    if (currentWindow.label !== 'main') {
      await ensureMainLibraryWindow(appService);
      await currentWindow.close();
      return;
    }
  }
  navigateToLibrary(router, '', undefined, true);
};

export const redirectToLibrary = () => {
  throw redirect({ to: '/library' });
};

export const navigateToResetPassword = (router: AppRouter) => {
  const pathname = window.location.pathname;
  const search = window.location.search;
  const currentPath = pathname !== '/auth' ? pathname + search : '/';
  router.navigate({ to: '/auth/recovery', search: { redirect: currentPath } });
};

export const navigateToUpdatePassword = (router: AppRouter) => {
  const pathname = window.location.pathname;
  const search = window.location.search;
  const currentPath = pathname !== '/auth' ? pathname + search : '/';
  router.navigate({ to: '/auth/update', search: { redirect: currentPath } });
};
